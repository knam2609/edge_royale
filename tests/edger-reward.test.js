import assert from "node:assert/strict";
import test from "node:test";

import {
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../src/ai/botRuntime.js";
import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";
import { createTroop } from "../src/sim/entities.js";
import { createRng } from "../src/sim/random.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  EDGER_REWARD_VERSIONS,
  counterCredit,
  elixirPhaseFactor,
  potentialForActor,
  sidePositionTerms,
  terminalPotentialForActor,
  v1PotentialForActor,
} from "../scripts/edger-reward-core.mjs";
import {
  EDGER_V2_CADENCES,
  EDGER_V2_CADENCE_PER_TICK_GAMMA,
  encodeCadenceEpisode,
  runEdgerV2CadenceMatch,
  scorePotentialForActor,
} from "../scripts/edger-v2-cadence-core.mjs";

const { V1, V2 } = EDGER_REWARD_VERSIONS;

// A production arena with no troops; hands, queues and elixir set per test.
function emptyBoard({ blueHand = ["arrows", "fireball"], redHand = ["arrows", "fireball"], blueElixir = 5, redElixir = 5 } = {}) {
  const engine = createProductionEngine({ seed: 11 });
  engine.state.card_state.blue.hand = [...blueHand];
  engine.state.card_state.red.hand = [...redHand];
  engine.state.card_state.blue.draw_pile = ["arrows"];
  engine.state.card_state.red.draw_pile = ["arrows"];
  engine.state.elixir.blue.elixir = blueElixir;
  engine.state.elixir.red.elixir = redElixir;
  engine.state.elixir.blue.regenAccumulatorTicks = 0;
  engine.state.elixir.red.regenAccumulatorTicks = 0;
  return engine;
}

let troopId = 0;
function addTroop(engine, { cardId, team, x, y, hpFraction = 1, target = null }) {
  const troop = createTroop({ id: `t${troopId += 1}`, cardId, team, x, y });
  troop.hp = troop.maxHp * hpFraction;
  troop.target_entity_id = target;
  engine.state.entities.push(troop);
  return troop;
}

// Two bots play `ticks` ticks from a seed: a realistic mid-game state.
function playedEngine(seed, ticks) {
  const engine = createProductionEngine({ seed });
  const controllers = {
    blue: { botId: "edger_heuristic", rng: createRng(seed ^ 0x1234), next: 1 },
    red: { botId: "aggressive", rng: createRng(seed ^ 0x4321), next: 1 },
  };
  while (engine.state.tick < ticks && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    const actions = [];
    for (const actor of ["blue", "red"]) {
      const controller = controllers[actor];
      if (tick < controller.next) {
        continue;
      }
      const selected = selectBotAction({
        botId: controller.botId,
        engine,
        actor,
        legalActions: enumerateLegalCardActions({ engine, actor }),
        rng: controller.rng,
      });
      controller.next = tick + rollDecisionDelayTicks({ botId: controller.botId, rng: controller.rng });
      if (selected?.type === "PLAY_CARD") {
        actions.push({ tick, type: "PLAY_CARD", actor, cardId: selected.cardId, x: selected.x, y: selected.y });
      }
    }
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  return engine;
}

function randomModel(seed) {
  const model = createEdgerV2BootstrapModel({ modelId: `reward-test-${seed}` });
  const rng = createRng(seed);
  const fill = (values) => {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (rng() * 2 - 1) * 0.35;
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
  const delayHead = model.weights.delay_head;
  for (let index = 0; index < delayHead.weights.length; index += 1) {
    delayHead.weights[index] *= 6;
  }
  return model;
}

test("reward v1 stays the default and the unchanged crown/tower-HP potential", () => {
  const engine = playedEngine(5, 900);
  for (const actor of ["blue", "red"]) {
    const v1 = potentialForActor(engine, actor);
    assert.equal(v1.version, V1);
    assert.equal(v1.total, v1PotentialForActor(engine, actor));
    assert.equal(v1.total, scorePotentialForActor(engine, actor));
    assert.equal(terminalPotentialForActor(engine, actor, V2), v1PotentialForActor(engine, actor));
  }
  assert.throws(() => potentialForActor(engine, "blue", "edger_potential_reward_v9"), /unknown reward version/);
});

test("reward v2 is exactly antisymmetric between blue and red", () => {
  for (const [seed, ticks] of [[5, 600], [6, 1500], [7, 2700], [8, 3300]]) {
    const engine = playedEngine(seed, ticks);
    const blue = potentialForActor(engine, "blue", V2);
    const red = potentialForActor(engine, "red", V2);
    for (const key of ["total", "v1", "material", "threat", "readiness", "support", "position"]) {
      // `===` treats 0 and -0 as equal, as the arithmetic does.
      assert.ok(blue[key] === -red[key], `${key} at seed ${seed}: ${blue[key]} vs ${red[key]}`);
    }
    assert.ok(engine.state.entities.some((entity) => entity.entity_type === "troop"), "state has troops");
  }
});

test("material counts the bank, troops by HP and pending cards, scaled by elixir refill speed", () => {
  assert.equal(elixirPhaseFactor("normal"), 1);
  assert.equal(elixirPhaseFactor("double"), 0.5);
  assert.equal(elixirPhaseFactor("overtime"), 20 / 56);

  // Goblins (2) kill a Mini PEKKA (4) and lose two of four goblins: +3 elixir.
  const before = emptyBoard();
  for (const x of [3, 4, 5, 6]) {
    addTroop(before, { cardId: "goblins", team: "blue", x, y: 20 });
  }
  addTroop(before, { cardId: "mini_pekka", team: "red", x: 4, y: 19 });
  const after = emptyBoard();
  addTroop(after, { cardId: "goblins", team: "blue", x: 3, y: 20 });
  addTroop(after, { cardId: "goblins", team: "blue", x: 4, y: 20, hpFraction: 0.5 });
  addTroop(after, { cardId: "goblins", team: "blue", x: 5, y: 20, hpFraction: 0.5 });
  const swing = potentialForActor(after, "blue", V2).material - potentialForActor(before, "blue", V2).material;
  assert.ok(Math.abs(swing - 3) < 1e-12, `swing ${swing}`);

  // Banked elixir includes refill progress.
  const engine = emptyBoard({ blueElixir: 6, redElixir: 4 });
  engine.state.elixir.blue.regenAccumulatorTicks = 28;
  assert.equal(potentialForActor(engine, "blue", V2).material, 2.5);
});

test("playing a card leaves material unchanged in every phase", () => {
  for (const [phase, setup] of [
    ["normal", (engine) => { engine.state.tick = 100; }],
    ["double", (engine) => { engine.state.tick = 2500; }],
    ["overtime", (engine) => { engine.state.tick = 3700; engine.setOvertime(true); }],
  ]) {
    for (const cardId of ["knight", "fireball"]) {
      const engine = emptyBoard({ blueHand: [cardId, "arrows"], blueElixir: 7, redElixir: 7 });
      setup(engine);
      const play = enumerateLegalCardActions({ engine, actor: "blue" }).find((action) => action.cardId === cardId);
      const beforeTerms = potentialForActor(engine, "blue", V2);
      assert.equal(beforeTerms.phase, phase);
      engine.step([{ tick: engine.state.tick + 1, type: "PLAY_CARD", actor: "blue", cardId, x: play.x, y: play.y }]);
      assert.equal(engine.state.elixir.blue.elixir < 7, true, `${cardId} was played in ${phase}`);
      assert.ok(engine.state.pending_effects.some((effect) => effect.card_id === cardId));
      const afterTerms = potentialForActor(engine, "blue", V2);
      assert.ok(Math.abs(afterTerms.material - beforeTerms.material) < 1e-12, `${cardId} in ${phase}`);
      assert.equal(afterTerms.phase_factor, elixirPhaseFactor(phase));
    }
  }
});

test("threat grows from own side to across the bridge to locked on a tower", () => {
  const values = [];
  for (const [y, target] of [[20, null], [12, null], [9, "red_crown_left"]]) {
    const engine = emptyBoard();
    addTroop(engine, { cardId: "giant", team: "blue", x: 3.5, y, target });
    values.push(sidePositionTerms(engine, "blue").threat);
  }
  assert.deepEqual(values, [1.25, 3.75, 5]);

  // Low-threat cards count a quarter; a half-HP Musketeer across the bridge.
  const engine = emptyBoard();
  addTroop(engine, { cardId: "knight", team: "red", x: 4, y: 20 });
  addTroop(engine, { cardId: "musketeer", team: "red", x: 6, y: 20, hpFraction: 0.5 });
  assert.equal(sidePositionTerms(engine, "red").threat, 0.25 * 3 * 0.75 + 1 * 4 * 0.5 * 0.75);
});

test("answer readiness credits counters in hand, next in queue and by affordability", () => {
  const readiness = ({ hand, next = "arrows", elixir = 5, giantHp = 1 }) => {
    const engine = emptyBoard({ blueHand: hand, blueElixir: elixir });
    engine.state.card_state.blue.draw_pile = [next];
    addTroop(engine, { cardId: "giant", team: "red", x: 4, y: 18, hpFraction: giantHp });
    return sidePositionTerms(engine, "blue").readiness;
  };
  // 0.5 x cost 5 x tier 1 x urgency x credit.
  assert.equal(readiness({ hand: ["mini_pekka", "arrows"] }), 2.5);
  assert.equal(readiness({ hand: ["arrows"], next: "mini_pekka" }), 1.25);
  assert.equal(readiness({ hand: ["archers", "arrows"] }), 1.25, "partial counter");
  assert.equal(readiness({ hand: ["mini_pekka", "arrows"], elixir: 2 }), 1.25);
  assert.equal(readiness({ hand: ["mini_pekka", "arrows"], elixir: 1 }), 0.625);
  assert.equal(readiness({ hand: ["mini_pekka", "arrows"], giantHp: 0.5 }), 1.25);
  assert.equal(readiness({ hand: ["arrows", "fireball"] }), 0, "no counter");

  // Troop cards in the enemy hand count at half urgency; Fireball is a
  // partial answer to Musketeer.
  const engine = emptyBoard({ blueHand: ["fireball"], redHand: ["musketeer", "arrows"], blueElixir: 4 });
  assert.equal(sidePositionTerms(engine, "blue").readiness, 0.5 * 4 * 1 * 0.5 * 0.5);
  assert.equal(counterCredit({ hand: ["arrows"], nextInQueue: null, elixir: 10 }, "goblins"), 1);
  assert.equal(counterCredit({ hand: ["giant"], nextInQueue: null, elixir: 10 }, "goblins"), 0);
});

test("tank support needs our Knight or Giant ahead in the same lane", () => {
  const support = (tank, supportCard = "musketeer") => {
    const engine = emptyBoard();
    addTroop(engine, { cardId: supportCard, team: "blue", x: 4, y: 20 });
    if (tank) {
      addTroop(engine, { cardId: tank.cardId ?? "knight", team: "blue", x: tank.x, y: tank.y });
    }
    return sidePositionTerms(engine, "blue").support;
  };
  assert.equal(support({ x: 4, y: 17 }), 1);
  assert.equal(support({ cardId: "giant", x: 5.5, y: 15 }), 1);
  assert.equal(support({ x: 7, y: 17 }), 0, "different lane");
  assert.equal(support({ x: 4, y: 22 }), 0, "tank behind");
  assert.equal(support({ x: 4, y: 14 }), 0, "tank too far ahead");
  assert.equal(support(null), 0);
  assert.equal(support({ x: 4, y: 17 }, "archers"), 0.25 * 1.5);

  // Red attacks toward larger y.
  const engine = emptyBoard();
  addTroop(engine, { cardId: "archers", team: "red", x: 10, y: 10 });
  addTroop(engine, { cardId: "knight", team: "red", x: 10, y: 13 });
  assert.equal(sidePositionTerms(engine, "red").support, 0.375);
});

test("reward v2 trajectories telescope to the v1 end value and never change play", () => {
  const model = randomModel(31);
  const gamma = EDGER_V2_CADENCE_PER_TICK_GAMMA;
  const runs = {};
  for (const version of [V1, V2]) {
    runs[version] = runEdgerV2CadenceMatch({
      seed: 9090,
      candidateActor: "red",
      model,
      cadence: EDGER_V2_CADENCES.LEARNED,
      opponentBotId: "aggressive",
      mode: "sample",
      recordRows: true,
      rewardVersion: version,
    });
  }
  const v1 = runs[V1];
  const v2 = runs[V2];
  assert.equal(v2.action_stream_hash, v1.action_stream_hash);
  assert.equal(v2.final_state_hash, v1.final_state_hash);
  assert.ok(v2.rows.length > 10);
  assert.ok(v2.rows.some((row, index) => row.reward !== v1.rows[index].reward), "v2 changes rewards");

  const score = v2.score;
  const finalV1 = (score.red_crowns - score.blue_crowns) * 0.25 + (score.red_tower_hp - score.blue_tower_hp) / 30_000;
  const terminal = v2.winner === null ? 0 : v2.winner === "red" ? 1 : -1;
  v2.rows.forEach((row, index) => {
    const expected = -row.potential + gamma ** (v2.tick + 1 - row.tick) * (finalV1 + terminal);
    assert.ok(Math.abs(row.discounted_return - expected) < 1e-9, `return row ${index}`);
    if (index + 1 < v2.rows.length) {
      const next = v2.rows[index + 1];
      assert.ok(Math.abs(row.reward - (gamma ** (next.tick - row.tick) * next.potential - row.potential)) < 1e-12);
    }
  });
  const last = v2.rows.at(-1);
  const lastDiscount = gamma ** (v2.tick + 1 - last.tick);
  assert.ok(Math.abs(last.reward - (lastDiscount * (finalV1 + terminal) - last.potential)) < 1e-12);

  const encoded = encodeCadenceEpisode({ rows: v2.rows, meta: {}, rewardVersion: V2 });
  assert.equal(encoded.header.reward_version, V2);
  assert.equal(encodeCadenceEpisode({ rows: v1.rows, meta: {} }).header.reward_version, V1);
  assert.throws(() => encodeCadenceEpisode({ rows: v1.rows, meta: {}, rewardVersion: "nope" }), /unknown reward version/);
});
