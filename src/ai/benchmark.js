import { createRng } from "../sim/random.js";

const TRUTH_FIREBALL_THRESHOLD = Object.freeze({
  normal: 420,
  double: 350,
  overtime: 280,
});

function phaseFromRoll(roll) {
  if (roll < 0.35) {
    return "normal";
  }
  if (roll < 0.7) {
    return "double";
  }
  return "overtime";
}

function makeScenario(index, rng) {
  const phase = phaseFromRoll(rng());
  const targetCount = 1 + Math.floor(rng() * 4);
  const targets = [];

  for (let i = 0; i < targetCount; i += 1) {
    targets.push({
      hp: 120 + Math.floor(rng() * 500),
      y: 8 + rng() * 16,
      entity_type: "troop",
    });
  }

  return {
    index,
    phase,
    currentElixir: 4 + Math.floor(rng() * 7),
    lookaheadTicks: 20,
    targets,
    fireball: {
      cost: 4,
      damage: 520,
      knockback_distance_tiles: 0.75,
      impactY: 16,
    },
    legalActions: [{ type: "PLAY_FIREBALL" }, { type: "PASS" }],
    trueThreshold: TRUTH_FIREBALL_THRESHOLD[phase],
  };
}

function actionUtility(action, scenario, evaluatedValue) {
  const utilityIfCast = evaluatedValue - scenario.trueThreshold;
  if (action.type === "PLAY_FIREBALL") {
    return utilityIfCast;
  }
  return -utilityIfCast;
}

export function runBenchmark({ botA, botB, evaluateFireballValue, seed = 1337, rounds = 500 }) {
  const rng = createRng(seed);
  let winsA = 0;
  let winsB = 0;

  for (let i = 0; i < rounds; i += 1) {
    const scenario = makeScenario(i, rng);
    const evalValue = evaluateFireballValue({
      targets: scenario.targets,
      damage: scenario.fireball.damage,
      knockbackDistanceTiles: scenario.fireball.knockback_distance_tiles,
      impactY: scenario.fireball.impactY,
    });

    const stateForA = {
      ...scenario,
      rng,
    };
    const stateForB = {
      ...scenario,
      rng,
    };

    const actionA = botA.selectAction(stateForA, scenario.legalActions);
    const actionB = botB.selectAction(stateForB, scenario.legalActions);

    const scoreA = actionUtility(actionA, scenario, evalValue);
    const scoreB = actionUtility(actionB, scenario, evalValue);

    if (scoreA > scoreB) {
      winsA += 1;
    } else if (scoreB > scoreA) {
      winsB += 1;
    }
  }

  const resolved = winsA + winsB;
  const winRateA = resolved === 0 ? 0 : winsA / resolved;

  return {
    rounds,
    winsA,
    winsB,
    winRateA,
  };
}
