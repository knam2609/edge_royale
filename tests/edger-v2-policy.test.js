import test from "node:test";
import assert from "node:assert/strict";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import {
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  EDGER_V2_GLOBAL_FEATURES,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
  encodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  createEdgerV2BootstrapModel,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";

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
