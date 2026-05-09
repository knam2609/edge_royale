import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmark } from "../src/ai/benchmark.js";
import { createRng } from "../src/sim/random.js";
import {
  DEFAULT_LADDER_MODEL_MANIFEST_PATH,
  FAIR_LADDER_MODEL_TIERS,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
  normalizeLoadedLadderModelsByTier,
} from "../src/ai/ladderModelManifest.js";
import {
  STRICT_FAIR_ADJACENT_PAIRS,
  STRICT_FAIR_GATE_DEFAULT_BATCHES,
  STRICT_FAIR_GATE_DEFAULT_MAX_TICKS,
  STRICT_FAIR_GATE_DEFAULT_ROUNDS,
  STRICT_FAIR_GATE_DEFAULT_SEED_BASE,
  STRICT_FAIR_GATE_THRESHOLDS,
  STRICT_FAIR_GATE_VERSION,
  getStrictFairPairThreshold,
  strictFairPairKey,
} from "../src/ai/strictFairGateConfig.js";

function parseArgs(argv) {
  const parsed = {
    baselineManifest: DEFAULT_LADDER_MODEL_MANIFEST_PATH,
    candidateManifest: null,
    out: null,
    seedBase: STRICT_FAIR_GATE_DEFAULT_SEED_BASE,
    batches: STRICT_FAIR_GATE_DEFAULT_BATCHES,
    rounds: STRICT_FAIR_GATE_DEFAULT_ROUNDS,
    maxTicks: STRICT_FAIR_GATE_DEFAULT_MAX_TICKS,
    tiers: [...FAIR_LADDER_MODEL_TIERS],
    calibrationManifests: [],
    calibrate: false,
    failOnRegression: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline-manifest" && argv[i + 1]) parsed.baselineManifest = argv[++i];
    else if (arg === "--candidate-manifest" && argv[i + 1]) parsed.candidateManifest = argv[++i];
    else if (arg === "--out" && argv[i + 1]) parsed.out = argv[++i];
    else if (arg === "--seed-base" && argv[i + 1]) parsed.seedBase = Number.parseInt(argv[++i], 10);
    else if (arg === "--batches" && argv[i + 1]) parsed.batches = Number.parseInt(argv[++i], 10);
    else if (arg === "--rounds" && argv[i + 1]) parsed.rounds = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-ticks" && argv[i + 1]) parsed.maxTicks = Number.parseInt(argv[++i], 10);
    else if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier, index, values) => tier.length > 0 && values.indexOf(tier) === index);
    } else if (arg === "--calibration-manifest" && argv[i + 1]) {
      parsed.calibrationManifests.push(argv[++i]);
    } else if (arg === "--calibrate") {
      parsed.calibrate = true;
    } else if (arg === "--fail-on-regression") {
      parsed.failOnRegression = true;
    }
  }

  parsed.seedBase = Number.isFinite(parsed.seedBase) ? parsed.seedBase : STRICT_FAIR_GATE_DEFAULT_SEED_BASE;
  parsed.batches = Number.isFinite(parsed.batches) && parsed.batches > 0 ? parsed.batches : STRICT_FAIR_GATE_DEFAULT_BATCHES;
  parsed.rounds = Number.isFinite(parsed.rounds) && parsed.rounds > 0 ? parsed.rounds : STRICT_FAIR_GATE_DEFAULT_ROUNDS;
  parsed.maxTicks = Number.isFinite(parsed.maxTicks) && parsed.maxTicks > 0 ? parsed.maxTicks : STRICT_FAIR_GATE_DEFAULT_MAX_TICKS;
  parsed.tiers =
    Array.isArray(parsed.tiers) && parsed.tiers.length >= 2 ? parsed.tiers : [...FAIR_LADDER_MODEL_TIERS];

  if (!parsed.candidateManifest && !parsed.calibrate) {
    throw new Error("missing --candidate-manifest path");
  }

  if (parsed.calibrate && parsed.calibrationManifests.length === 0) {
    parsed.calibrationManifests = [parsed.baselineManifest];
    if (parsed.candidateManifest) {
      parsed.calibrationManifests.push(parsed.candidateManifest);
    }
  }

  return parsed;
}

function roundMetric(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function roundThreshold(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function pairMatchesAllowedTiers(pair, tiers) {
  return Array.isArray(tiers) && tiers.includes(pair.higher_tier) && tiers.includes(pair.lower_tier);
}

function pickAdjacentPairs(tiers) {
  return STRICT_FAIR_ADJACENT_PAIRS.filter((pair) => pairMatchesAllowedTiers(pair, tiers));
}

function getMean(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getStddev(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const mean = getMean(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function stableJson(value) {
  return JSON.stringify(value);
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

  const loaded = normalizeLoadedLadderModelsByTier({
    manifest,
    rawModelsByTier,
    tiers: FAIR_LADDER_MODEL_TIERS,
  });
  warnings.push(...loaded.warnings);

  return {
    manifest_path: manifestPath,
    manifest: loaded.manifest,
    models_by_tier: loaded.modelsByTier,
    model_tiers: Object.keys(loaded.modelsByTier),
    warnings,
  };
}

function buildBatchSeeds({ seedBase, pairs, batches }) {
  const rng = createRng(seedBase);
  const seedGrid = [];
  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    const pairSeeds = [];
    for (const pair of pairs) {
      pairSeeds.push({
        higher_tier: pair.higher_tier,
        lower_tier: pair.lower_tier,
        seed: 1 + Math.floor(rng() * 2_000_000_000),
      });
    }
    seedGrid.push({
      batch_index: batchIndex,
      pairs: pairSeeds,
    });
  }
  return seedGrid;
}

function benchmarkPairBatches({ loadedManifest, seedGrid, rounds, maxTicks }) {
  const pairBatchMap = new Map();
  const batches = [];

  for (const batch of seedGrid) {
    const pairResults = [];
    for (const pairSeed of batch.pairs) {
      const benchmark = runBenchmark({
        botA: pairSeed.higher_tier,
        botB: pairSeed.lower_tier,
        seed: pairSeed.seed,
        rounds,
        maxTicks,
        trainedModelA: loadedManifest.models_by_tier[pairSeed.higher_tier] ?? null,
        trainedModelB: loadedManifest.models_by_tier[pairSeed.lower_tier] ?? null,
      });
      const result = {
        higher_tier: pairSeed.higher_tier,
        lower_tier: pairSeed.lower_tier,
        pair_key: strictFairPairKey(pairSeed),
        seed: pairSeed.seed,
        rounds: benchmark.rounds,
        wins_higher: benchmark.winsA,
        wins_lower: benchmark.winsB,
        draws: benchmark.draws,
        resolved: benchmark.resolved,
        win_rate_higher: roundMetric(benchmark.winRateA),
        resolved_rate: roundMetric(benchmark.rounds > 0 ? benchmark.resolved / benchmark.rounds : 0),
      };
      pairResults.push(result);

      const key = strictFairPairKey(pairSeed);
      const existing = pairBatchMap.get(key) ?? [];
      existing.push(result);
      pairBatchMap.set(key, existing);
    }

    batches.push({
      batch_index: batch.batch_index,
      pairs: pairResults,
    });
  }

  return {
    batches,
    pair_batch_map: pairBatchMap,
  };
}

function summarizePairResults({ pair, pairResults = [] }) {
  const winRates = pairResults.map((result) => result.win_rate_higher);
  const resolvedRates = pairResults.map((result) => result.resolved_rate);
  const totals = pairResults.reduce(
    (sum, result) => {
      sum.wins_higher += result.wins_higher;
      sum.wins_lower += result.wins_lower;
      sum.draws += result.draws;
      sum.resolved += result.resolved;
      sum.rounds += result.rounds;
      return sum;
    },
    { wins_higher: 0, wins_lower: 0, draws: 0, resolved: 0, rounds: 0 },
  );

  return {
    higher_tier: pair.higher_tier,
    lower_tier: pair.lower_tier,
    pair_key: strictFairPairKey(pair),
    batches: pairResults.map((result) => ({
      batch_index: result.batch_index ?? null,
      seed: result.seed,
      rounds: result.rounds,
      wins_higher: result.wins_higher,
      wins_lower: result.wins_lower,
      draws: result.draws,
      resolved: result.resolved,
      win_rate_higher: result.win_rate_higher,
      resolved_rate: result.resolved_rate,
    })),
    totals,
    mean_win_rate_higher: roundMetric(getMean(winRates)),
    mean_resolved_rate: roundMetric(getMean(resolvedRates)),
    win_rate_stddev: roundMetric(getStddev(winRates)),
    resolved_rate_stddev: roundMetric(getStddev(resolvedRates)),
  };
}

function attachBatchIndices(pairBatchMap, batchGrid) {
  for (const batch of batchGrid) {
    for (const pairSeed of batch.pairs) {
      const key = strictFairPairKey(pairSeed);
      const results = pairBatchMap.get(key) ?? [];
      const match = results.find((result) => result.seed === pairSeed.seed && result.batch_index === undefined);
      if (match) {
        match.batch_index = batch.batch_index;
      }
    }
  }
}

function evaluatePairGate({ pair, candidatePair, baselinePair, thresholds }) {
  const pairThreshold = getStrictFairPairThreshold(pair);
  const reasons = [];

  if (!pairThreshold) {
    reasons.push(`missing strict threshold for ${strictFairPairKey(pair)}`);
  }

  const winRateDelta =
    candidatePair?.mean_win_rate_higher !== null && baselinePair?.mean_win_rate_higher !== null
      ? candidatePair.mean_win_rate_higher - baselinePair.mean_win_rate_higher
      : null;
  const resolvedRateDelta =
    candidatePair?.mean_resolved_rate !== null && baselinePair?.mean_resolved_rate !== null
      ? candidatePair.mean_resolved_rate - baselinePair.mean_resolved_rate
      : null;

  if (!candidatePair) {
    reasons.push(`missing candidate results for ${strictFairPairKey(pair)}`);
  } else {
    if (
      pairThreshold &&
      candidatePair.mean_win_rate_higher !== null &&
      candidatePair.mean_win_rate_higher < pairThreshold.min_win_rate
    ) {
      reasons.push(
        `${strictFairPairKey(pair)} mean win rate ${candidatePair.mean_win_rate_higher} is below required ${pairThreshold.min_win_rate}`,
      );
    }
    if (
      candidatePair.mean_resolved_rate !== null &&
      candidatePair.mean_resolved_rate < thresholds.min_resolved_rate
    ) {
      reasons.push(
        `${strictFairPairKey(pair)} mean resolved rate ${candidatePair.mean_resolved_rate} is below required ${thresholds.min_resolved_rate}`,
      );
    }
    if (
      candidatePair.win_rate_stddev !== null &&
      candidatePair.win_rate_stddev > thresholds.max_win_rate_stddev
    ) {
      reasons.push(
        `${strictFairPairKey(pair)} win-rate stddev ${candidatePair.win_rate_stddev} is above allowed ${thresholds.max_win_rate_stddev}`,
      );
    }
  }

  if (!baselinePair) {
    reasons.push(`missing baseline results for ${strictFairPairKey(pair)}`);
  } else {
    if (winRateDelta !== null && winRateDelta < -thresholds.max_pair_regression) {
      reasons.push(
        `${strictFairPairKey(pair)} win-rate delta ${roundMetric(winRateDelta)} regressed more than ${thresholds.max_pair_regression}`,
      );
    }
    if (resolvedRateDelta !== null && resolvedRateDelta < -thresholds.max_resolved_rate_regression) {
      reasons.push(
        `${strictFairPairKey(pair)} resolved-rate delta ${roundMetric(resolvedRateDelta)} regressed more than ${thresholds.max_resolved_rate_regression}`,
      );
    }
  }

  return {
    higher_tier: pair.higher_tier,
    lower_tier: pair.lower_tier,
    pair_key: strictFairPairKey(pair),
    threshold: {
      min_win_rate: pairThreshold?.min_win_rate ?? null,
      min_resolved_rate: thresholds.min_resolved_rate,
      max_win_rate_stddev: thresholds.max_win_rate_stddev,
      max_pair_regression: thresholds.max_pair_regression,
      max_resolved_rate_regression: thresholds.max_resolved_rate_regression,
    },
    baseline: baselinePair,
    candidate: candidatePair,
    baseline_delta: {
      win_rate: roundMetric(winRateDelta),
      resolved_rate: roundMetric(resolvedRateDelta),
    },
    passed: reasons.length === 0,
    reasons,
  };
}

function summarizeGate({ baseline, candidate, pairResults, thresholds, deterministic }) {
  const reasons = [];
  const baselineTierSet = new Set(baseline.model_tiers);
  const candidateTierSet = new Set(candidate.model_tiers);
  const requiredTiers = new Set();

  for (const pair of pairResults) {
    requiredTiers.add(pair.higher_tier);
    requiredTiers.add(pair.lower_tier);
  }

  const missingBaselineTiers = [...requiredTiers].filter((tierId) => !baselineTierSet.has(tierId));
  const missingCandidateTiers = [...requiredTiers].filter((tierId) => !candidateTierSet.has(tierId));
  if (missingBaselineTiers.length > 0) {
    reasons.push(`baseline manifest missing valid same-tier fair models: ${missingBaselineTiers.join(",")}`);
  }
  if (missingCandidateTiers.length > 0) {
    reasons.push(`candidate manifest missing valid same-tier fair models: ${missingCandidateTiers.join(",")}`);
  }
  if (!deterministic) {
    reasons.push("candidate strict gate benchmark is not deterministic");
  }

  for (const pairResult of pairResults) {
    reasons.push(...pairResult.reasons);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    deterministic,
    metrics: {
      compared_pairs: pairResults.length,
      passing_pairs: pairResults.filter((pair) => pair.passed).length,
      failing_pairs: pairResults.filter((pair) => !pair.passed).length,
    },
    pair_results: pairResults.map((pair) => ({
      higher_tier: pair.higher_tier,
      lower_tier: pair.lower_tier,
      passed: pair.passed,
    })),
    thresholds,
  };
}

function makePairSummaryMap(pairs = []) {
  const map = new Map();
  for (const pair of pairs) {
    if (pair?.pair_key) {
      map.set(pair.pair_key, pair);
    }
  }
  return map;
}

export function summarizeStrictFairGate({
  pairs = STRICT_FAIR_ADJACENT_PAIRS,
  baselineModelTiers = [],
  candidateModelTiers = [],
  baselinePairs = [],
  candidatePairs = [],
  thresholds = STRICT_FAIR_GATE_THRESHOLDS,
  deterministic = true,
} = {}) {
  const baselinePairMap = makePairSummaryMap(baselinePairs);
  const candidatePairMap = makePairSummaryMap(candidatePairs);
  const pairSummaries = pairs.map((pair) =>
    evaluatePairGate({
      pair,
      candidatePair: candidatePairMap.get(strictFairPairKey(pair)) ?? null,
      baselinePair: baselinePairMap.get(strictFairPairKey(pair)) ?? null,
      thresholds,
    }),
  );
  const baselineDeltas = pairSummaries.map((pairSummary) => ({
    higher_tier: pairSummary.higher_tier,
    lower_tier: pairSummary.lower_tier,
    win_rate_delta: pairSummary.baseline_delta.win_rate,
    resolved_rate_delta: pairSummary.baseline_delta.resolved_rate,
  }));
  const gate = summarizeGate({
    baseline: { model_tiers: baselineModelTiers },
    candidate: { model_tiers: candidateModelTiers },
    pairResults: pairSummaries,
    thresholds,
    deterministic,
  });

  return {
    pairs: pairSummaries,
    baseline_deltas: baselineDeltas,
    gate,
  };
}

export async function runStrictFairLadderGate({
  baselineManifest,
  candidateManifest,
  seedBase = STRICT_FAIR_GATE_DEFAULT_SEED_BASE,
  batches = STRICT_FAIR_GATE_DEFAULT_BATCHES,
  rounds = STRICT_FAIR_GATE_DEFAULT_ROUNDS,
  maxTicks = STRICT_FAIR_GATE_DEFAULT_MAX_TICKS,
  tiers = [...FAIR_LADDER_MODEL_TIERS],
  thresholds = STRICT_FAIR_GATE_THRESHOLDS,
} = {}) {
  const pairs = pickAdjacentPairs(tiers);
  const seedGrid = buildBatchSeeds({ seedBase, pairs, batches });
  const baseline = await loadModelsFromManifest(baselineManifest);
  const candidate = await loadModelsFromManifest(candidateManifest);

  const baselineResults = benchmarkPairBatches({
    loadedManifest: baseline,
    seedGrid,
    rounds,
    maxTicks,
  });
  const candidateResults = benchmarkPairBatches({
    loadedManifest: candidate,
    seedGrid,
    rounds,
    maxTicks,
  });
  const candidateRepeat = benchmarkPairBatches({
    loadedManifest: candidate,
    seedGrid,
    rounds,
    maxTicks,
  });

  attachBatchIndices(baselineResults.pair_batch_map, seedGrid);
  attachBatchIndices(candidateResults.pair_batch_map, seedGrid);
  attachBatchIndices(candidateRepeat.pair_batch_map, seedGrid);

  const baselinePairs = pairs.map((pair) =>
    summarizePairResults({
      pair,
      pairResults: baselineResults.pair_batch_map.get(strictFairPairKey(pair)) ?? [],
    }),
  );
  const candidatePairs = pairs.map((pair) =>
    summarizePairResults({
      pair,
      pairResults: candidateResults.pair_batch_map.get(strictFairPairKey(pair)) ?? [],
    }),
  );
  const deterministic = stableJson(candidateResults.batches) === stableJson(candidateRepeat.batches);
  const summary = summarizeStrictFairGate({
    pairs,
    baselineModelTiers: baseline.model_tiers,
    candidateModelTiers: candidate.model_tiers,
    baselinePairs,
    candidatePairs,
    thresholds,
    deterministic,
  });

  return {
    version: STRICT_FAIR_GATE_VERSION,
    gate_type: "strict_fair_ladder_promotion",
    passed: summary.gate.passed,
    generated_at: new Date().toISOString(),
    config: {
      baseline_manifest: baselineManifest,
      candidate_manifest: candidateManifest,
      seed_base: seedBase,
      batches,
      rounds,
      max_ticks: maxTicks,
      tiers,
    },
    thresholds,
    baseline: {
      manifest_path: baseline.manifest_path,
      model_tiers: baseline.model_tiers,
      warnings: baseline.warnings,
    },
    candidate: {
      manifest_path: candidate.manifest_path,
      model_tiers: candidate.model_tiers,
      warnings: candidate.warnings,
    },
    batches: seedGrid.map((batch) => ({
      batch_index: batch.batch_index,
      pairs: batch.pairs.map((pairSeed) => ({
        higher_tier: pairSeed.higher_tier,
        lower_tier: pairSeed.lower_tier,
        seed: pairSeed.seed,
        baseline: baselineResults.batches[batch.batch_index].pairs.find(
          (pairResult) => pairResult.pair_key === strictFairPairKey(pairSeed),
        ),
        candidate: candidateResults.batches[batch.batch_index].pairs.find(
          (pairResult) => pairResult.pair_key === strictFairPairKey(pairSeed),
        ),
      })),
    })),
    pairs: summary.pairs,
    baseline_deltas: summary.baseline_deltas,
    gate: summary.gate,
  };
}

export async function calibrateStrictFairGate({
  manifestPaths = [],
  seedBase = STRICT_FAIR_GATE_DEFAULT_SEED_BASE,
  batches = STRICT_FAIR_GATE_DEFAULT_BATCHES,
  rounds = STRICT_FAIR_GATE_DEFAULT_ROUNDS,
  maxTicks = STRICT_FAIR_GATE_DEFAULT_MAX_TICKS,
  tiers = [...FAIR_LADDER_MODEL_TIERS],
} = {}) {
  const pairs = pickAdjacentPairs(tiers);
  const seedGrid = buildBatchSeeds({ seedBase, pairs, batches });
  const calibrationProfiles = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadModelsFromManifest(manifestPath);
    const benchmarkResults = benchmarkPairBatches({
      loadedManifest,
      seedGrid,
      rounds,
      maxTicks,
    });
    attachBatchIndices(benchmarkResults.pair_batch_map, seedGrid);

    const pairSummaries = pairs.map((pair) =>
      summarizePairResults({
        pair,
        pairResults: benchmarkResults.pair_batch_map.get(strictFairPairKey(pair)) ?? [],
      }),
    );

    calibrationProfiles.push({
      manifest_path: manifestPath,
      model_tiers: loadedManifest.model_tiers,
      warnings: loadedManifest.warnings,
      pairs: pairSummaries,
    });
  }

  const recommendedPairThresholds = {};
  const resolvedRates = [];
  const stableStddevs = [];

  for (const pair of pairs) {
    const pairKey = strictFairPairKey(pair);
    const profiles = calibrationProfiles
      .map((profile) => profile.pairs.find((pairSummary) => pairSummary.pair_key === pairKey))
      .filter(Boolean);
    const bestWinRate = Math.max(...profiles.map((profile) => profile.mean_win_rate_higher));
    const minResolvedRate = Math.min(...profiles.map((profile) => profile.mean_resolved_rate));
    const winningProfiles = profiles.filter((profile) => profile.mean_win_rate_higher >= 0.5);
    const stddevSource = winningProfiles.length > 0 ? winningProfiles : profiles;
    const bestStddev = Math.min(...stddevSource.map((profile) => profile.win_rate_stddev));

    const pairThreshold = roundThreshold(
      Math.max(
        STRICT_FAIR_GATE_THRESHOLDS.calibration.min_win_rate_floor,
        bestWinRate - STRICT_FAIR_GATE_THRESHOLDS.calibration.win_rate_headroom,
      ),
    );
    recommendedPairThresholds[pairKey] = { min_win_rate: pairThreshold };
    resolvedRates.push(minResolvedRate);
    stableStddevs.push(bestStddev);
  }

  const recommendedMinResolvedRate = roundThreshold(
    Math.max(
      STRICT_FAIR_GATE_THRESHOLDS.calibration.min_resolved_rate_floor,
      Math.min(...resolvedRates) - STRICT_FAIR_GATE_THRESHOLDS.calibration.resolved_rate_headroom,
    ),
  );
  const recommendedMaxWinRateStddev = roundThreshold(
    Math.min(STRICT_FAIR_GATE_THRESHOLDS.max_win_rate_stddev, Math.max(...stableStddevs) + 0.02),
  );

  return {
    version: STRICT_FAIR_GATE_VERSION,
    mode: "calibration",
    generated_at: new Date().toISOString(),
    config: {
      seed_base: seedBase,
      batches,
      rounds,
      max_ticks: maxTicks,
      tiers,
      calibration_manifests: manifestPaths,
    },
    profiles: calibrationProfiles,
    recommended_thresholds: {
      version: STRICT_FAIR_GATE_VERSION,
      calibrated_at: new Date().toISOString().slice(0, 10),
      calibration: STRICT_FAIR_GATE_THRESHOLDS.calibration,
      min_resolved_rate: recommendedMinResolvedRate,
      max_win_rate_stddev: recommendedMaxWinRateStddev,
      max_pair_regression: STRICT_FAIR_GATE_THRESHOLDS.max_pair_regression,
      max_resolved_rate_regression: STRICT_FAIR_GATE_THRESHOLDS.max_resolved_rate_regression,
      pair_thresholds: recommendedPairThresholds,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = args.calibrate
    ? await calibrateStrictFairGate({
        manifestPaths: args.calibrationManifests,
        seedBase: args.seedBase,
        batches: args.batches,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
        tiers: args.tiers,
      })
    : await runStrictFairLadderGate({
        baselineManifest: args.baselineManifest,
        candidateManifest: args.candidateManifest,
        seedBase: args.seedBase,
        batches: args.batches,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
        tiers: args.tiers,
      });

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`strict_gate_summary=${args.out}`);
  }

  if (args.calibrate) {
    console.log(`recommended_thresholds=${JSON.stringify(summary.recommended_thresholds)}`);
    return;
  }

  console.log(`comparison_passed=${summary.gate.passed ? "true" : "false"}`);
  console.log(`candidate_model_tiers=${summary.candidate.model_tiers.join(",") || "none"}`);
  console.log(`compared_pairs=${summary.gate.metrics.compared_pairs}`);
  console.log(`failing_pairs=${summary.gate.metrics.failing_pairs}`);
  for (const reason of summary.gate.reasons) {
    console.log(`gate_reason=${reason}`);
  }

  if (args.failOnRegression && !summary.gate.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
