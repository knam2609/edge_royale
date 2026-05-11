import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEnabledLadderModelManifest } from "../src/ai/ladderModelManifest.js";
import {
  STRICT_FAIR_ADJACENT_PAIRS,
  STRICT_FAIR_GATE_THRESHOLDS,
  strictFairPairKey,
} from "../src/ai/strictFairGateConfig.js";
import { createZeroNeuralPolicyModel } from "../src/ai/neuralModel.js";
import {
  calibrateStrictFairGate,
  runStrictFairLadderGate,
  summarizeStrictFairGate,
} from "../scripts/strict-ladder-gate.mjs";

const FAIR_TIERS = ["noob", "mid", "top", "pro", "goat"];

function makePairSummary({
  higher_tier,
  lower_tier,
  mean_win_rate_higher,
  mean_resolved_rate = 0.8,
  win_rate_stddev = 0.03,
}) {
  return {
    higher_tier,
    lower_tier,
    pair_key: strictFairPairKey({ higher_tier, lower_tier }),
    batches: [],
    totals: {
      wins_higher: 0,
      wins_lower: 0,
      draws: 0,
      resolved: 0,
      rounds: 0,
    },
    mean_win_rate_higher,
    mean_resolved_rate,
    win_rate_stddev,
    resolved_rate_stddev: 0.01,
  };
}

function makePairSet(valuesByKey) {
  return STRICT_FAIR_ADJACENT_PAIRS.map((pair) =>
    makePairSummary({
      higher_tier: pair.higher_tier,
      lower_tier: pair.lower_tier,
      ...valuesByKey[strictFairPairKey(pair)],
    }),
  );
}

async function writeFairManifest(root, folderName) {
  const manifestPath = `${folderName}/manifest.json`;
  const manifestModels = {};
  await mkdir(join(root, folderName, "models"), { recursive: true });

  for (const tierId of FAIR_TIERS) {
    const model = createZeroNeuralPolicyModel({ hiddenUnits: 1, seed: 42, targetTier: tierId });
    const modelPath = `${folderName}/models/${tierId}-model.json`;
    await writeFile(join(root, modelPath), `${JSON.stringify(model, null, 2)}\n`, "utf8");
    manifestModels[tierId] = modelPath;
  }

  await writeFile(
    join(root, manifestPath),
    `${JSON.stringify(createEnabledLadderModelManifest(manifestModels), null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

test("strict gate passes when all adjacent pairs clear calibrated thresholds", () => {
  const baselinePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.71 },
    "top>mid": { mean_win_rate_higher: 0.68 },
    "pro>top": { mean_win_rate_higher: 0.53 },
    "goat>pro": { mean_win_rate_higher: 0.53 },
  });
  const candidatePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.75 },
    "top>mid": { mean_win_rate_higher: 0.7 },
    "pro>top": { mean_win_rate_higher: 0.56 },
    "goat>pro": { mean_win_rate_higher: 0.55 },
  });

  const summary = summarizeStrictFairGate({
    baselineModelTiers: FAIR_TIERS,
    candidateModelTiers: FAIR_TIERS,
    baselinePairs,
    candidatePairs,
    thresholds: STRICT_FAIR_GATE_THRESHOLDS,
    deterministic: true,
  });

  assert.equal(summary.gate.passed, true);
  assert.equal(summary.gate.metrics.failing_pairs, 0);
});

test("strict gate blocks adjacent pair under threshold", () => {
  const baselinePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.71 },
    "top>mid": { mean_win_rate_higher: 0.68 },
    "pro>top": { mean_win_rate_higher: 0.53 },
    "goat>pro": { mean_win_rate_higher: 0.53 },
  });
  const candidatePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.75 },
    "top>mid": { mean_win_rate_higher: 0.6 },
    "pro>top": { mean_win_rate_higher: 0.56 },
    "goat>pro": { mean_win_rate_higher: 0.55 },
  });

  const summary = summarizeStrictFairGate({
    baselineModelTiers: FAIR_TIERS,
    candidateModelTiers: FAIR_TIERS,
    baselinePairs,
    candidatePairs,
    thresholds: STRICT_FAIR_GATE_THRESHOLDS,
    deterministic: true,
  });

  assert.equal(summary.gate.passed, false);
  assert.ok(summary.gate.reasons.some((reason) => reason.includes("top>mid mean win rate")));
});

test("strict gate blocks low resolved rate even with high win rate", () => {
  const baselinePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.71 },
    "top>mid": { mean_win_rate_higher: 0.68 },
    "pro>top": { mean_win_rate_higher: 0.53 },
    "goat>pro": { mean_win_rate_higher: 0.53 },
  });
  const candidatePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.75, mean_resolved_rate: 0.7 },
    "top>mid": { mean_win_rate_higher: 0.7 },
    "pro>top": { mean_win_rate_higher: 0.56 },
    "goat>pro": { mean_win_rate_higher: 0.55 },
  });

  const summary = summarizeStrictFairGate({
    baselineModelTiers: FAIR_TIERS,
    candidateModelTiers: FAIR_TIERS,
    baselinePairs,
    candidatePairs,
    thresholds: STRICT_FAIR_GATE_THRESHOLDS,
    deterministic: true,
  });

  assert.equal(summary.gate.passed, false);
  assert.ok(summary.gate.reasons.some((reason) => reason.includes("mean resolved rate")));
});

test("strict gate blocks baseline regression beyond tolerance", () => {
  const baselinePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.79 },
    "top>mid": { mean_win_rate_higher: 0.7 },
    "pro>top": { mean_win_rate_higher: 0.53 },
    "goat>pro": { mean_win_rate_higher: 0.53 },
  });
  const candidatePairs = makePairSet({
    "mid>noob": { mean_win_rate_higher: 0.73 },
    "top>mid": { mean_win_rate_higher: 0.7 },
    "pro>top": { mean_win_rate_higher: 0.56 },
    "goat>pro": { mean_win_rate_higher: 0.55 },
  });

  const summary = summarizeStrictFairGate({
    baselineModelTiers: FAIR_TIERS,
    candidateModelTiers: FAIR_TIERS,
    baselinePairs,
    candidatePairs,
    thresholds: STRICT_FAIR_GATE_THRESHOLDS,
    deterministic: true,
  });

  assert.equal(summary.gate.passed, false);
  assert.ok(summary.gate.reasons.some((reason) => reason.includes("win-rate delta")));
});

test("strict ladder gate runtime output is deterministic for fixed config", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "edge-royale-strict-gate-"));
  const manifestPath = await writeFairManifest(tmpRoot, "baseline");

  const first = await runStrictFairLadderGate({
    baselineManifest: manifestPath,
    candidateManifest: manifestPath,
    seedBase: 1909,
    batches: 1,
    rounds: 1,
    maxTicks: 40,
  });
  const second = await runStrictFairLadderGate({
    baselineManifest: manifestPath,
    candidateManifest: manifestPath,
    seedBase: 1909,
    batches: 1,
    rounds: 1,
    maxTicks: 40,
  });

  assert.deepEqual(first.batches, second.batches);
  assert.deepEqual(first.pairs, second.pairs);
  assert.deepEqual(first.gate, second.gate);
});

test("strict calibration produces threshold recommendations for all adjacent fair pairs", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "edge-royale-strict-calibration-"));
  const baselineManifest = await writeFairManifest(tmpRoot, "baseline");
  const candidateManifest = await writeFairManifest(tmpRoot, "candidate");

  const summary = await calibrateStrictFairGate({
    manifestPaths: [baselineManifest, candidateManifest],
    seedBase: 1909,
    batches: 1,
    rounds: 1,
    maxTicks: 40,
  });

  assert.deepEqual(
    Object.keys(summary.recommended_thresholds.pair_thresholds).sort(),
    STRICT_FAIR_ADJACENT_PAIRS.map((pair) => strictFairPairKey(pair)).sort(),
  );
  assert.equal(summary.recommended_thresholds.min_resolved_rate >= 0.75, true);
});

test("workflow split keeps fair promotion out of daily lane and adds strict manual lane", async () => {
  const dailyWorkflow = await readFile(".github/workflows/daily-ladder-training.yml", "utf8");
  const strictWorkflow = await readFile(".github/workflows/strict-fair-ladder-promotion.yml", "utf8");

  assert.match(dailyWorkflow, /Promote passing God candidate/);
  assert.match(dailyWorkflow, /--promote-god/);
  assert.doesNotMatch(dailyWorkflow, /--promote-fair/);

  assert.match(strictWorkflow, /workflow_dispatch/);
  assert.match(strictWorkflow, /gh run download/);
  assert.match(strictWorkflow, /strict-ladder-gate\.mjs/);
  assert.match(strictWorkflow, /--promote-fair/);
  assert.match(strictWorkflow, /RUN_ROOT:\s*artifacts\/training\/runs\/daily-\$\{\{\s*github\.event\.inputs\.source_run_id\s*\}\}/);
  assert.doesNotMatch(strictWorkflow, /artifacts\/training\/runs\/strict-\$\{\{\s*github\.event\.inputs\.source_run_id\s*\}\}/);
});
