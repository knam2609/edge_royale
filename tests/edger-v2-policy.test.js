import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { HEURISTIC_BOT_ID, enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import {
  EDGER_FULL_GRID_ACTION_SPACE_VERSION,
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  EDGER_V2_CARD_ACTIONS,
  EDGER_V2_GLOBAL_FEATURES,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
  encodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  createEdgerV2BootstrapModel,
  encodeEdgerV2PolicyState,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { getTroopPlacementStatus } from "../src/sim/placement.js";
import { createTroop } from "../src/sim/entities.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { buildCandidateParityFixtures } from "../scripts/edger-v2-evaluation-core.mjs";
import { runEdgerV2CadenceMatch } from "../scripts/edger-v2-cadence-core.mjs";

test("v2 oracle observation has fixed production dimensions and relative sides", () => {
  const engine = createProductionEngine({ seed: 7101 });
  const red = buildEdgerV2Observation({ engine, actor: "red" });
  const blue = buildEdgerV2Observation({ engine, actor: "blue" });

  assert.equal(
    red.board.length,
    EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS,
  );
  assert.equal(red.global.length, EDGER_V2_GLOBAL_FEATURES);
  assert.equal(blue.board.length, red.board.length);
  assert.equal(blue.global.length, red.global.length);
  assert.ok(red.board.some((value) => value !== 0));
  assert.ok(blue.board.some((value) => value !== 0));
});

test("v2 side canonicalization rotates a symmetric state identically", () => {
  const cards = {
    blue: {
      hand: DEFAULT_DECK.slice(0, 4),
      draw_pile: DEFAULT_DECK.slice(4),
    },
    red: {
      hand: DEFAULT_DECK.slice(0, 4),
      draw_pile: DEFAULT_DECK.slice(4),
    },
  };
  const engine = createProductionEngine({
    seed: 7103,
    initialCardState: cards,
  });
  const red = buildEdgerV2Observation({ engine, actor: "red" });
  const blue = buildEdgerV2Observation({ engine, actor: "blue" });

  assert.deepEqual(red.board, blue.board);
  assert.deepEqual(red.global, blue.global);
});

test("spell globals flag lethal towers and count the best enemy-troop hits", () => {
  const engine = createProductionEngine({ seed: 7105 });
  const blueTowers = engine.state.entities.filter(
    (entity) => entity.entity_type === "tower" && entity.team === "blue",
  );
  const crowns = blueTowers.filter((tower) => tower.tower_role === "crown").sort((a, b) => a.x - b.x);
  crowns[0].hp = 200;
  blueTowers.find((tower) => tower.tower_role === "king").hp = 90;
  // A three-troop Fireball cluster; Arrows' larger radius also reaches the
  // fourth troop, and the red troop inside the cluster never counts.
  engine.state.entities.push(
    createTroop({ id: "b1", cardId: "knight", team: "blue", x: 9, y: 20 }),
    createTroop({ id: "b2", cardId: "knight", team: "blue", x: 10, y: 20 }),
    createTroop({ id: "b3", cardId: "knight", team: "blue", x: 9, y: 21 }),
    createTroop({ id: "b4", cardId: "knight", team: "blue", x: 14.5, y: 20.5 }),
    createTroop({ id: "r1", cardId: "knight", team: "red", x: 9.5, y: 20.5 }),
  );
  const red = buildEdgerV2Observation({ engine, actor: "red" }).global;
  assert.deepEqual(Array.from(red.slice(96)), [1, 0, 1, 0, 0, 1, 3 / 8, 4 / 8]);
  const blue = buildEdgerV2Observation({ engine, actor: "blue" }).global;
  assert.deepEqual(Array.from(blue.slice(96)), [0, 0, 0, 0, 0, 0, 1 / 8, 1 / 8]);
});

test("the learner's Fireball opportunity constants match the observation layout", () => {
  const source = fs.readFileSync(new URL("../scripts/edger-v2-training.py", import.meta.url), "utf8");
  const constant = (name) => source.match(new RegExp(`^${name} = (.+)$`, "m"))?.[1];
  assert.equal(Number(constant("FIREBALL_CARD_INDEX")), EDGER_V2_CARD_ACTIONS.indexOf("fireball"));
  assert.equal(constant("FIREBALL_LETHAL_GLOBALS"), "(96, 97, 98)");
  assert.equal(Number(constant("FIREBALL_TROOP_HITS_GLOBAL")), 102);
  assert.equal(Number(constant("SPELL_TROOP_HITS_DENOMINATOR")), 8);
  assert.equal(Number(constant("CLUSTER_MINIMUM_TROOP_HITS")), 3);
  // In the spell-globals state above, Fireball and Arrows inputs differ, so
  // these positions are Fireball's: lethal crown and king, three troops.
  const engine = createProductionEngine({ seed: 7105 });
  const blueTowers = engine.state.entities.filter(
    (entity) => entity.entity_type === "tower" && entity.team === "blue",
  );
  blueTowers.filter((tower) => tower.tower_role === "crown").sort((a, b) => a.x - b.x)[0].hp = 200;
  blueTowers.find((tower) => tower.tower_role === "king").hp = 90;
  engine.state.entities.push(
    createTroop({ id: "b1", cardId: "knight", team: "blue", x: 9, y: 20 }),
    createTroop({ id: "b2", cardId: "knight", team: "blue", x: 10, y: 20 }),
    createTroop({ id: "b3", cardId: "knight", team: "blue", x: 9, y: 21 }),
    createTroop({ id: "b4", cardId: "knight", team: "blue", x: 14.5, y: 20.5 }),
  );
  const red = buildEdgerV2Observation({ engine, actor: "red" }).global;
  assert.deepEqual([red[96], red[97], red[98]], [1, 0, 1]);
  assert.equal(red[102] * 8, 3);
});

test("v2 action encoding uses fixed deck, row-major placement, and bounded delay", () => {
  const encoded = encodeEdgerV2Action({
    actor: "red",
    action: {
      type: "PLAY_CARD",
      cardId: "giant",
      x: 3.5,
      y: 4.5,
    },
    delayTicks: 240,
  });
  assert.deepEqual(encoded, {
    card_index: 1,
    placement_index: 4 * 18 + 3,
    delay_index: 199,
  });
  assert.deepEqual(decodeEdgerV2Action({
    actor: "red",
    cardIndex: encoded.card_index,
    placementIndex: encoded.placement_index,
    delayIndex: encoded.delay_index,
  }), {
    action: {
      type: "PLAY_CARD",
      cardId: "giant",
      x: 3.5,
      y: 4.5,
    },
    delayTicks: 200,
  });
});

test("v2 bootstrap inference respects masks and is deterministic", () => {
  const engine = createProductionEngine({ seed: 7102 });
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const observation = buildEdgerV2Observation({ engine, actor: "red" });
  const masks = buildEdgerV2LegalMasks({
    actor: "red",
    legalActions,
    selectedCardIndex: 0,
  });
  const model = validateEdgerV2PolicyModel(createEdgerV2BootstrapModel());
  const first = computeEdgerV2Logits({
    model,
    observation,
    legalMasks: masks,
    forcedCardIndex: 0,
    forcedPlacementIndex: 0,
  });
  const second = computeEdgerV2Logits({
    model,
    observation,
    legalMasks: masks,
    forcedCardIndex: 0,
    forcedPlacementIndex: 0,
  });
  assert.deepEqual(first.selected, second.selected);
  assert.equal(first.selected.card_index, 0);
  assert.equal(first.selected.delay_index, 199);

  const decision = selectEdgerV2PolicyDecision({
    model,
    engine,
    actor: "red",
    legalActions,
  });
  assert.deepEqual(decision.action, { type: "PASS" });
  assert.equal(decision.delayTicks, 200);
});

test("full-grid troop actions match player placement for both sides and unlocked pockets", () => {
  const hand = DEFAULT_DECK.slice(0, 4);
  const cards = { hand, draw_pile: DEFAULT_DECK.slice(4) };
  const model = { action_space_version: EDGER_FULL_GRID_ACTION_SPACE_VERSION };
  for (const actor of ["red", "blue"]) {
    for (const destroyed of [0, 1, 2]) {
      const engine = createProductionEngine({ initialCardState: { red: cards, blue: cards } });
      const { arena, entities } = engine.state;
      const enemyCrowns = entities.filter((entity) =>
        entity.team !== actor && entity.entity_type === "tower" && entity.tower_role === "crown");
      for (const tower of enemyCrowns.slice(0, destroyed)) tower.hp = 0;

      const actions = enumerateLegalCardActions({ engine, actor, model })
        .filter((action) => action.cardId === "giant");
      const expected = [];
      for (let y = 0.5; y < 32; y += 1) {
        for (let x = 0.5; x < 18; x += 1) {
          if (getTroopPlacementStatus({ arena, entities, actor, position: { x, y } }).ok) {
            expected.push(`${x},${y}`);
          }
        }
      }
      assert.deepEqual(actions.map(({ x, y }) => `${x},${y}`).sort(), expected.sort());
      if (destroyed === 0) {
        assert.equal(actions.length, 236);
        assert.equal(enumerateLegalCardActions({ engine, actor })
          .filter((action) => action.cardId === "giant").length, 4);
      } else {
        assert.ok(actions.length > 236);
      }
    }
  }
});

function seededModel() {
  const model = createEdgerV2BootstrapModel();
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const layer of Object.values(model.weights)) {
    const arrays = Array.isArray(layer) ? [layer] : [layer.weights, layer.bias];
    for (const values of arrays) {
      values.forEach((_, index) => { values[index] = (random() - 0.5) * 0.25; });
    }
  }
  return { model, random };
}

test("mean pool accumulates in float64 and rounds once to float32", () => {
  const cells = EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH;
  const channels = 16;
  // Identity convolutions and fusion expose the pooled mean as fused[0..15].
  const model = createEdgerV2BootstrapModel();
  for (const name of ["conv1", "conv2", "conv3"]) {
    const layer = model.weights[name];
    const center = Math.floor(layer.kernel_size / 2);
    for (let channel = 0; channel < channels; channel += 1) {
      layer.weights[
        (((channel * layer.input_channels + channel) * layer.kernel_size + center) *
          layer.kernel_size) +
        center
      ] = 1;
    }
  }
  for (let channel = 0; channel < channels; channel += 1) {
    model.weights.fusion.weights[channel * model.weights.fusion.output_dim + channel] = 1;
  }
  const board = new Float32Array(cells * EDGER_V2_BOARD_CHANNELS);
  for (let cell = 0; cell < cells; cell += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      board[cell * EDGER_V2_BOARD_CHANNELS + channel] =
        1 + ((cell * (channel + 3)) % 997) / 997;
    }
  }
  const { fused } = encodeEdgerV2PolicyState({
    model,
    observation: { board, global: new Float32Array(EDGER_V2_GLOBAL_FEATURES) },
  });

  const expected = [];
  const float32RunningSum = [];
  for (let channel = 0; channel < channels; channel += 1) {
    let sum64 = 0;
    let sum32 = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const value = board[cell * EDGER_V2_BOARD_CHANNELS + channel];
      sum64 += value;
      sum32 = Math.fround(sum32 + value);
    }
    expected.push(Math.fround(sum64 / cells));
    float32RunningSum.push(Math.fround(sum32 / cells));
  }
  assert.deepEqual(Array.from(fused.slice(0, channels)), expected);
  // The input must distinguish the previous float32 running sum.
  assert.notDeepEqual(float32RunningSum, expected);
});

test("sparse-input convolution preserves the original dense-runtime golden logits", () => {
  const { model, random } = seededModel();
  const observation = {
    board: Float32Array.from(
      { length: EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS },
      (_, index) => index % 7 === 0 ? random() : 0,
    ),
    global: Float32Array.from({ length: EDGER_V2_GLOBAL_FEATURES }, random),
  };
  const logits = computeEdgerV2Logits({
    model, observation,
    legalMasks: {
      card: new Uint8Array(9).fill(1),
      placement: new Uint8Array(576).fill(1),
      delay: new Uint8Array(200).fill(1),
    },
    forcedCardIndex: 3,
    forcedPlacementIndex: 77,
  });
  const hash = createHash("sha256");
  for (const head of ["card", "placement", "delay"]) {
    hash.update(Buffer.from(logits[head].buffer));
  }
  // The pre-optimization implementation at 0270d828 gave a397521e… on the v2
  // observation. Re-pinned for the float64 mean pool (87c3a171…) and for the
  // v4 observation, where a copy without the zero-product skip gives this hash.
  assert.equal(hash.digest("hex"), "87ab23d550dbd2796e2604bbed9fb64e60576a4e61665c8f3ff1d7dfcbb3ee21");
});

test("a seeded model's bank and full-match decisions stay pinned", () => {
  const { model } = seededModel();
  const bank = buildCandidateParityFixtures(model).map((fixture) => [
    fixture.id,
    fixture.js.selected.card_index,
    fixture.js.selected.placement_index,
    fixture.js.selected.delay_index,
  ]);
  assert.equal(bank.length, 73);
  assert.equal(new Set(bank.map(([, cardIndex]) => cardIndex)).size, 9);
  const match = runEdgerV2CadenceMatch({
    seed: 20261025,
    candidateActor: "red",
    model,
    cadence: "learned",
    opponentBotId: HEURISTIC_BOT_ID,
    recordRows: true,
  });
  const stream = match.rows.map((row) =>
    [row.tick, row.card_index, row.placement_index, row.delay_index]);
  assert.equal(match.stats.successful_deployments, 22);
  // The float64 mean pool left the v2-observation decisions captured at
  // a3e01e5 unchanged. Re-captured for the v4 observation, which changes the
  // model's inputs.
  assert.equal(
    createHash("sha256").update(JSON.stringify(bank)).digest("hex"),
    "9ec0a3bd6dd9f8b426b023d430d72630e35d5dcd26027fa4e9ebe0644e4a98f0",
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(stream)).digest("hex"),
    "1b9b00f32360d22cd9e6fec7dd2e6ddb7134fe7d99d3aeef0b7c9f76cbbf36c7",
  );
  assert.equal(match.action_stream_hash, "442e2ddc82005d1c1ec6cb12963ac1601b6655848c9a56ec30c7104ce9276da8");
  assert.equal(match.final_state_hash, "5945a9e8");
});
