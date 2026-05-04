import test from "node:test";
import assert from "node:assert/strict";

import {
  appendSamples,
  createDecisionSample,
  createEmptyTrainingStore,
  getSelfTrainingStatus,
  selectActionFromSelfModel,
  trainSelfModel,
} from "../src/ai/training.js";
import { enumerateLegalCardActions } from "../src/ai/ladderRuntime.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";
import { getTowerStats } from "../src/sim/stats.js";

function makeEngine() {
  const crownHp = getTowerStats("crown").hp;
  return createEngine({
    seed: 701,
    arena: createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
    ],
    initialCardState: {
      blue: {
        hand: ["knight", "giant", "arrows", "fireball"],
        draw_pile: ["archers", "mini_pekka", "musketeer", "goblins"],
      },
      red: {
        hand: ["giant", "knight", "arrows", "fireball"],
        draw_pile: ["archers", "mini_pekka", "musketeer", "goblins"],
      },
    },
  });
}

function makePlayerSample(engine, cardId, tick = 1) {
  const legalActions = enumerateLegalCardActions({ engine, actor: "blue" });
  const chosenAction = legalActions.find((action) => action.cardId === cardId);
  assert.ok(chosenAction);
  return createDecisionSample({
    engine,
    actor: "blue",
    legalActions,
    chosenAction,
    tick,
    sourceTier: "top",
  });
}

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

test("createDecisionSample records public legal-action candidates", () => {
  const engine = makeEngine();
  const sample = makePlayerSample(engine, "knight");

  assert.equal(sample.kind, "legal_action_decision");
  assert.equal(sample.card_id, "knight");
  assert.ok(sample.observation.vector.length > 0);
  assert.ok(sample.legal_actions.length > 0);
  assert.ok(sample.chosen_action_index >= 0);
  assert.ok(sample.legal_actions.some((candidate) => candidate.action.card_id === "knight"));
});

test("createDecisionSample keeps legal player placement when candidate subset misses it", () => {
  const engine = makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: "blue" });
  const chosenAction = { type: "PLAY_CARD", cardId: "arrows", x: 9.5, y: 16.5 };
  const sample = createDecisionSample({
    engine,
    actor: "blue",
    legalActions: legalActions.filter((action) => action.cardId !== "arrows"),
    chosenAction,
    tick: 1,
  });

  assert.equal(sample.chosen_action.card_id, "arrows");
  assert.equal(sample.chosen_action_index, sample.legal_actions.length - 1);
  assert.ok(sample.legal_actions.some((candidate) => candidate.action.card_id === "arrows"));
});

test("trainSelfModel builds deterministic legal-action scorer", () => {
  const engine = makeEngine();
  const samples = [
    makePlayerSample(engine, "knight", 1),
    makePlayerSample(engine, "knight", 2),
    makePlayerSample(engine, "giant", 3),
  ];

  const model = trainSelfModel(samples, { minSamples: 2 });
  assert.equal(model.ready, true);
  assert.equal(model.kind, "legal_action_mlp");
  assert.equal(model.training_config.target_tier, "self");
  assert.equal(model.sample_count, 3);

  const legalActions = enumerateLegalCardActions({ engine, actor: "blue" });
  const selected = selectActionFromSelfModel(model, {
    engine,
    actor: "blue",
    legalActions: legalActions.filter((action) => action.cardId === "knight" || action.cardId === "giant"),
  });

  assert.equal(selected.cardId, "knight");
});

test("self training status waits for enough new samples before retrain", () => {
  const engine = makeEngine();
  const samples = Array.from({ length: 3 }, (_, index) => makePlayerSample(engine, "knight", index + 1));
  const model = trainSelfModel(samples, { minSamples: 1 });
  const status = getSelfTrainingStatus(samples, {
    currentModel: model,
    minSamples: 1,
    minNewSamples: 2,
  });

  assert.equal(status.ready_to_train, false);
  assert.equal(status.reason, "not_enough_new_samples");
  assert.equal(status.new_sample_count, 0);
});
