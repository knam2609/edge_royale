import test from "node:test";
import assert from "node:assert/strict";

import {
  createEnabledLadderModelManifest,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
  normalizeLoadedLadderModelsByTier,
} from "../src/ai/ladderModelManifest.js";
import { createZeroNeuralPolicyModel } from "../src/ai/neuralModel.js";

test("ladder model manifest accepts valid per-tier model config", () => {
  const manifest = normalizeLadderModelManifest({
    version: 1,
    tiers: {
      mid: {
        mode: "model",
        model_path: "artifacts/training/runs/smoke/models/mid-model.json",
      },
      top: {
        mode: "heuristic",
      },
    },
  });

  assert.equal(manifest.warnings.length, 0);
  assert.equal(getConfiguredLadderModelPath(manifest, "mid"), "artifacts/training/runs/smoke/models/mid-model.json");
  assert.equal(getConfiguredLadderModelPath(manifest, "top"), null);
});

test("ladder model manifest rejects invalid tier, mode, and path shapes", () => {
  const manifest = normalizeLadderModelManifest({
    version: 1,
    tiers: {
      god: {
        mode: "model",
        model_path: "artifacts/god.json",
      },
      noob: {
        mode: "banana",
        model_path: "artifacts/noob.json",
      },
      mid: {
        mode: "model",
        model_path: "../outside.json",
      },
      top: {
        mode: "model",
        model_path: "",
      },
    },
  });

  assert.equal(getConfiguredLadderModelPath(manifest, "god"), null);
  assert.equal(getConfiguredLadderModelPath(manifest, "noob"), null);
  assert.equal(getConfiguredLadderModelPath(manifest, "mid"), null);
  assert.equal(getConfiguredLadderModelPath(manifest, "top"), null);
  assert.ok(manifest.warnings.some((warning) => warning.includes("unsupported tier: god")));
  assert.ok(manifest.warnings.some((warning) => warning.includes("tier noob has invalid ladder model mode")));
  assert.ok(manifest.warnings.some((warning) => warning.includes("tier mid has invalid model_path")));
});

test("loaded ladder models require same-tier artifact metadata", () => {
  const manifest = createEnabledLadderModelManifest({
    noob: "artifacts/training/runs/smoke/models/noob-model.json",
  });
  const mismatchedModel = createZeroNeuralPolicyModel({ hiddenUnits: 1, seed: 808 });
  mismatchedModel.training_config.target_tier = "mid";

  const loaded = normalizeLoadedLadderModelsByTier({
    manifest,
    rawModelsByTier: {
      noob: mismatchedModel,
    },
  });

  assert.equal(loaded.modelsByTier.noob, undefined);
  assert.ok(loaded.warnings.some((warning) => warning.includes("tier noob model target is mid")));
});

test("loaded ladder models expose valid same-tier artifacts by tier", () => {
  const manifest = createEnabledLadderModelManifest({
    mid: "artifacts/training/runs/smoke/models/mid-model.json",
  });
  const model = createZeroNeuralPolicyModel({ hiddenUnits: 1, seed: 909 });
  model.training_config.target_tier = "mid";

  const loaded = normalizeLoadedLadderModelsByTier({
    manifest,
    rawModelsByTier: {
      mid: model,
    },
  });

  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.modelsByTier.mid.training_config.target_tier, "mid");
});
