import fs from "node:fs";
import { performance } from "node:perf_hooks";

import { loadReplay } from "../src/replay/codec.js";
import { FIREBALL_CONFIG, ARROWS_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createArena, ROYALE_TOWER_X, ROYALE_TOWER_Y, createRoyaleArena } from "../src/sim/map.js";
import { getTowerStats } from "../src/sim/stats.js";
import { getCard } from "../src/sim/cards.js";
import {
  EDGER_BOT_ID,
  HEURISTIC_BOT_ID,
  INTERNAL_BASELINE_BOTS,
  enumerateLegalCardActions,
  selectEdgerAction,
  selectHeuristicAction,
} from "../src/ai/botRuntime.js";
import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import { runBotMatch, runEdgerBenchmarkSuite } from "../src/ai/benchmark.js";

export const PROMOTION_GATE_CONFIG = Object.freeze({
  seed: 20260630,
  roundsPerOpponent: 30,
  maxTicks: 6040,
  heuristicMinWinRate: 0.55,
  heuristicWilsonLowerBound: 0.5,
  baselineMinWinRate: 0.6,
  timingP95BudgetMs: 5,
  scenarioCategoryMinimums: Object.freeze({
    defense: 0.7,
    spell_value: 0.7,
    tower_finishing: 0.8,
    elixir_punishment: 0.55,
    pocket_pressure: 0.55,
  }),
});

function passGate(details = {}) {
  return { passed: true, ...details };
}

function failGate(reason, details = {}) {
  return { passed: false, reason, ...details };
}

export function wilsonLowerBound(wins, resolved, z = 1.96) {
  if (resolved <= 0) {
    return 0;
  }
  const phat = wins / resolved;
  const denom = 1 + (z * z) / resolved;
  const center = phat + (z * z) / (2 * resolved);
  const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * resolved)) / resolved);
  return (center - spread) / denom;
}

function makeCardState(redHand, blueHand = ["giant", "knight", "archers", "arrows"]) {
  return {
    blue: {
      hand: blueHand,
      draw_pile: ["musketeer", "mini_pekka", "goblins", "fireball"],
    },
    red: {
      hand: redHand,
      draw_pile: ["musketeer", "mini_pekka", "goblins", "archers"],
    },
  };
}

function makeBasicEngine({ redHand, blueHand, initialEntities, blueElixir = 5, redElixir = 10, seed = 6101 }) {
  const engine = createEngine({
    seed,
    arena: createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities,
    initialCardState: makeCardState(redHand, blueHand),
  });
  engine.state.elixir.blue.elixir = blueElixir;
  engine.state.elixir.red.elixir = redElixir;
  return engine;
}

function makeRoyaleEngine({ redHand, blueHand, blueLeftHp, blueRightHp, extraEntities = [], blueElixir = 5, redElixir = 10, seed = 6201 }) {
  const crownHp = getTowerStats("crown").hp;
  const engine = createEngine({
    seed,
    arena: createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_left", team: "blue", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.blue.crown, hp: blueLeftHp ?? crownHp, tower_role: "crown" }),
      createTower({ id: "blue_right", team: "blue", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.blue.crown, hp: blueRightHp ?? crownHp, tower_role: "crown" }),
      createTower({ id: "blue_king", team: "blue", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.blue.king, tower_role: "king", is_active: false }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, tower_role: "king", is_active: false }),
      ...extraEntities,
    ],
    initialCardState: makeCardState(redHand, blueHand),
  });
  engine.state.elixir.blue.elixir = blueElixir;
  engine.state.elixir.red.elixir = redElixir;
  return engine;
}

function getEnemiesHit(engine, action, radius) {
  if (!action || action.type !== "PLAY_CARD") {
    return [];
  }
  return engine.state.entities.filter((entity) => {
    if (entity.team !== "blue" || entity.hp <= 0) {
      return false;
    }
    return Math.hypot(entity.x - action.x, entity.y - action.y) <= radius + (entity.radius ?? 0) + 1e-9;
  });
}

function scoreDefense(engine, action) {
  if (!action || action.type !== "PLAY_CARD") {
    return 0;
  }
  const card = getCard(action.cardId);
  if (card?.type !== "troop" || action.y > 16) {
    return 0;
  }
  const laneScore = Math.max(0, 1 - Math.abs(action.x - 9) / 5);
  const counter = action.cardId === "mini_pekka" ? 0.45 : action.cardId === "musketeer" ? 0.25 : 0.05;
  return Math.min(1.25, 0.45 + laneScore * 0.45 + counter);
}

function scoreSpellValue(engine, action) {
  if (!action || action.type !== "PLAY_CARD" || !["fireball", "arrows"].includes(action.cardId)) {
    return 0;
  }
  const config = action.cardId === "fireball" ? FIREBALL_CONFIG : ARROWS_CONFIG;
  const hits = getEnemiesHit(engine, action, config.radius_tiles);
  const troopHits = hits.filter((entity) => entity.entity_type === "troop").length;
  const towerHits = hits.filter((entity) => entity.entity_type === "tower").length;
  return Math.min(1.25, troopHits * 0.32 + towerHits * 0.18);
}

function scoreTowerFinishing(engine, action) {
  if (!action || action.type !== "PLAY_CARD" || !["fireball", "arrows"].includes(action.cardId)) {
    return 0;
  }
  const config = action.cardId === "fireball" ? FIREBALL_CONFIG : ARROWS_CONFIG;
  const lethalTower = getEnemiesHit(engine, action, config.radius_tiles).some(
    (entity) => entity.entity_type === "tower" && entity.hp <= config.tower_damage,
  );
  return lethalTower ? 1.15 : scoreSpellValue(engine, action) * 0.45;
}

function scoreElixirPunishment(engine, action) {
  if (!action || action.type !== "PLAY_CARD") {
    return 0;
  }
  const card = getCard(action.cardId);
  if (card?.type !== "troop") {
    return 0.15;
  }
  const bridgePressure = Math.max(0, 1 - Math.abs(action.y - 14.5) / 6);
  const threatCard = action.cardId === "giant" ? 0.35 : action.cardId === "mini_pekka" ? 0.25 : 0.1;
  return Math.min(1.2, 0.35 + bridgePressure * 0.45 + threatCard);
}

function scorePocketPressure(engine, action) {
  if (!action || action.type !== "PLAY_CARD") {
    return 0;
  }
  const card = getCard(action.cardId);
  if (card?.type !== "troop") {
    return 0;
  }
  const inPocket = action.y >= 17.5 && action.y <= 22 && action.x <= 8.5;
  return inPocket ? 1.15 : Math.max(0, 0.6 - Math.abs(action.x - ROYALE_TOWER_X.left) / 10);
}

const SCENARIO_FIXTURES = Object.freeze([
  {
    id: "defense_giant_lane",
    category: "defense",
    makeEngine: () => makeBasicEngine({
      redHand: ["mini_pekka", "musketeer", "knight", "fireball"],
      initialEntities: [
        createTower({ id: "blue_tower", team: "blue", x: 9, y: 29 }),
        createTower({ id: "red_tower", team: "red", x: 9, y: 3 }),
        createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 9, y: 13.5, hp: 2800 }),
      ],
      blueElixir: 4,
      seed: 6301,
    }),
    score: scoreDefense,
  },
  {
    id: "spell_cluster_value",
    category: "spell_value",
    makeEngine: () => makeBasicEngine({
      redHand: ["arrows", "fireball", "knight", "giant"],
      initialEntities: [
        createTower({ id: "blue_tower", team: "blue", x: 9, y: 29 }),
        createTower({ id: "red_tower", team: "red", x: 9, y: 3 }),
        createTroop({ id: "blue_goblins", cardId: "goblins", team: "blue", x: 8.7, y: 12, hp: 220 }),
        createTroop({ id: "blue_archers", cardId: "archers", team: "blue", x: 9.4, y: 12.3, hp: 300 }),
      ],
      blueElixir: 6,
      seed: 6302,
    }),
    score: scoreSpellValue,
  },
  {
    id: "finish_low_tower",
    category: "tower_finishing",
    makeEngine: () => makeRoyaleEngine({
      redHand: ["fireball", "arrows", "knight", "giant"],
      blueLeftHp: FIREBALL_CONFIG.tower_damage - 20,
      blueElixir: 3,
      seed: 6303,
    }),
    score: scoreTowerFinishing,
  },
  {
    id: "punish_low_elixir",
    category: "elixir_punishment",
    makeEngine: () => makeRoyaleEngine({
      redHand: ["giant", "mini_pekka", "knight", "musketeer"],
      blueElixir: 1,
      redElixir: 10,
      seed: 6304,
    }),
    score: scoreElixirPunishment,
  },
  {
    id: "captured_left_pocket",
    category: "pocket_pressure",
    makeEngine: () => makeRoyaleEngine({
      redHand: ["giant", "knight", "goblins", "musketeer"],
      blueLeftHp: 0,
      blueElixir: 2,
      redElixir: 10,
      seed: 6305,
    }),
    score: scorePocketPressure,
  },
]);

function selectScenarioAction(engine, model, selector) {
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  if (selector === "heuristic") {
    return selectHeuristicAction({ legalActions, engine, actor: "red" });
  }
  return selectEdgerAction({ legalActions, engine, actor: "red", model });
}

export function evaluateScenarioLeague(model, { minimums = PROMOTION_GATE_CONFIG.scenarioCategoryMinimums } = {}) {
  const scenarios = SCENARIO_FIXTURES.map((fixture) => {
    const candidateEngine = fixture.makeEngine();
    const heuristicEngine = fixture.makeEngine();
    const candidateAction = selectScenarioAction(candidateEngine, model, "candidate");
    const heuristicAction = selectScenarioAction(heuristicEngine, model, "heuristic");
    const candidateScore = fixture.score(candidateEngine, candidateAction);
    const heuristicScore = fixture.score(heuristicEngine, heuristicAction);
    return {
      id: fixture.id,
      category: fixture.category,
      candidate_action: candidateAction,
      heuristic_action: heuristicAction,
      candidate_score: Number(candidateScore.toFixed(4)),
      heuristic_score: Number(heuristicScore.toFixed(4)),
      passed_minimum: candidateScore >= (minimums[fixture.category] ?? 0),
    };
  });

  const categories = {};
  for (const scenario of scenarios) {
    const current = categories[scenario.category] ?? {
      candidate_score: 0,
      heuristic_score: 0,
      count: 0,
      minimum: minimums[scenario.category] ?? 0,
    };
    current.candidate_score += scenario.candidate_score;
    current.heuristic_score += scenario.heuristic_score;
    current.count += 1;
    categories[scenario.category] = current;
  }

  for (const category of Object.values(categories)) {
    category.candidate_score = Number((category.candidate_score / category.count).toFixed(4));
    category.heuristic_score = Number((category.heuristic_score / category.count).toFixed(4));
    category.passed = category.candidate_score >= category.minimum;
  }

  const candidateAggregate = scenarios.reduce((sum, scenario) => sum + scenario.candidate_score, 0) / scenarios.length;
  const heuristicAggregate = scenarios.reduce((sum, scenario) => sum + scenario.heuristic_score, 0) / scenarios.length;
  const passedMinimums = Object.values(categories).every((category) => category.passed);
  const improved = candidateAggregate > heuristicAggregate;

  return {
    passed: passedMinimums && improved,
    candidate_aggregate: Number(candidateAggregate.toFixed(4)),
    heuristic_aggregate: Number(heuristicAggregate.toFixed(4)),
    improved_over_heuristic: improved,
    categories,
    scenarios,
  };
}

function makeDeterminismEngine() {
  const crownHp = getTowerStats("crown").hp;
  const engine = createEngine({
    seed: 606,
    arena: createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
      createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 9, y: 22, hp: 2800 }),
    ],
    initialCardState: makeCardState(
      ["giant", "knight", "arrows", "fireball"],
      ["giant", "knight", "archers", "arrows"],
    ),
  });
  engine.state.elixir.red.elixir = 10;
  engine.state.elixir.blue.elixir = 10;
  return engine;
}

function runCandidatePolicyTicks(model, totalTicks = 120) {
  const engine = makeDeterminismEngine();
  const selectedActions = [];

  for (let i = 0; i < totalTicks && !engine.getMatchResult(); i += 1) {
    const tick = engine.state.tick + 1;
    const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
    const selected = selectEdgerAction({
      model,
      engine,
      actor: "red",
      legalActions,
    });
    const actions = [];
    if (selected.type === "PLAY_CARD") {
      const action = {
        tick,
        type: "PLAY_CARD",
        actor: "red",
        cardId: selected.cardId,
        x: selected.x,
        y: selected.y,
      };
      actions.push(action);
      selectedActions.push(action);
    }
    engine.step(actions);
  }

  return {
    actions: selectedActions,
    hash: engine.getStateHash(),
    replay: engine.exportReplay(),
    events: engine.state.replay.events,
    tick: engine.state.tick,
  };
}

function evaluateDeterminism(model) {
  const first = runCandidatePolicyTicks(model);
  const second = runCandidatePolicyTicks(model);
  const passed = first.actions.length > 0 &&
    JSON.stringify(first.actions) === JSON.stringify(second.actions) &&
    first.hash === second.hash;
  return passed
    ? passGate({ action_count: first.actions.length, hash: first.hash })
    : failGate("candidate did not reproduce same-seed action stream", {
        first_action_count: first.actions.length,
        second_action_count: second.actions.length,
      });
}

function evaluateReplayRoundTrip(model) {
  const original = runCandidatePolicyTicks(model);
  const replay = loadReplay(original.replay);
  const replayed = makeDeterminismEngine();
  replayed.run(replay.actions, original.tick);
  const passed = replayed.getStateHash() === original.hash &&
    JSON.stringify(replayed.state.replay.events) === JSON.stringify(replay.events);
  return passed
    ? passGate({ hash: original.hash, action_count: replay.actions.length, event_count: replay.events.length })
    : failGate("replay round-trip did not preserve hash/events", {
        original_hash: original.hash,
        replayed_hash: replayed.getStateHash(),
      });
}

function evaluateBenchmarkGate(model, {
  seed = PROMOTION_GATE_CONFIG.seed,
  roundsPerOpponent = PROMOTION_GATE_CONFIG.roundsPerOpponent,
  maxTicks = PROMOTION_GATE_CONFIG.maxTicks,
} = {}) {
  const suite = runEdgerBenchmarkSuite({
    opponents: [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS],
    seed,
    roundsPerOpponent,
    maxTicks,
    edgerModel: model,
  });
  const pairs = suite.pairs.map((pair) => ({
    ...pair,
    wilson_lower_bound: Number(wilsonLowerBound(pair.wins, pair.resolved).toFixed(4)),
  }));
  const failures = [];
  for (const pair of pairs) {
    if (pair.resolved <= 0) {
      failures.push(`${pair.opponent}: no resolved games`);
      continue;
    }
    if (pair.opponent === HEURISTIC_BOT_ID) {
      if (pair.win_rate < PROMOTION_GATE_CONFIG.heuristicMinWinRate) {
        failures.push(`${pair.opponent}: win_rate ${pair.win_rate.toFixed(3)} < ${PROMOTION_GATE_CONFIG.heuristicMinWinRate}`);
      }
      if (pair.wilson_lower_bound <= PROMOTION_GATE_CONFIG.heuristicWilsonLowerBound) {
        failures.push(`${pair.opponent}: wilson ${pair.wilson_lower_bound.toFixed(3)} <= ${PROMOTION_GATE_CONFIG.heuristicWilsonLowerBound}`);
      }
      continue;
    }
    if (pair.win_rate < PROMOTION_GATE_CONFIG.baselineMinWinRate) {
      failures.push(`${pair.opponent}: win_rate ${pair.win_rate.toFixed(3)} < ${PROMOTION_GATE_CONFIG.baselineMinWinRate}`);
    }
  }

  return failures.length === 0
    ? passGate({ seed, rounds_per_opponent: roundsPerOpponent, max_ticks: maxTicks, pairs })
    : failGate("benchmark gate failed", { seed, rounds_per_opponent: roundsPerOpponent, max_ticks: maxTicks, pairs, failures });
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function evaluateTiming(model, { samples = 25, budgetMs = PROMOTION_GATE_CONFIG.timingP95BudgetMs } = {}) {
  const fixtures = SCENARIO_FIXTURES.map((fixture) => {
    const engine = fixture.makeEngine();
    return {
      engine,
      legalActions: enumerateLegalCardActions({ engine, actor: "red" }),
    };
  });
  const durations = [];

  for (let i = 0; i < samples; i += 1) {
    const fixture = fixtures[i % fixtures.length];
    const started = performance.now();
    selectEdgerAction({
      model,
      engine: fixture.engine,
      actor: "red",
      legalActions: fixture.legalActions,
    });
    durations.push(performance.now() - started);
  }

  const p95 = percentile(durations, 0.95);
  return {
    passed: p95 <= budgetMs,
    samples,
    budget_ms: budgetMs,
    p95_ms: Number(p95.toFixed(4)),
    max_ms: Number(Math.max(...durations).toFixed(4)),
  };
}

function evaluateBrowserUiExposure() {
  const checkedFiles = ["index.html", "src/client/webGame.js", "src/client/layout.js"];
  const forbidden = [
    /\btraining\b/i,
    /\btrain\b/i,
    /\bunlock/i,
    /\bbot\s+level/i,
    /\bmodel\s+selector/i,
    /\bselector\b/i,
  ];
  const hits = [];
  for (const file of checkedFiles) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    forbidden.forEach((pattern) => {
      if (pattern.test(text)) {
        hits.push({ file, pattern: String(pattern) });
      }
    });
  }
  return hits.length === 0
    ? passGate({ checked_files: checkedFiles })
    : failGate("browser UI exposes removed training/level/selector language", { hits, checked_files: checkedFiles });
}

export function collectPromotionFailures(report) {
  const failures = [];
  for (const [gateName, gate] of Object.entries(report.gates ?? {})) {
    if (!gate?.passed) {
      failures.push(`${gateName}: ${gate?.reason ?? "failed"}`);
    }
  }
  if (report.scenarios && !report.scenarios.passed) {
    failures.push("scenario_league: candidate did not beat heuristic aggregate and category minimums");
  }
  return failures;
}

export function checkPromotionReport(report) {
  const failures = collectPromotionFailures(report);
  return {
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateCandidateModel(model, {
  modelPath = null,
  seed = PROMOTION_GATE_CONFIG.seed,
  roundsPerOpponent = PROMOTION_GATE_CONFIG.roundsPerOpponent,
  maxTicks = PROMOTION_GATE_CONFIG.maxTicks,
  timingBudgetMs = PROMOTION_GATE_CONFIG.timingP95BudgetMs,
} = {}) {
  const schemaGate = (() => {
    try {
      validateEdgerPolicyModel(model);
      return passGate();
    } catch (error) {
      return failGate(error.message);
    }
  })();
  const determinism = schemaGate.passed ? evaluateDeterminism(model) : failGate("schema failed");
  const replay = schemaGate.passed ? evaluateReplayRoundTrip(model) : failGate("schema failed");
  const benchmark = schemaGate.passed
    ? evaluateBenchmarkGate(model, { seed, roundsPerOpponent, maxTicks })
    : failGate("schema failed");
  const scenarios = schemaGate.passed ? evaluateScenarioLeague(model) : { passed: false, scenarios: [], categories: {} };
  const timing = schemaGate.passed
    ? evaluateTiming(model, { budgetMs: timingBudgetMs })
    : failGate("schema failed");
  const browserUi = evaluateBrowserUiExposure();
  const report = {
    model_id: model?.model_id ?? null,
    model: modelPath,
    evaluated_at: new Date().toISOString(),
    seed,
    rounds_per_opponent: roundsPerOpponent,
    max_ticks: maxTicks,
    gates: {
      schema: schemaGate,
      determinism,
      replay,
      benchmark,
      scenario_league: scenarios.passed
        ? passGate({
            candidate_aggregate: scenarios.candidate_aggregate,
            heuristic_aggregate: scenarios.heuristic_aggregate,
          })
        : failGate("candidate did not beat heuristic aggregate and category minimums", {
            candidate_aggregate: scenarios.candidate_aggregate,
            heuristic_aggregate: scenarios.heuristic_aggregate,
          }),
      timing: timing.passed ? passGate(timing) : failGate("runtime scoring p95 exceeded budget", timing),
      browser_ui_exposure: browserUi,
    },
    benchmark: benchmark.pairs ? { pairs: benchmark.pairs } : null,
    scenarios,
    timing,
  };
  report.promotion = checkPromotionReport(report);
  return report;
}

export function summarizeBenchmarkForConsole(report) {
  const lines = [];
  lines.push(`model=${report.model_id}`);
  lines.push(`seed=${report.seed} rounds_per_opponent=${report.rounds_per_opponent} max_ticks=${report.max_ticks}`);
  lines.push("opponent         | win_rate | wilson_lb | wins-losses | draws | resolved");
  lines.push("---------------- | -------- | --------- | ----------- | ----- | --------");
  for (const pair of report.benchmark?.pairs ?? []) {
    const wins = `${pair.wins}-${pair.losses}`;
    lines.push(
      `${pair.opponent.padEnd(16)} | ${pair.win_rate.toFixed(3).padEnd(8)} | ${pair.wilson_lower_bound.toFixed(3).padEnd(9)} | ${wins.padEnd(11)} | ${String(pair.draws).padEnd(5)} | ${String(pair.resolved).padEnd(8)}`,
    );
  }
  lines.push(`deterministic_same_seed=${report.gates.determinism.passed ? "yes" : "no"}`);
  lines.push(`replay_round_trip=${report.gates.replay.passed ? "yes" : "no"}`);
  lines.push(`scenario_league=${report.gates.scenario_league.passed ? "yes" : "no"}`);
  lines.push(`timing_p95_ms=${report.timing.p95_ms} budget_ms=${report.timing.budget_ms}`);
  lines.push(`promotion_passed=${report.promotion.passed ? "yes" : "no"}`);
  if (!report.promotion.passed) {
    for (const failure of report.promotion.failures) {
      lines.push(`promotion_gate_failed: ${failure}`);
    }
  }
  return lines.join("\n");
}
