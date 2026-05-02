import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEnabledLadderModelManifest } from "../src/ai/ladderModelManifest.js";
import { createZeroNeuralPolicyModel } from "../src/ai/neuralModel.js";
import { summarizeComparison } from "../scripts/compare-ladder-models.mjs";
import { promoteLadderModels } from "../scripts/promote-ladder-models.mjs";

function makeMatrix(winRates) {
  return {
    seed: 909,
    rounds_per_pair: 100,
    tiers: ["noob", "mid", "top", "pro", "goat"],
    pairs: [
      { higher_tier: "mid", lower_tier: "noob", win_rate_higher: winRates.mid_noob, draws: 0 },
      { higher_tier: "top", lower_tier: "mid", win_rate_higher: winRates.top_mid, draws: 0 },
      { higher_tier: "pro", lower_tier: "top", win_rate_higher: winRates.pro_top, draws: 0 },
      { higher_tier: "goat", lower_tier: "pro", win_rate_higher: winRates.goat_pro, draws: 0 },
    ],
  };
}

test("daily comparison gate allows balanced improvement", () => {
  const summary = summarizeComparison({
    baselineMatrix: makeMatrix({ mid_noob: 0.5, top_mid: 0.5, pro_top: 0.5, goat_pro: 0.5 }),
    candidateMatrix: makeMatrix({ mid_noob: 0.53, top_mid: 0.52, pro_top: 0.52, goat_pro: 0.53 }),
    baselineModelTiers: ["noob", "mid", "top", "pro", "goat"],
    candidateModelTiers: ["noob", "mid", "top", "pro", "goat"],
    deterministic: true,
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.metrics.average_delta, 0.025);
  assert.equal(summary.metrics.worst_adjacent_delta, 0.02);
});

test("daily comparison gate blocks adjacent regression", () => {
  const summary = summarizeComparison({
    baselineMatrix: makeMatrix({ mid_noob: 0.5, top_mid: 0.5, pro_top: 0.5, goat_pro: 0.5 }),
    candidateMatrix: makeMatrix({ mid_noob: 0.55, top_mid: 0.44, pro_top: 0.6, goat_pro: 0.55 }),
    baselineModelTiers: ["noob", "mid", "top", "pro", "goat"],
    candidateModelTiers: ["noob", "mid", "top", "pro", "goat"],
    deterministic: true,
  });

  assert.equal(summary.passed, false);
  assert.ok(summary.reasons.some((reason) => reason.includes("regressed more than")));
});

test("promoteLadderModels copies valid tier models to stable tracked paths", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "edge-royale-promote-"));
  const modelPath = "run/models/mid-model.json";
  const summaryPath = "run/models/mid-training-summary.json";
  const manifestPath = "run/candidate-ladder-models.json";
  const comparisonPath = "run/comparison-summary.json";
  const outDir = "promoted";
  const manifestOut = "ladder-models.json";
  const summaryOut = "latest-training-summary.json";
  const prBodyOut = "pr-body.md";

  const model = createZeroNeuralPolicyModel({ hiddenUnits: 1, seed: 123 });
  model.training_config.target_tier = "mid";

  await mkdir(join(tmpRoot, "run", "models"), { recursive: true });
  await writeFile(join(tmpRoot, modelPath), `${JSON.stringify(model, null, 2)}\n`, "utf8");
  await writeFile(join(tmpRoot, summaryPath), `${JSON.stringify({ target_tier: "mid" }, null, 2)}\n`, "utf8");
  await writeFile(
    join(tmpRoot, manifestPath),
    `${JSON.stringify(createEnabledLadderModelManifest({ mid: modelPath }), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(tmpRoot, comparisonPath),
    `${JSON.stringify({ passed: true, gate: { metrics: { average_delta: 0.03, worst_adjacent_delta: 0 } } }, null, 2)}\n`,
    "utf8",
  );

  const promoted = await promoteLadderModels({
    candidateManifest: manifestPath,
    comparisonSummary: comparisonPath,
    outDir,
    manifestOut,
    summaryOut,
    prBodyOut,
    runRoot: "run",
    promotedAt: "2026-05-03T00:00:00.000Z",
    cwd: tmpRoot,
  });

  assert.deepEqual(
    promoted.tiers.map((tier) => tier.tier_id),
    ["mid"],
  );

  const promotedManifest = JSON.parse(await readFile(join(tmpRoot, manifestOut), "utf8"));
  assert.equal(promotedManifest.tiers.mid.model_path.endsWith("promoted/models/mid-model.json"), true);

  const promotedSummary = JSON.parse(await readFile(join(tmpRoot, summaryOut), "utf8"));
  assert.equal(promotedSummary.gate_passed, true);
  assert.equal(promotedSummary.tiers[0].training_summary_path.endsWith("promoted/summaries/mid-training-summary.json"), true);

  const prBody = await readFile(join(tmpRoot, prBodyOut), "utf8");
  assert.match(prBody, /Daily ladder model update/);
  assert.match(prBody, /mid/);
});
