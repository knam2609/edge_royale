import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  EDGER_BOT_ID,
  HEURISTIC_BOT_ID,
  actionSortKey,
  enumerateLegalCardActions,
  evaluateSpellAction,
  getBotConfig,
  normalizeBotId,
  rollDecisionDelayTicks,
  selectBotAction,
  selectBotDecision,
  selectEdgerAction,
  selectHeuristicAction,
  warmUpBotDecision,
} from "../src/ai/botRuntime.js";
import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import { EDGER_FULL_GRID_ACTION_SPACE_VERSION } from "../src/ai/v2/observation.js";
import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { ROYALE_LANE_X, ROYALE_TOWER_X, ROYALE_TOWER_Y, createArena, createRoyaleArena } from "../src/sim/map.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { createRng } from "../src/sim/random.js";
import { getTowerStats } from "../src/sim/stats.js";

// The v1 bootstrap that was live until the November 2026 v2 promotion, kept
// byte for byte. The v1 ML path still serves any v1 model.
const EDGER_V1_MODEL = JSON.parse(fs.readFileSync(
  new URL("../artifacts/edger-training/retired/edger_policy_bootstrap_20260701/edger_policy.json", import.meta.url),
  "utf8",
));

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

function makeEngine(redHand, { blueHand, blueElixir = 5 } = {}) {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const crownHp = getTowerStats("crown").hp;
  const engine = createEngine({
    seed: 901,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
      createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 9, y: 23, hp: 1400 }),
    ],
    initialCardState: makeCardState(redHand, blueHand),
  });
  engine.state.elixir.blue.elixir = blueElixir;
  engine.state.elixir.red.elixir = 10;
  return engine;
}

// Heuristic blue against the given red bot on a production engine, the way the
// browser loop schedules decisions. Records every decision for both actors.
function playProductionMatch({ redBotId, edgerModel, seed = 314, ticks = 400 }) {
  const engine = createProductionEngine({ seed });
  const bots = {
    blue: { botId: HEURISTIC_BOT_ID, rng: createRng(seed ^ 0x9e3779b9), nextTick: 1 },
    red: { botId: redBotId, rng: createRng(seed ^ 0x5f3759df), nextTick: 1 },
  };
  const decisions = [];
  const legalActionKeys = [];
  for (let tick = 1; tick <= ticks && !engine.getMatchResult(); tick += 1) {
    const actions = [];
    for (const actor of ["blue", "red"]) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      legalActionKeys.push(legalActions.map(actionSortKey));
      const bot = bots[actor];
      if (tick < bot.nextTick) {
        continue;
      }
      const decision = selectBotDecision({ botId: bot.botId, engine, actor, legalActions, rng: bot.rng, edgerModel });
      bot.nextTick = tick + decision.delayTicks;
      decisions.push([tick, actor, JSON.stringify(decision.action ?? null), decision.delayTicks]);
      if (decision.action?.type === "PLAY_CARD") {
        const { cardId, x, y } = decision.action;
        actions.push({ tick, type: "PLAY_CARD", actor, cardId, x, y });
      }
    }
    engine.step(actions);
  }
  return {
    decisions,
    legalActionKeys,
    stateHash: engine.getStateHash(),
    nextRedRandom: bots.red.rng(),
  };
}

function makeRoyaleEngine(redHand, { blueLeftHp = getTowerStats("crown").hp, blueRightHp = getTowerStats("crown").hp } = {}) {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const crownHp = getTowerStats("crown").hp;
  return createEngine({
    seed: 902,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_left", team: "blue", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.blue.crown, hp: blueLeftHp, tower_role: "crown" }),
      createTower({ id: "blue_right", team: "blue", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.blue.crown, hp: blueRightHp, tower_role: "crown" }),
      createTower({ id: "blue_king", team: "blue", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.blue.king, tower_role: "king", is_active: false }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, tower_role: "king", is_active: false }),
      createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 9, y: 23, hp: 1400 }),
    ],
    initialCardState: makeCardState(redHand),
  });
}

test("enumerateLegalCardActions includes the full front row on your side", () => {
  const engine = makeRoyaleEngine(["giant", "fireball", "knight", "arrows"]);
  const actions = enumerateLegalCardActions({ engine, actor: "red" });

  assert.ok(actions.length > 0);
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const spellActions = actions.filter((action) => action.cardId === "fireball" || action.cardId === "arrows");

  assert.ok(troopActions.length > 0);
  assert.equal(spellActions.length, 18 * 32 * 2);
  assert.ok(spellActions.some((action) => action.cardId === "fireball" && action.x === 0.5 && action.y === 0.5));
  assert.ok(spellActions.some((action) => action.cardId === "arrows" && action.x === 17.5 && action.y === 31.5));
  for (const action of troopActions) {
    assert.ok(action.y <= 14.5, `red troop action crossed river: y=${action.y}`);
  }
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === 3.5));
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === 9.5));
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === ROYALE_LANE_X.right));
});

test("enumerateLegalCardActions unlocks only the captured 5x9 pocket and bridge connector for red troops", () => {
  const engine = makeRoyaleEngine(["giant", "fireball", "knight", "arrows"], { blueLeftHp: 0 });
  const actions = enumerateLegalCardActions({ engine, actor: "red" });
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const pocketActions = troopActions.filter((action) => action.y >= 17.5);
  const bridgeActions = troopActions.filter((action) => action.y > 14.5 && action.y < 17.5);

  assert.ok(pocketActions.length > 0);
  assert.ok(pocketActions.some((action) => action.x === 3.5 || action.x === 4.5));
  assert.ok(pocketActions.every((action) => action.x <= 8.5));
  assert.ok(pocketActions.every((action) => action.y <= 21.5));
  assert.ok(!pocketActions.some((action) => action.x === 15.5));
  assert.ok(bridgeActions.some((action) => action.x === 3.5));
  assert.ok(bridgeActions.every((action) => action.x === 3.5));
  assert.ok(bridgeActions.every((action) => action.y === 15.5 || action.y === 16.5));
});

function cloneModel(model = EDGER_V1_MODEL) {
  return JSON.parse(JSON.stringify(model));
}

function makePassFavoredModel() {
  const model = cloneModel();
  model.model_id = "test_pass_favored_policy";
  model.weights.scorer.weights.fill(0);
  model.weights.scorer.weights[64 + 1] = 10;
  return model;
}

function makeTieModel() {
  const model = cloneModel();
  model.model_id = "test_tie_policy";
  model.weights.scorer.weights.fill(0);
  model.weights.scorer.weights[64 + 1] = -1;
  model.weights.scorer.bias = [0];
  return model;
}

test("enumerateLegalCardActions orders live match actions by strictly increasing sort key", () => {
  const { legalActionKeys } = playProductionMatch({ redBotId: HEURISTIC_BOT_ID, ticks: 1200 });
  const cardsSeen = new Set();

  for (const keys of legalActionKeys) {
    for (let index = 1; index < keys.length; index += 1) {
      // Unique, strictly increasing keys admit exactly one sorted order, so any
      // stable sort by these keys returns the same list.
      assert.ok(keys[index - 1].localeCompare(keys[index]) < 0, `${keys[index - 1]} !< ${keys[index]}`);
    }
    for (const key of keys) {
      cardsSeen.add(key.split("|")[0]);
    }
  }
  assert.ok(legalActionKeys.some((keys) => keys.length > 100));
  assert.ok(["giant", "knight", "arrows", "fireball"].every((cardId) => cardsSeen.has(cardId)));
});

test("live Edger is the promoted full-grid v2 model and its live decision path stays legal", () => {
  assert.equal(EDGER_POLICY_MODEL.schema_version, "edger_policy_model_v2");
  assert.equal(EDGER_POLICY_MODEL.action_space_version, EDGER_FULL_GRID_ACTION_SPACE_VERSION);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(new URL("../artifacts/edger-training/promoted/edger_policy_current.json", import.meta.url), "utf8")),
    EDGER_POLICY_MODEL,
  );
  // As in the browser: a production match, the legacy shortlist passed in, and
  // the live path re-enumerating the model's full grid and choosing from it.
  const engine = createProductionEngine({ seed: 314 });
  const heuristicRng = createRng(314);
  const next = { red: 1, blue: 1 };
  let plays = 0;
  for (let tick = 1; tick <= 1800 && !engine.getMatchResult(); tick += 1) {
    const actions = [];
    for (const actor of ["red", "blue"]) {
      if (tick < next[actor]) {
        continue;
      }
      const legalActions = enumerateLegalCardActions({ engine, actor });
      const botId = actor === "red" ? EDGER_BOT_ID : HEURISTIC_BOT_ID;
      const decision = selectBotDecision({ botId, engine, actor, legalActions, rng: heuristicRng });
      assert.ok(Number.isInteger(decision.delayTicks) && decision.delayTicks >= 1);
      next[actor] = tick + decision.delayTicks;
      if (decision.action?.type !== "PLAY_CARD") {
        continue;
      }
      if (actor === "red") {
        const modelLegal = enumerateLegalCardActions({ engine, actor, model: EDGER_POLICY_MODEL });
        assert.ok(modelLegal.some((candidate) => JSON.stringify(candidate) === JSON.stringify(decision.action)));
        plays += 1;
      }
      const { cardId, x, y } = decision.action;
      actions.push({ tick, type: "PLAY_CARD", actor, cardId, x, y });
    }
    engine.step(actions);
  }
  assert.ok(plays > 0);
});

test("a v1 Edger model returns one of the given legal actions", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });

  const action = selectBotAction({
    botId: EDGER_BOT_ID,
    engine,
    actor: "red",
    legalActions,
    edgerModel: EDGER_V1_MODEL,
  });

  if (action.type === "PASS") {
    return;
  }
  assert.ok(legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)));
});

test("edger_heuristic preserves the handcrafted policy alias", () => {
  assert.equal(normalizeBotId("heuristic"), HEURISTIC_BOT_ID);

  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const direct = selectHeuristicAction({ engine, actor: "red", legalActions });
  const routed = selectBotAction({
    botId: HEURISTIC_BOT_ID,
    engine,
    actor: "red",
    legalActions,
    rng: () => 0,
  });

  assert.deepEqual(routed, direct);
});

test("edger routes through the ML policy model", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const heuristic = selectBotAction({
    botId: HEURISTIC_BOT_ID,
    engine,
    actor: "red",
    legalActions,
  });
  const modelSelected = selectBotAction({
    botId: EDGER_BOT_ID,
    engine,
    actor: "red",
    legalActions,
    edgerModel: makePassFavoredModel(),
  });

  assert.equal(heuristic.type, "PLAY_CARD");
  assert.equal(modelSelected.type, "PASS");
});

test("Edger uses hidden opponent hand and elixir through the engine snapshot", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"], {
    blueHand: ["mini_pekka", "musketeer", "arrows", "fireball"],
    blueElixir: 10,
  });

  assert.deepEqual(engine.getHand("blue"), ["mini_pekka", "musketeer", "arrows", "fireball"]);
  assert.equal(engine.state.elixir.blue.elixir, 10);
});

test("Edger acts every tick", () => {
  const tiny = rollDecisionDelayTicks({ botId: EDGER_BOT_ID, rng: () => 0 });
  const huge = rollDecisionDelayTicks({ botId: EDGER_BOT_ID, rng: () => 0.999 });

  assert.equal(tiny, 1);
  assert.equal(huge, 1);
});

test("v2 Edger runtime honors the model-selected decision delay", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const decision = selectBotDecision({
    botId: EDGER_BOT_ID,
    engine,
    actor: "red",
    legalActions,
    edgerModel: createEdgerV2BootstrapModel(),
  });

  assert.deepEqual(decision.action, { type: "PASS" });
  assert.equal(decision.delayTicks, 200);
});

for (const [label, makeModel] of [
  ["v1", () => JSON.parse(JSON.stringify(EDGER_V1_MODEL))],
  ["v2", () => createEdgerV2BootstrapModel()],
  ["live", () => JSON.parse(JSON.stringify(EDGER_POLICY_MODEL))],
]) {
  test(`warmUpBotDecision leaves ${label} Edger decisions, state and random stream unchanged`, () => {
    // Fresh model objects start with cold model caches, as on page load.
    const cold = playProductionMatch({ redBotId: EDGER_BOT_ID, edgerModel: makeModel() });

    const warmedModel = makeModel();
    const disposable = createProductionEngine();
    const disposableHash = disposable.getStateHash();
    warmUpBotDecision({ botId: EDGER_BOT_ID, engine: disposable, edgerModel: warmedModel });
    assert.equal(disposable.getStateHash(), disposableHash);
    const warmed = playProductionMatch({ redBotId: EDGER_BOT_ID, edgerModel: warmedModel });

    assert.ok(cold.decisions.some(([, actor]) => actor === "red"));
    assert.deepEqual(warmed.decisions, cold.decisions);
    assert.equal(warmed.stateHash, cold.stateHash);
    assert.equal(warmed.nextRedRandom, cold.nextRedRandom);
  });
}

test("Edger ML deterministic tie-break chooses the stable action-sort key", () => {
  const engine = makeEngine(["knight", "giant", "arrows", "fireball"]);
  const legalActions = [
    { type: "PLAY_CARD", cardId: "knight", x: 10, y: 14 },
    { type: "PLAY_CARD", cardId: "knight", x: 8, y: 14 },
  ];

  const action = selectEdgerAction({
    engine,
    actor: "red",
    legalActions,
    model: makeTieModel(),
  });

  assert.equal(action.type, "PLAY_CARD");
  assert.equal(action.x, 10);
});

test("ML policy model validation fails closed", () => {
  const valid = cloneModel();
  assert.equal(validateEdgerPolicyModel(valid), valid);

  assert.throws(() => validateEdgerPolicyModel({ ...valid, schema_version: "wrong" }), /schema_version/);

  const wrongDimensions = cloneModel();
  wrongDimensions.weights.action_encoder.weights = wrongDimensions.weights.action_encoder.weights.slice(1);
  assert.throws(() => validateEdgerPolicyModel(wrongDimensions), /action_encoder\.weights/);

  const nonFinite = cloneModel();
  nonFinite.weights.scorer.weights[0] = Number.NaN;
  assert.throws(() => validateEdgerPolicyModel(nonFinite), /finite/);
});

test("internal benchmark baselines keep configured delay bounds", () => {
  for (const botId of ["random", "aggressive", "defender"]) {
    const config = getBotConfig(botId);
    const tiny = rollDecisionDelayTicks({ botId, rng: () => 0 });
    const huge = rollDecisionDelayTicks({ botId, rng: () => 0.999 });

    assert.ok(tiny >= config.min_delay_ticks && tiny <= config.max_delay_ticks);
    assert.ok(huge >= config.min_delay_ticks && huge <= config.max_delay_ticks);
  }
});

test("spell evaluation uses explicit tower chip values for arrows and fireball", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const tower = createTower({ id: "red_tower", team: "red", x: 9, y: 3 });
  const state = {
    arena,
    entities: [tower],
  };

  const fireballScore = evaluateSpellAction(
    { type: "PLAY_CARD", cardId: "fireball", x: 9, y: 3 },
    state,
    "blue",
    "normal",
    EDGER_BOT_ID,
  );
  const arrowsScore = evaluateSpellAction(
    { type: "PLAY_CARD", cardId: "arrows", x: 9, y: 3 },
    state,
    "blue",
    "normal",
    EDGER_BOT_ID,
  );

  assert.ok(fireballScore.score > 0);
  assert.equal(fireballScore.towerHits, 1);
  assert.equal(fireballScore.troopHits, 0);

  assert.ok(arrowsScore.score < fireballScore.score);
  assert.equal(arrowsScore.towerHits, 1);
  assert.equal(arrowsScore.troopHits, 0);
});
