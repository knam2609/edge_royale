import { MATCH_CONFIG, FIREBALL_CONFIG } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTower, createTroop } from "../sim/entities.js";
import { createArena } from "../sim/map.js";
import { createRng } from "../sim/random.js";
import {
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
} from "./ladderRuntime.js";

function makeArena() {
  return createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
}

function makeInitialEntities() {
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

function maybeSelectAction({ engine, actor, tierId, controller, trainedModel = null }) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }

  const legalActions = enumerateLegalCardActions({ engine, actor });
  const decisionDelay = rollDecisionDelayTicks({ tierId, rng: controller.rng });
  controller.nextDecisionTick = tick + decisionDelay;

  const action = selectBotAction({
    tierId,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
    trainedModel,
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

export function runLadderMatch({
  blueTier,
  redTier,
  seed,
  trainedModelBlue = null,
  trainedModelRed = null,
  maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40,
}) {
  const arena = makeArena();
  const engine = createEngine({
    seed,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });

  const blue = makeBotController(seed ^ 0x9e3779b9);
  const red = makeBotController(seed ^ 0x85ebca6b);

  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const actions = [];

    const blueAction = maybeSelectAction({
      engine,
      actor: "blue",
      tierId: blueTier,
      controller: blue,
      trainedModel: trainedModelBlue,
    });
    if (blueAction) {
      actions.push(blueAction);
    }

    const redAction = maybeSelectAction({
      engine,
      actor: "red",
      tierId: redTier,
      controller: red,
      trainedModel: trainedModelRed,
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

export function runBenchmark({ botA, botB, seed = 1337, rounds = 100, maxTicks = undefined }) {
  const rng = createRng(seed);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;

  for (let i = 0; i < rounds; i += 1) {
    const matchSeed = 1 + Math.floor(rng() * 2_000_000_000);
    const swapSides = i % 2 === 1;

    const match = runLadderMatch({
      blueTier: swapSides ? botB : botA,
      redTier: swapSides ? botA : botB,
      seed: matchSeed,
      maxTicks,
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

export function runBenchmarkMatrix({
  tiers = ["noob", "mid", "top", "pro", "goat", "god"],
  seed = 1337,
  roundsPerPair = 100,
  maxTicks = undefined,
} = {}) {
  const normalizedTiers = Array.isArray(tiers)
    ? tiers.filter((tierId, index) => typeof tierId === "string" && tiers.indexOf(tierId) === index)
    : [];
  const rng = createRng(seed);
  const pairs = [];

  for (let i = 0; i < normalizedTiers.length; i += 1) {
    for (let j = i + 1; j < normalizedTiers.length; j += 1) {
      const lower = normalizedTiers[i];
      const higher = normalizedTiers[j];
      const pairSeed = 1 + Math.floor(rng() * 2_000_000_000);
      const benchmark = runBenchmark({
        botA: higher,
        botB: lower,
        seed: pairSeed,
        rounds: roundsPerPair,
        maxTicks,
      });

      pairs.push({
        higher_tier: higher,
        lower_tier: lower,
        seed: pairSeed,
        rounds: benchmark.rounds,
        wins_higher: benchmark.winsA,
        wins_lower: benchmark.winsB,
        draws: benchmark.draws,
        resolved: benchmark.resolved,
        win_rate_higher: benchmark.winRateA,
      });
    }
  }

  return {
    seed,
    rounds_per_pair: roundsPerPair,
    tiers: normalizedTiers,
    pairs,
  };
}
