import test from "node:test";
import assert from "node:assert/strict";

import {
  appendSamples,
  createDecisionSample,
  createEmptyTrainingStore,
  makeBucketKey,
  selectCardFromModel,
  trainSelfModel,
} from "../src/ai/training.js";

test("appendSamples keeps bounded history", () => {
  const store = createEmptyTrainingStore();
  const samples = [
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["giant"], cardId: "giant", tick: 1 }),
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["knight"], cardId: "knight", tick: 2 }),
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["arrows"], cardId: "arrows", tick: 3 }),
  ];

  const updated = appendSamples(store, samples, 2);
  assert.equal(updated.samples.length, 2);
  assert.equal(updated.samples[0].card_id, "knight");
  assert.equal(updated.samples[1].card_id, "arrows");
});

test("trainSelfModel builds phase/elixir buckets", () => {
  const samples = [
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["knight", "giant"], cardId: "knight", tick: 1 }),
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["knight", "giant"], cardId: "knight", tick: 2 }),
    createDecisionSample({ phase: "normal", elixir: 4, hand: ["knight", "giant"], cardId: "giant", tick: 3 }),
  ];

  const model = trainSelfModel(samples, { minSamples: 2 });
  assert.equal(model.ready, true);

  const key = makeBucketKey({ phase: "normal", elixir: 4 });
  assert.equal(model.buckets[key].total, 3);
  assert.equal(model.buckets[key].cards.knight, 2);
  assert.equal(model.buckets[key].cards.giant, 1);
});

test("selectCardFromModel chooses most frequent card in hand", () => {
  const samples = [
    createDecisionSample({ phase: "normal", elixir: 6, hand: ["giant", "mini_pekka"], cardId: "giant", tick: 1 }),
    createDecisionSample({ phase: "normal", elixir: 6, hand: ["giant", "mini_pekka"], cardId: "giant", tick: 2 }),
    createDecisionSample({ phase: "normal", elixir: 6, hand: ["giant", "mini_pekka"], cardId: "mini_pekka", tick: 3 }),
  ];

  const model = trainSelfModel(samples, { minSamples: 1 });
  const selected = selectCardFromModel(model, {
    phase: "normal",
    elixir: 6,
    hand: ["mini_pekka", "giant", "arrows", "knight"],
  });

  assert.equal(selected, "giant");
});
