import { MATCH_CONFIG, FIREBALL_CONFIG } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTower, createTroop } from "../sim/entities.js";
import { createArena } from "../sim/map.js";
import { createRng } from "../sim/random.js";
import {
  EDGER_BOT_ID,
  HEURISTIC_BOT_ID,
  INTERNAL_BASELINE_BOTS,
  enumerateLegalCardActions,
  normalizeBotId,
  rollDecisionDelayTicks,
  selectBotAction,
} from "./botRuntime.js";

export function makeBenchmarkArena() {
  return createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
}

export function makeBenchmarkInitialEntities() {
  return [
    createTower({ id: "blue_tower", team: "blue", x: 9, y: 29 }),
    createTower({ id: "red_tower", team: "red", x: 9, y: 3 }),
    createTroop({ id: "blue_knight_start", cardId: "knight", team: "blue", x: 8.4, y: 24 }),
    createTroop({ id: "red_knight_start", cardId: "knight", team: "red", x: 9.6, y: 8 }),
  ];
}

function makeBotController(seed) {
  return {
    rng: createRng(seed),
    nextDecisionTick: 1,
  };
}

function maybeSelectAction({ engine, actor, botId, controller, edgerModel }) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }

  const legalActions = enumerateLegalCardActions({ engine, actor });
  const decisionDelay = rollDecisionDelayTicks({ botId, rng: controller.rng });
  controller.nextDecisionTick = tick + decisionDelay;

  const action = selectBotAction({
    botId,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
    edgerModel,
  });

  if (!action || action.type !== "PLAY_CARD") {
    return null;
  }

  return {
    tick,
    type: "PLAY_CARD",
    actor,
    cardId: action.cardId,
    x: action.x,
    y: action.y,
  };
}

export function runBotMatch({
  blueBot,
  redBot,
  seed,
  maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40,
  edgerModel = undefined,
}) {
  const arena = makeBenchmarkArena();
  const engine = createEngine({
    seed,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeBenchmarkInitialEntities(),
  });

  const blueId = normalizeBotId(blueBot);
  const redId = normalizeBotId(redBot);
  const blue = makeBotController(seed ^ 0x9e3779b9);
  const red = makeBotController(seed ^ 0x85ebca6b);

  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const actions = [];

    const blueAction = maybeSelectAction({
      engine,
      actor: "blue",
      botId: blueId,
      controller: blue,
      edgerModel,
    });
    if (blueAction) {
      actions.push(blueAction);
    }

    const redAction = maybeSelectAction({
      engine,
      actor: "red",
      botId: redId,
      controller: red,
      edgerModel,
    });
    if (redAction) {
      actions.push(redAction);
    }

    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }

  return {
    result: engine.getMatchResult(),
    score: engine.getScore(),
    tick: engine.state.tick,
  };
}

export function runBenchmark({
  botA = EDGER_BOT_ID,
  botB,
  seed = 1337,
  rounds = 100,
  maxTicks = undefined,
  edgerModel = undefined,
}) {
  const rng = createRng(seed);
  const leftBot = normalizeBotId(botA);
  const rightBot = normalizeBotId(botB);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;

  for (let i = 0; i < rounds; i += 1) {
    const matchSeed = 1 + Math.floor(rng() * 2_000_000_000);
    const swapSides = i % 2 === 1;

    const match = runBotMatch({
      blueBot: swapSides ? rightBot : leftBot,
      redBot: swapSides ? leftBot : rightBot,
      seed: matchSeed,
      maxTicks,
      edgerModel,
    });

    const winner = match.result?.winner ?? null;
    if (!winner) {
      draws += 1;
      continue;
    }

    const winnerIsA = swapSides ? winner === "red" : winner === "blue";
    if (winnerIsA) {
      winsA += 1;
    } else {
      winsB += 1;
    }
  }

  const resolved = winsA + winsB;
  const winRateA = resolved > 0 ? winsA / resolved : 0;

  return {
    rounds,
    winsA,
    winsB,
    draws,
    resolved,
    winRateA,
  };
}

export function runEdgerBenchmarkSuite({
  opponents = [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS],
  seed = 20260630,
  roundsPerOpponent = 30,
  maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40,
  edgerModel = undefined,
} = {}) {
  const normalizedOpponents = Array.isArray(opponents)
    ? opponents.map(normalizeBotId).filter((botId) => botId !== EDGER_BOT_ID)
    : [];
  const defaultOpponents = [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS];
  const uniqueOpponents = [...new Set(normalizedOpponents.length > 0 ? normalizedOpponents : defaultOpponents)];
  const rng = createRng(seed);
  const pairs = uniqueOpponents.map((opponent) => {
    const pairSeed = 1 + Math.floor(rng() * 2_000_000_000);
    const benchmark = runBenchmark({
      botA: EDGER_BOT_ID,
      botB: opponent,
      seed: pairSeed,
      rounds: roundsPerOpponent,
      maxTicks,
      edgerModel,
    });
    return {
      bot: EDGER_BOT_ID,
      opponent,
      seed: pairSeed,
      rounds: benchmark.rounds,
      wins: benchmark.winsA,
      losses: benchmark.winsB,
      draws: benchmark.draws,
      resolved: benchmark.resolved,
      win_rate: benchmark.winRateA,
    };
  });

  return {
    seed,
    rounds_per_opponent: roundsPerOpponent,
    max_ticks: maxTicks,
    bot: EDGER_BOT_ID,
    opponents: uniqueOpponents,
    pairs,
  };
}

export function runBenchmarkMatrix({
  tiers,
  bots,
  seed = 1337,
  roundsPerPair = 100,
  maxTicks = undefined,
} = {}) {
  const requested = Array.isArray(bots) ? bots : tiers;
  const normalizedBots = Array.isArray(requested)
    ? requested.map(normalizeBotId).filter((botId, index, all) => all.indexOf(botId) === index)
    : [];
  const botList = normalizedBots.length >= 2 ? normalizedBots : [EDGER_BOT_ID, HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS];
  const rng = createRng(seed);
  const pairs = [];

  for (let i = 0; i < botList.length; i += 1) {
    for (let j = i + 1; j < botList.length; j += 1) {
      const botA = botList[i];
      const botB = botList[j];
      const pairSeed = 1 + Math.floor(rng() * 2_000_000_000);
      const benchmark = runBenchmark({
        botA,
        botB,
        seed: pairSeed,
        rounds: roundsPerPair,
        maxTicks,
      });

      pairs.push({
        bot_a: botA,
        bot_b: botB,
        seed: pairSeed,
        rounds: benchmark.rounds,
        wins_a: benchmark.winsA,
        wins_b: benchmark.winsB,
        draws: benchmark.draws,
        resolved: benchmark.resolved,
        win_rate_a: benchmark.winRateA,
      });
    }
  }

  return {
    seed,
    rounds_per_pair: roundsPerPair,
    bots: botList,
    pairs,
  };
}
