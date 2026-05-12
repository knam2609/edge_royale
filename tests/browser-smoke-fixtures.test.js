import test from "node:test";
import assert from "node:assert/strict";

import { buildBrowserSmokeFixtures } from "../scripts/browser-smoke-fixtures.mjs";
import { getSelfTrainingStatus } from "../src/ai/training.js";

const fixtures = buildBrowserSmokeFixtures();

test("browser smoke under-threshold fixture stays below first training gate", () => {
  const status = getSelfTrainingStatus(fixtures.underThreshold.trainingStore.samples);

  assert.equal(fixtures.underThreshold.trainingStore.version, 2);
  assert.equal(fixtures.underThreshold.trainingStore.samples.length, 119);
  assert.equal(status.reason, "not_enough_samples");
  assert.equal(status.ready_to_train, false);
});

test("browser smoke accepted fixture stays on RL accepted branch", () => {
  assert.equal(fixtures.rlAccepted.trainingStore.version, 2);
  assert.ok(fixtures.rlAccepted.trainingStore.samples.length >= 128);
  assert.equal(fixtures.rlAccepted.result.accepted, true);
  assert.equal(fixtures.rlAccepted.result.reason, "accepted");
  assert.equal(fixtures.rlAccepted.result.model.ready, true);
});

test("browser smoke alternate RL fixture stays ready and deterministic", () => {
  assert.equal(fixtures.rlFallback.trainingStore.version, 2);
  assert.equal(
    fixtures.rlFallback.trainingStore.samples.length,
    fixtures.rlAccepted.trainingStore.samples.length,
  );
  assert.equal(fixtures.rlFallback.result.model.ready, true);
  assert.ok(["accepted", "style_regression", "win_regression"].includes(fixtures.rlFallback.result.reason));
});

test("browser smoke self runtime fixture preloads unlocked self tier with ready model", () => {
  assert.equal(fixtures.selfRuntime.profile.selected_tier, "self");
  assert.ok(fixtures.selfRuntime.profile.unlocked_tiers.includes("self"));
  assert.equal(fixtures.selfRuntime.selfModel.ready, true);
  assert.equal(fixtures.selfRuntime.selfModel.training_config.target_tier, "self");
});
