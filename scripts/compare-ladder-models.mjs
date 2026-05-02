import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmarkMatrix } from "../src/ai/benchmark.js";
import {
  DEFAULT_LADDER_MODEL_MANIFEST_PATH,
  FAIR_LADDER_MODEL_TIERS,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
  normalizeLoadedLadderModelsByTier,
} from "../src/ai/ladderModelManifest.js";

const DEFAULT_SEED = 909;
const DEFAULT_ROUNDS = 100;
const DEFAULT_MIN_AVERAGE_DELTA = 0.02;
const DEFAULT_BOOTSTRAP_MIN_AVERAGE_DELTA = 0;
const DEFAULT_MAX_ADJACENT_REGRESSION = 0.05;

export const ADJACENT_LADDER_PAIRS = Object.freeze([
  Object.freeze({ higher_tier: "mid", lower_tier: "noob" }),
  Object.freeze({ higher_tier: "top", lower_tier: "mid" }),
  Object.freeze({ higher_tier: "pro", lower_tier: "top" }),
  Object.freeze({ higher_tier: "goat", lower_tier: "pro" }),
]);

function parseArgs(argv) {
  const parsed = {
    baselineManifest: DEFAULT_LADDER_MODEL_MANIFEST_PATH,
    candidateManifest: null,
    out: null,
    tiers: [...FAIR_LADDER_MODEL_TIERS],
    seed: DEFAULT_SEED,
    rounds: DEFAULT_ROUNDS,
    maxTicks: undefined,
    minAverageDelta: DEFAULT_MIN_AVERAGE_DELTA,
    bootstrapMinAverageDelta: DEFAULT_BOOTSTRAP_MIN_AVERAGE_DELTA,
    maxAdjacentRegression: DEFAULT_MAX_ADJACENT_REGRESSION,
    failOnRegression: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline-manifest" && argv[i + 1]) parsed.baselineManifest = argv[++i];
    else if (arg === "--candidate-manifest" && argv[i + 1]) parsed.candidateManifest = argv[++i];
    else if (arg === "--out" && argv[i + 1]) parsed.out = argv[++i];
    else if (arg === "--seed" && argv[i + 1]) parsed.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--rounds" && argv[i + 1]) parsed.rounds = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-ticks" && argv[i + 1]) parsed.maxTicks = Number.parseInt(argv[++i], 10);
    else if (arg === "--min-average-delta" && argv[i + 1]) parsed.minAverageDelta = Number.parseFloat(argv[++i]);
    else if (arg === "--bootstrap-min-average-delta" && argv[i + 1]) {
      parsed.bootstrapMinAverageDelta = Number.parseFloat(argv[++i]);
    } else if (arg === "--max-adjacent-regression" && argv[i + 1]) {
      parsed.maxAdjacentRegression = Number.parseFloat(argv[++i]);
    } else if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
    } else if (arg === "--fail-on-regression") {
      parsed.failOnRegression = true;
    }
  }

  parsed.seed = Number.isFinite(parsed.seed) ? parsed.seed : DEFAULT_SEED;
  parsed.rounds = Number.isFinite(parsed.rounds) && parsed.rounds > 0 ? parsed.rounds : DEFAULT_ROUNDS;
  parsed.maxTicks = Number.isFinite(parsed.maxTicks) && parsed.maxTicks > 0 ? parsed.maxTicks : undefined;
  parsed.minAverageDelta = Number.isFinite(parsed.minAverageDelta)
    ? parsed.minAverageDelta
    : DEFAULT_MIN_AVERAGE_DELTA;
  parsed.bootstrapMinAverageDelta = Number.isFinite(parsed.bootstrapMinAverageDelta)
    ? parsed.bootstrapMinAverageDelta
    : DEFAULT_BOOTSTRAP_MIN_AVERAGE_DELTA;
  parsed.maxAdjacentRegression = Number.isFinite(parsed.maxAdjacentRegression)
    ? parsed.maxAdjacentRegression
    : DEFAULT_MAX_ADJACENT_REGRESSION;
  parsed.tiers = Array.isArray(parsed.tiers) && parsed.tiers.length >= 2 ? parsed.tiers : [...FAIR_LADDER_MODEL_TIERS];

  if (!parsed.candidateManifest) {
    throw new Error("missing --candidate-manifest path");
  }

  return parsed;
}

async function readJsonFile(path) {
  const resolvedPath = resolve(process.cwd(), path);
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    return {
      value: null,
      warning: `could not read ${path}: ${error.message}`,
    };
  }
}

async function loadModelsFromManifest(manifestPath) {
  const rawManifestResult = await readJsonFile(manifestPath);
  const warnings = [];
  const rawManifest = rawManifestResult?.value === null ? null : rawManifestResult;
  if (rawManifestResult?.warning) {
    warnings.push(rawManifestResult.warning);
  }

  const manifest = normalizeLadderModelManifest(rawManifest);
  warnings.push(...manifest.warnings);

  const rawModelsByTier = {};
  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const modelPath = getConfiguredLadderModelPath(manifest, tierId);
    if (!modelPath) {
      continue;
    }

    const rawModelResult = await readJsonFile(modelPath);
    if (rawModelResult?.warning) {
      warnings.push(`tier ${tierId}: ${rawModelResult.warning}`);
      continue;
    }
    rawModelsByTier[tierId] = rawModelResult;
  }

  const loaded = normalizeLoadedLadderModelsByTier({ manifest, rawModelsByTier });
  warnings.push(...loaded.warnings);

  return {
    manifest_path: manifestPath,
    manifest: loaded.manifest,
    models_by_tier: loaded.modelsByTier,
    model_tiers: Object.keys(loaded.modelsByTier),
    warnings,
  };
}

function pairKey(pair) {
  return `${pair.higher_tier}>${pair.lower_tier}`;
}

function makePairMap(matrix) {
  const pairs = new Map();
  for (const pair of Array.isArray(matrix?.pairs) ? matrix.pairs : []) {
    pairs.set(pairKey(pair), pair);
  }
  return pairs;
}

function roundMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function summarizeDeltas({ baselineMatrix, candidateMatrix }) {
  const baselinePairs = makePairMap(baselineMatrix);
  const deltas = [];

  for (const candidatePair of Array.isArray(candidateMatrix?.pairs) ? candidateMatrix.pairs : []) {
    const baselinePair = baselinePairs.get(pairKey(candidatePair));
    if (!baselinePair) {
      continue;
    }

    const delta = candidatePair.win_rate_higher - baselinePair.win_rate_higher;
    deltas.push({
      higher_tier: candidatePair.higher_tier,
      lower_tier: candidatePair.lower_tier,
      baseline_win_rate_higher: roundMetric(baselinePair.win_rate_higher),
      candidate_win_rate_higher: roundMetric(candidatePair.win_rate_higher),
      delta: roundMetric(delta),
      candidate_draws: candidatePair.draws,
      baseline_draws: baselinePair.draws,
    });
  }

  return deltas;
}

function isAdjacentDelta(delta) {
  return ADJACENT_LADDER_PAIRS.some(
    (pair) => pair.higher_tier === delta.higher_tier && pair.lower_tier === delta.lower_tier,
  );
}

export function summarizeComparison({
  baselineMatrix,
  candidateMatrix,
  baselineModelTiers = [],
  candidateModelTiers = [],
  requiredModelTiers = [...FAIR_LADDER_MODEL_TIERS],
  deterministic = true,
  minAverageDelta = DEFAULT_MIN_AVERAGE_DELTA,
  bootstrapMinAverageDelta = DEFAULT_BOOTSTRAP_MIN_AVERAGE_DELTA,
  maxAdjacentRegression = DEFAULT_MAX_ADJACENT_REGRESSION,
} = {}) {
  const deltas = summarizeDeltas({ baselineMatrix, candidateMatrix });
  const adjacentDeltas = deltas.filter(isAdjacentDelta);
  const averageDelta =
    deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta.delta, 0) / deltas.length : Number.NEGATIVE_INFINITY;
  const worstAdjacentDelta =
    adjacentDeltas.length > 0
      ? adjacentDeltas.reduce((worst, delta) => Math.min(worst, delta.delta), Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const bootstrap = baselineModelTiers.length === 0;
  const effectiveMinAverageDelta = bootstrap ? bootstrapMinAverageDelta : minAverageDelta;
  const reasons = [];
  const candidateTierSet = new Set(candidateModelTiers);
  const missingRequiredTiers = requiredModelTiers.filter((tierId) => !candidateTierSet.has(tierId));

  if (!deterministic) {
    reasons.push("candidate benchmark matrix is not deterministic");
  }
  if (missingRequiredTiers.length > 0) {
    reasons.push(`candidate manifest missing valid same-tier models: ${missingRequiredTiers.join(",")}`);
  }
  if (deltas.length === 0) {
    reasons.push("no benchmark pairs were compared");
  }
  if (averageDelta < effectiveMinAverageDelta) {
    reasons.push(
      `average win-rate delta ${roundMetric(averageDelta)} is below required ${effectiveMinAverageDelta}`,
    );
  }
  if (worstAdjacentDelta < -maxAdjacentRegression) {
    reasons.push(
      `worst adjacent delta ${roundMetric(worstAdjacentDelta)} regressed more than ${maxAdjacentRegression}`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
    bootstrap,
    deterministic,
    thresholds: {
      min_average_delta: minAverageDelta,
      bootstrap_min_average_delta: bootstrapMinAverageDelta,
      effective_min_average_delta: effectiveMinAverageDelta,
      max_adjacent_regression: maxAdjacentRegression,
      required_model_tiers: requiredModelTiers,
    },
    metrics: {
      compared_pairs: deltas.length,
      average_delta: roundMetric(averageDelta),
      worst_adjacent_delta: roundMetric(worstAdjacentDelta),
    },
    deltas,
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

export async function compareLadderModels(args) {
  const baseline = await loadModelsFromManifest(args.baselineManifest);
  const candidate = await loadModelsFromManifest(args.candidateManifest);
  const matrixConfig = {
    tiers: args.tiers,
    seed: args.seed,
    roundsPerPair: args.rounds,
    maxTicks: args.maxTicks,
  };
  const baselineMatrix = runBenchmarkMatrix({
    ...matrixConfig,
    trainedModelsByTier: baseline.models_by_tier,
  });
  const candidateMatrix = runBenchmarkMatrix({
    ...matrixConfig,
    trainedModelsByTier: candidate.models_by_tier,
  });
  const candidateMatrixRepeat = runBenchmarkMatrix({
    ...matrixConfig,
    trainedModelsByTier: candidate.models_by_tier,
  });
  const gate = summarizeComparison({
    baselineMatrix,
    candidateMatrix,
    baselineModelTiers: baseline.model_tiers,
    candidateModelTiers: candidate.model_tiers,
    requiredModelTiers: args.tiers.filter((tierId) => FAIR_LADDER_MODEL_TIERS.includes(tierId)),
    deterministic: stableJson(candidateMatrix) === stableJson(candidateMatrixRepeat),
    minAverageDelta: args.minAverageDelta,
    bootstrapMinAverageDelta: args.bootstrapMinAverageDelta,
    maxAdjacentRegression: args.maxAdjacentRegression,
  });

  return {
    version: 1,
    passed: gate.passed,
    generated_at: new Date().toISOString(),
    config: {
      seed: args.seed,
      rounds: args.rounds,
      max_ticks: args.maxTicks ?? null,
      tiers: args.tiers,
    },
    baseline: {
      manifest_path: args.baselineManifest,
      model_tiers: baseline.model_tiers,
      warnings: baseline.warnings,
      matrix: baselineMatrix,
    },
    candidate: {
      manifest_path: args.candidateManifest,
      model_tiers: candidate.model_tiers,
      warnings: candidate.warnings,
      matrix: candidateMatrix,
    },
    gate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await compareLadderModels(args);

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`comparison_summary=${args.out}`);
  }

  console.log(`comparison_passed=${summary.passed ? "true" : "false"}`);
  console.log(`candidate_model_tiers=${summary.candidate.model_tiers.join(",") || "none"}`);
  console.log(`average_delta=${summary.gate.metrics.average_delta}`);
  console.log(`worst_adjacent_delta=${summary.gate.metrics.worst_adjacent_delta}`);
  for (const reason of summary.gate.reasons) {
    console.log(`gate_reason=${reason}`);
  }

  if (args.failOnRegression && !summary.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
