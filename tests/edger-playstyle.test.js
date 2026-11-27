import assert from "node:assert/strict";
import test from "node:test";

import { createEdgerV2BootstrapModel, validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { getMatchPhase } from "../src/sim/config.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { createRng } from "../src/sim/random.js";
import { CARD_STATS } from "../src/sim/stats.js";
import {
  EDGER_V2_PLAYSTYLE_DIAGNOSTICS_SCHEMA,
  PLAYSTYLE_CHECKPOINT_TERMS,
  createPlaystyleTracker,
  emptyPlaystyleStats,
  finishPlaystyle,
  playstyleAfterStep,
  playstyleBeforeStep,
} from "../scripts/edger-playstyle-core.mjs";
import {
  EDGER_REWARD_V2_COUNTERS,
  EDGER_REWARD_VERSIONS,
  counterCredit,
  potentialForActor,
} from "../scripts/edger-reward-core.mjs";
import { EDGER_V2_CADENCES, runEdgerV2CadenceMatch } from "../scripts/edger-v2-cadence-core.mjs";
import { summarizePlaystyleDiagnostics } from "../scripts/edger-v2-cadence-experiment.mjs";

const WINDOW = 100;

function randomModel(seed, { scale = 0.35, passBias = 0 } = {}) {
  const model = createEdgerV2BootstrapModel({ modelId: `playstyle-test-${seed}` });
  const rng = createRng(seed);
  const fill = (values) => {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (rng() * 2 - 1) * scale;
    }
  };
  for (const layer of Object.values(model.weights)) {
    if (Array.isArray(layer)) {
      fill(layer);
    } else {
      fill(layer.weights);
      fill(layer.bias);
    }
  }
  // A PASS bias makes the candidate wait, so it reaches the elixir cap.
  model.weights.card_head.bias[0] += passBias;
  return validateEdgerV2PolicyModel(model);
}

function classify(threatCardId, cardId) {
  const counters = EDGER_REWARD_V2_COUNTERS[threatCardId];
  if (counters.strong.includes(cardId)) {
    return "strong";
  }
  return counters.partial.includes(cardId) ? "partial" : "other";
}

function affordable(context, cardIds) {
  return cardIds.some((cardId) => context.hand.includes(cardId) && context.elixir >= CARD_STATS[cardId].cost);
}

// An independent recount of the definitions in edger-playstyle-core.mjs: it
// replays the match's actions on a fresh engine for the state-dependent parts
// and classifies responses offline from the replay events.
function recount(match) {
  const candidate = match.candidate_actor;
  const opponent = candidate === "blue" ? "red" : "blue";
  const events = match.replay.events.filter((event) => event.type === "card_played");
  const isThreat = (event) => event.actor === opponent && EDGER_REWARD_V2_COUNTERS[event.card_id];
  const threats = events.filter(isThreat);
  const plays = events.filter((event) => event.actor === candidate);
  const giantTicks = new Set(plays.filter((event) => event.card_id === "giant").map((event) => event.tick));
  const threatTicks = new Set(threats.map((event) => event.tick));
  const actionsByTick = new Map();
  for (const action of match.replay.actions) {
    actionsByTick.set(action.tick, [...(actionsByTick.get(action.tick) ?? []), action]);
  }

  const engine = createProductionEngine({ seed: match.seed });
  const capped = { normal: 0, double: 0, overtime: 0 };
  const giantContexts = [];
  const handAfter = new Map();
  const checkpoints = { "60s": null, "120s": null };
  while (!engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    if (engine.state.elixir[candidate].elixir >= 10) {
      capped[getMatchPhase({ tick, isOvertime: engine.state.isOvertime })] += 1;
    }
    if (giantTicks.has(tick)) {
      giantContexts.push({
        hand: engine.getHand(opponent),
        nextInQueue: engine.getDeckQueue(opponent)[0] ?? null,
        elixir: engine.state.elixir[opponent].elixir,
      });
    }
    engine.step(actionsByTick.get(tick) ?? []);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
    if (threatTicks.has(tick)) {
      handAfter.set(tick, engine.getHand(candidate));
    }
    const label = { 1200: "60s", 2400: "120s" }[tick];
    if (label && !engine.getMatchResult()) {
      const parts = potentialForActor(engine, candidate, EDGER_REWARD_VERSIONS.V2);
      checkpoints[label] = Object.fromEntries(PLAYSTYLE_CHECKPOINT_TERMS.map((key) => [key, parts[key]]));
    }
  }
  assert.equal(engine.getStateHash(), match.final_state_hash, "the replay reproduces the match");

  const expected = emptyPlaystyleStats();
  expected.capped_ticks = capped;
  expected.wasted_elixir = 0 + capped.normal / 56 + capped.double / 28 + capped.overtime / 20;
  expected.checkpoints = checkpoints;
  const counts = expected.counter_responses;
  const add = (bucket, best) => {
    bucket.threats += 1;
    bucket[best] += 1;
  };
  for (const threat of threats) {
    if (threat.tick + WINDOW > match.tick) {
      counts.censored += 1;
      continue;
    }
    const classes = plays
      .filter((play) => play.tick > threat.tick && play.tick <= threat.tick + WINDOW)
      .map((play) => ({ tick: play.tick, kind: classify(threat.card_id, play.card_id) }));
    const best = ["strong", "partial", "other"].find((kind) => classes.some((item) => item.kind === kind)) ?? "none";
    add(counts, best);
    if (EDGER_REWARD_V2_COUNTERS[threat.card_id].strong.some((cardId) => handAfter.get(threat.tick).includes(cardId))) {
      add(counts.strong_counter_in_hand, best);
    }
    counts.by_threat_card[threat.card_id] ??= { threats: 0, strong: 0, partial: 0, other: 0, none: 0 };
    add(counts.by_threat_card[threat.card_id], best);
    const firstCounter = classes.find((item) => item.kind !== "other");
    if (firstCounter) {
      counts.counter_delay_ticks_sum += firstCounter.tick - threat.tick;
    }
  }
  const giant = expected.giant_plays;
  for (const context of giantContexts) {
    const strong = affordable(context, EDGER_REWARD_V2_COUNTERS.giant.strong);
    giant.plays += 1;
    giant.into_affordable_strong_answer += strong ? 1 : 0;
    giant.into_affordable_answer += strong || affordable(context, EDGER_REWARD_V2_COUNTERS.giant.partial) ? 1 : 0;
    giant.opponent_counter_credit_sum += counterCredit(context, "giant");
  }
  return expected;
}

test("match playstyle diagnostics equal an independent recount from the replay", () => {
  const coverage = { strong: 0, partial: 0, other: 0, none: 0, censored: 0, giant: 0, affordable: 0, unaffordable: 0, capped: 0, at60: 0, at120: 0 };
  const games = [
    [20261111, "blue", "edger_heuristic", 31],
    [20261112, "red", "aggressive", 32],
    [20261113, "blue", "defender", 33],
    [20261114, "red", "random", 34, 4],
  ];
  for (const [seed, candidateActor, opponentBotId, modelSeed, passBias = 0] of games) {
    const match = runEdgerV2CadenceMatch({
      seed,
      candidateActor,
      model: randomModel(modelSeed, { passBias }),
      cadence: EDGER_V2_CADENCES.LEARNED,
      opponentBotId,
      mode: "sample",
      returnReplay: true,
    });
    const stats = match.stats.playstyle_diagnostics;
    assert.deepEqual(stats, recount(match), `seed ${seed}`);
    assert.equal(
      stats.capped_ticks.normal + stats.capped_ticks.double + stats.capped_ticks.overtime,
      match.stats.full_elixir_ticks,
      "capped ticks are the full-elixir ticks",
    );
    for (const kind of ["strong", "partial", "other", "none", "censored"]) {
      coverage[kind] += stats.counter_responses[kind];
    }
    coverage.giant += stats.giant_plays.plays;
    coverage.affordable += stats.giant_plays.into_affordable_strong_answer;
    coverage.unaffordable += stats.giant_plays.plays - stats.giant_plays.into_affordable_answer;
    coverage.capped += match.stats.full_elixir_ticks;
    coverage.at60 += stats.checkpoints["60s"] ? 1 : 0;
    coverage.at120 += stats.checkpoints["120s"] ? 1 : 0;
  }
  for (const [key, value] of Object.entries(coverage)) {
    assert.ok(value > 0, `fixture must cover ${key}`);
  }
});

// A scripted stand-in for the engine: only the fields the tracker reads.
function scriptedEngine() {
  const state = {
    tick: 0,
    isOvertime: false,
    elixir: { blue: { elixir: 5, max: 10 }, red: { elixir: 5, max: 10 } },
    replay: { events: [] },
  };
  const engine = {
    state,
    hands: { blue: ["knight", "archers", "arrows", "fireball"], red: ["goblins", "knight", "arrows", "fireball"] },
    queues: { blue: ["giant"], red: ["mini_pekka"] },
    result: null,
    getHand: (actor) => [...engine.hands[actor]],
    getDeckQueue: (actor) => [...engine.queues[actor]],
    getMatchResult: () => engine.result,
  };
  return engine;
}

function runScript(engine, tracker, ticks, script) {
  for (const tick of ticks) {
    const entries = script[tick] ?? [];
    const actions = entries
      .filter((entry) => entry.actor)
      .map((entry) => ({ tick, type: "PLAY_CARD", actor: entry.actor, cardId: entry.card, x: 0, y: 0 }));
    engine.state.tick = tick - 1;
    for (const entry of entries.filter((item) => item.before)) {
      entry.before(engine);
    }
    playstyleBeforeStep(tracker, engine, actions);
    engine.state.tick = tick;
    for (const action of actions) {
      engine.state.replay.events.push({ type: "card_played", tick, actor: action.actor, card_id: action.cardId });
    }
    engine.state.replay.events.push({ type: "effect_scheduled", tick });
    playstyleAfterStep(tracker, engine);
  }
}

test("the tracker applies the response window, censoring and Giant answers exactly", () => {
  const engine = scriptedEngine();
  const tracker = createPlaystyleTracker("blue");
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const capAt = (value) => ({ before: (target) => { target.state.elixir.blue.elixir = value; } });
  const blueHand = (...hand) => ({ before: (target) => { target.hands.blue = hand; } });
  runScript(engine, tracker, range(1, 999), {
    // Blue sits at the cap for ticks 2 and 3 (normal time).
    2: [capAt(10)],
    4: [capAt(9)],
    // Red's Giant, with Mini PEKKA (strong) in blue's hand: blue's Knight at
    // the same tick is not a response; a later Knight (partial) sets the
    // delay, and a later Mini PEKKA upgrades the response to strong.
    10: [blueHand("mini_pekka", "knight", "archers", "fireball"), { actor: "red", card: "giant" }, { actor: "blue", card: "knight" }],
    50: [{ actor: "blue", card: "knight" }],
    80: [{ actor: "blue", card: "mini_pekka" }],
    // Red's Archers, with Arrows (strong) in blue's hand, get no response
    // within 100 ticks: blue's Arrows at 221 are one tick late.
    120: [blueHand("mini_pekka", "knight", "arrows", "fireball"), { actor: "red", card: "archers" }],
    221: [{ actor: "blue", card: "arrows" }],
    // Red's Goblins, with no strong counter in blue's hand: Fireball at
    // exactly 100 ticks counts, as "other".
    300: [blueHand("mini_pekka", "knight", "archers", "fireball"), { actor: "red", card: "goblins" }],
    400: [{ actor: "blue", card: "fireball" }],
    // Spells are not threats.
    450: [{ actor: "red", card: "arrows" }],
    // Blue's Giants: red has Goblins (strong) but 1 elixir; then 3 elixir with
    // Knight only (partial); then Goblins and 2 elixir (affordable strong).
    500: [
      { before: (target) => { target.state.elixir.red.elixir = 1; } },
      { actor: "blue", card: "giant" },
    ],
    600: [
      { before: (target) => { target.state.elixir.red.elixir = 3; target.hands.red = ["knight", "archers", "arrows", "fireball"]; } },
      { actor: "blue", card: "giant" },
    ],
    700: [
      { before: (target) => { target.state.elixir.red.elixir = 2; target.hands.red = ["goblins", "knight", "arrows", "fireball"]; } },
      { actor: "blue", card: "giant" },
    ],
  });
  // Double elixir (tick >= 2400, past the checkpoints), then overtime, where
  // red's Knight one tick before the end is censored.
  runScript(engine, tracker, [2501, 2502], { 2501: [capAt(10)] });
  engine.state.isOvertime = true;
  runScript(engine, tracker, [3801, 3802, 3803], { 3802: [{ actor: "red", card: "knight" }] });
  engine.result = { tick: 3803 };
  const stats = finishPlaystyle(tracker);

  assert.deepEqual(stats.capped_ticks, { normal: 2, double: 2, overtime: 3 });
  assert.equal(stats.wasted_elixir, 2 / 56 + 2 / 28 + 3 / 20);
  const counts = stats.counter_responses;
  assert.deepEqual(
    [counts.threats, counts.strong, counts.partial, counts.other, counts.none, counts.censored],
    [3, 1, 0, 1, 1, 1],
  );
  assert.equal(counts.counter_delay_ticks_sum, 40, "delay to the first counter, the Knight");
  assert.deepEqual(counts.strong_counter_in_hand, { threats: 2, strong: 1, partial: 0, other: 0, none: 1 },
    "the Giant and the Archers, not the Goblins");
  assert.deepEqual(Object.keys(counts.by_threat_card), ["archers", "giant", "goblins"]);
  assert.deepEqual(counts.by_threat_card.giant, { threats: 1, strong: 1, partial: 0, other: 0, none: 0 });
  assert.deepEqual(stats.giant_plays, {
    plays: 3,
    into_affordable_strong_answer: 1,
    into_affordable_answer: 2,
    opponent_counter_credit_sum: 0.5 + 0.5 + 1,
  });
  assert.deepEqual(stats.checkpoints, { "60s": null, "120s": null });
});

test("the tracker refuses a Giant play it did not see decided", () => {
  const engine = scriptedEngine();
  const tracker = createPlaystyleTracker("blue");
  playstyleBeforeStep(tracker, engine, []);
  engine.state.tick = 1;
  engine.state.replay.events.push({ type: "card_played", tick: 1, actor: "blue", card_id: "giant" });
  assert.throws(() => playstyleAfterStep(tracker, engine), /missed the decision state/);
});

test("pooled playstyle diagnostics count every threat and Giant play once", () => {
  const game = (tick, overrides) => {
    const stats = emptyPlaystyleStats();
    Object.assign(stats, overrides);
    return { tick, stats: { playstyle_diagnostics: stats } };
  };
  const parts = (material) => ({ v1: 0.1, phase_factor: 1, material, threat: 1, readiness: -1, support: 0, position: material + 1, total: 0 });
  const results = [
    game(1200, {
      wasted_elixir: 3,
      counter_responses: {
        threats: 4, strong: 1, partial: 1, other: 1, none: 1, censored: 2, counter_delay_ticks_sum: 60,
        strong_counter_in_hand: { threats: 2, strong: 1, partial: 0, other: 1, none: 0 },
        by_threat_card: { giant: { threats: 4, strong: 1, partial: 1, other: 1, none: 1 } },
      },
      giant_plays: { plays: 2, into_affordable_strong_answer: 1, into_affordable_answer: 2, opponent_counter_credit_sum: 1.5 },
      checkpoints: { "60s": null, "120s": null },
    }),
    game(3600, {
      wasted_elixir: 1,
      counter_responses: {
        threats: 2, strong: 2, partial: 0, other: 0, none: 0, censored: 0, counter_delay_ticks_sum: 30,
        strong_counter_in_hand: { threats: 0, strong: 0, partial: 0, other: 0, none: 0 },
        by_threat_card: { knight: { threats: 2, strong: 2, partial: 0, other: 0, none: 0 } },
      },
      checkpoints: { "60s": parts(2), "120s": parts(4) },
    }),
  ];
  const summary = summarizePlaystyleDiagnostics(results);
  assert.equal(summary.schema_version, EDGER_V2_PLAYSTYLE_DIAGNOSTICS_SCHEMA);
  assert.equal(summary.games, 2);
  assert.deepEqual(summary.wasted_elixir, { per_game: { mean: 2, p05: 1, p50: 1, p95: 1 }, per_minute: 4 / 4 });
  const responses = summary.counter_responses;
  assert.equal(responses.window_ticks, WINDOW);
  assert.equal(responses.threats, 6);
  assert.deepEqual(responses.shares, { strong: 3 / 6, partial: 1 / 6, other: 1 / 6, none: 1 / 6 });
  assert.equal(responses.censored, 2);
  assert.equal(responses.counter_response_delay_ticks_mean, 90 / 4);
  assert.deepEqual(responses.given_strong_counter_in_hand, { threats: 2, shares: { strong: 0.5, partial: 0, other: 0.5, none: 0 } });
  assert.deepEqual(Object.keys(responses.by_threat_card), ["giant", "knight"]);
  assert.deepEqual(summary.giant_plays, {
    plays: 2,
    plays_per_game: 1,
    into_affordable_strong_answer_fraction: 0.5,
    into_affordable_answer_fraction: 1,
    opponent_counter_credit_mean: 0.75,
  });
  assert.equal(summary.checkpoints["60s"].games, 1);
  assert.deepEqual(summary.checkpoints["120s"].terms.material, { mean: 4, p05: 4, p50: 4, p95: 4 });
  assert.equal(summary.checkpoints["60s"].terms.readiness.mean, -1, "R is reported though its weight is 0");

  const empty = summarizePlaystyleDiagnostics([game(100, {})]);
  assert.deepEqual(empty.counter_responses.shares, { strong: null, partial: null, other: null, none: null });
  assert.equal(empty.counter_responses.counter_response_delay_ticks_mean, null);
  assert.equal(empty.giant_plays.into_affordable_strong_answer_fraction, null);
  assert.equal(empty.checkpoints["60s"].terms, null);
  assert.throws(() => summarizePlaystyleDiagnostics([{ tick: 1, stats: {} }]), /no playstyle diagnostics/);
});
