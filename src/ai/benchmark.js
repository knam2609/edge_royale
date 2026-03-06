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
    createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: 3800 }),
    createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: 3800 }),
    createTroop({ id: "blue_knight_start", cardId: "knight", team: "blue", x: 8.4, y: 24, hp: 1400 }),
    createTroop({ id: "red_knight_start", cardId: "knight", team: "red", x: 9.6, y: 8, hp: 1400 }),
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

  const maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40;
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

export function runBenchmark({ botA, botB, seed = 1337, rounds = 100 }) {
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
