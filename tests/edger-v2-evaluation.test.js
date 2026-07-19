import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  EDGER_V2_EVALUATION_PROFILES,
  buildEdgerV2EvaluationSpecs,
  pairedBootstrapLowerBound,
  validateEdgerV2ReferenceReport,
} from "../scripts/edger-v2-evaluation-core.mjs";
import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";

function modelDescriptor(policyId) {
  return {
    kind: "model",
    policy_id: policyId,
    checkpoint_id: policyId,
    model_path: `/tmp/${policyId}.json`,
  };
}

test("full v2 evaluation plan contains both champion blocks and 10,000 repeated safety games", () => {
  const profile = EDGER_V2_EVALUATION_PROFILES.full;
  const specs = buildEdgerV2EvaluationSpecs({
    seed: 7401,
    profile,
    champion: modelDescriptor("champion"),
    heuristic: { kind: "bot", policy_id: "edger_heuristic" },
    anchors: [0, 1, 2, 3].map((index) => modelDescriptor(`anchor_${index}`)),
    weakBaselines: ["random", "aggressive", "defender"].map((policyId) => ({
      kind: "bot",
      policy_id: policyId,
    })),
  });
  const safety = specs.filter((spec) => spec.group === "safety");
  const champion = specs.filter((spec) => spec.group === "champion");

  assert.equal(safety.length, 10_000);
  assert.equal(new Set(safety.map((spec) => spec.repeat_id)).size, 5_000);
  assert.ok(
    [...new Set(safety.map((spec) => spec.repeat_id))].every(
      (repeatId) => safety.filter((spec) => spec.repeat_id === repeatId).length === 2,
    ),
  );
  assert.equal(champion.length, 800);
  assert.equal(champion.filter((spec) => spec.block === "A").length, 400);
  assert.equal(champion.filter((spec) => spec.block === "B").length, 400);
});

test("paired bootstrap lower bound uses whole paired seeds", () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    pair_id: `pair_${Math.floor(index / 2)}`,
    candidate_point: 1,
  }));
  assert.equal(
    pairedBootstrapLowerBound(results, { seed: 7, resamples: 100 }),
    1,
  );
});

test("v2 references are bound to the evaluated champion", () => {
  const reference = {
    schema_version: "edger_v2_reference_report_v1",
    model_id: "champion_a",
    matchups: {},
    frozen_league_mean: 0.5,
  };
  assert.equal(
    validateEdgerV2ReferenceReport(reference, {
      championModelId: "champion_a",
    }),
    reference,
  );
  assert.throws(
    () => validateEdgerV2ReferenceReport(reference, {
      championModelId: "champion_b",
    }),
    /does not match champion/,
  );
});

test("v2 promotion command refuses an incomplete report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-promote-refusal-"));
  const modelPath = path.join(root, "model.json");
  const reportPath = path.join(root, "report.json");
  const model = createEdgerV2BootstrapModel();
  fs.writeFileSync(modelPath, JSON.stringify(model));
  fs.writeFileSync(reportPath, JSON.stringify({
    schema_version: "edger_v2_evaluation_report_v1",
    profile: "smoke",
    candidate_model_id: model.model_id,
    candidate_artifact_checksum: "wrong",
    gates: {},
    promotion: { passed: false, failures: ["not evaluated"] },
  }));
  const result = spawnSync(process.execPath, [
    "scripts/edger-v2-promote.mjs",
    "--model",
    modelPath,
    "--report",
    reportPath,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only a full evaluation profile can be promoted/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("v2 promotion preserves the exact evaluated model bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-promote-copy-"));
  const modelPath = path.join(root, "candidate.json");
  const reportPath = path.join(root, "report.json");
  const model = createEdgerV2BootstrapModel();
  const modelBytes = Buffer.from(JSON.stringify(model));
  fs.writeFileSync(modelPath, modelBytes);
  const checksum = createHash("sha256").update(modelBytes).digest("hex");
  const gateNames = [
    "acceptance_profile",
    "schema_and_size",
    "pytorch_js_parity",
    "champion",
    "anchors",
    "weak_baselines",
    "frozen_league",
    "safety",
    "tactical_scenarios",
    "replay",
    "generated_js_timing",
    "full_test_suite",
    "browser_smoke",
  ];
  fs.writeFileSync(reportPath, JSON.stringify({
    schema_version: "edger_v2_evaluation_report_v1",
    profile: "full",
    candidate_model_id: model.model_id,
    candidate_artifact_checksum: checksum,
    matchups: {},
    frozen_league_mean: 0.5,
    gates: Object.fromEntries(gateNames.map((name) => [name, { passed: true }])),
    promotion: { passed: true, failures: [] },
  }));
  fs.mkdirSync(path.join(root, "src/ai/generated"), { recursive: true });
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/edger-v2-promote.mjs"),
    "--model",
    modelPath,
    "--report",
    reportPath,
  ], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readFileSync(path.join(
      root,
      "artifacts/edger-training/promoted/edger_policy_current.json",
    )),
    modelBytes,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
