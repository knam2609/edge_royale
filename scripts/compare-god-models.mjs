import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmark } from "../src/ai/benchmark.js";
import {
  DEFAULT_LADDER_MODEL_MANIFEST_PATH,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
} from "../src/ai/ladderModelManifest.js";
import { getNeuralModelTargetTier, normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";

const DEFAULT_SEED = 1009;
const DEFAULT_ROUNDS = 50;
const DEFAULT_MIN_PRIOR_GOD_WIN_RATE = 0.5;

function parseArgs(argv) {
  const parsed = {
    baselineManifest: DEFAULT_LADDER_MODEL_MANIFEST_PATH,
    candidateManifest: null,
    out: null,
    seed: DEFAULT_SEED,
    rounds: DEFAULT_ROUNDS,
    maxTicks: undefined,
    minPriorGodWinRate: DEFAULT_MIN_PRIOR_GOD_WIN_RATE,
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
    else if (arg === "--min-prior-god-win-rate" && argv[i + 1]) {
      parsed.minPriorGodWinRate = Number.parseFloat(argv[++i]);
    } else if (arg === "--fail-on-regression") {
      parsed.failOnRegression = true;
    }
  }

  if (!parsed.candidateManifest) {
    throw new Error("missing --candidate-manifest path");
  }
  parsed.seed = Number.isFinite(parsed.seed) ? parsed.seed : DEFAULT_SEED;
  parsed.rounds = Number.isFinite(parsed.rounds) && parsed.rounds > 0 ? parsed.rounds : DEFAULT_ROUNDS;
  parsed.maxTicks = Number.isFinite(parsed.maxTicks) && parsed.maxTicks > 0 ? parsed.maxTicks : undefined;
  parsed.minPriorGodWinRate = Number.isFinite(parsed.minPriorGodWinRate)
    ? parsed.minPriorGodWinRate
    : DEFAULT_MIN_PRIOR_GOD_WIN_RATE;
  return parsed;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
  } catch (error) {
    return { warning: `could not read ${path}: ${error.message}` };
  }
}

async function loadModelFromManifest(manifestPath, tierId) {
  const warnings = [];
  const rawManifest = await readJson(manifestPath);
  if (rawManifest.warning) {
    warnings.push(rawManifest.warning);
  }
  const manifest = normalizeLadderModelManifest(rawManifest.warning ? null : rawManifest);
  warnings.push(...manifest.warnings);
  const modelPath = getConfiguredLadderModelPath(manifest, tierId);
  if (!modelPath) {
    return { model: null, model_path: null, warnings };
  }
  const rawModel = await readJson(modelPath);
  if (rawModel.warning) {
    warnings.push(rawModel.warning);
    return { model: null, model_path: modelPath, warnings };
  }
  const model = normalizeNeuralPolicyModel(rawModel);
  const targetTier = getNeuralModelTargetTier(model);
  if (!model || targetTier !== tierId) {
    warnings.push(`tier ${tierId} model target is ${targetTier ?? "invalid"}`);
    return { model: null, model_path: modelPath, warnings };
  }
  return { model, model_path: modelPath, warnings };
}

function runGodVsGoat({ godModel, goatModel = null, seed, rounds, maxTicks }) {
  return runBenchmark({
    botA: "god",
    botB: "goat",
    trainedModelA: godModel,
    trainedModelB: goatModel,
    seed,
    rounds,
    maxTicks,
  });
}

export async function compareGodModels(args) {
  const baselineGod = await loadModelFromManifest(args.baselineManifest, "god");
  const baselineGoat = await loadModelFromManifest(args.baselineManifest, "goat");
  const candidateGod = await loadModelFromManifest(args.candidateManifest, "god");
  const reasons = [];

  if (!candidateGod.model) {
    reasons.push("candidate manifest missing valid same-tier God model");
  }

  const candidateVsGoat = candidateGod.model
    ? runGodVsGoat({
        godModel: candidateGod.model,
        goatModel: baselineGoat.model,
        seed: args.seed,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
      })
    : null;
  const candidateVsGoatRepeat = candidateGod.model
    ? runGodVsGoat({
        godModel: candidateGod.model,
        goatModel: baselineGoat.model,
        seed: args.seed,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
      })
    : null;
  const deterministic = JSON.stringify(candidateVsGoat) === JSON.stringify(candidateVsGoatRepeat);
  if (!deterministic) {
    reasons.push("candidate God benchmark is not deterministic");
  }

  const bootstrap = !baselineGod.model;
  const baselineVsGoat = baselineGod.model
    ? runGodVsGoat({
        godModel: baselineGod.model,
        goatModel: baselineGoat.model,
        seed: args.seed,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
      })
    : null;
  const candidateVsPriorGod = baselineGod.model && candidateGod.model
    ? runBenchmark({
        botA: "god",
        botB: "god",
        trainedModelA: candidateGod.model,
        trainedModelB: baselineGod.model,
        seed: args.seed + 97,
        rounds: args.rounds,
        maxTicks: args.maxTicks,
      })
    : null;

  if (!bootstrap && candidateVsGoat && baselineVsGoat && candidateVsGoat.winRateA < baselineVsGoat.winRateA) {
    reasons.push(
      `candidate God vs Goat win rate ${candidateVsGoat.winRateA} is below baseline ${baselineVsGoat.winRateA}`,
    );
  }
  if (
    !bootstrap &&
    candidateVsPriorGod &&
    candidateVsPriorGod.winRateA < args.minPriorGodWinRate
  ) {
    reasons.push(
      `candidate God vs prior God win rate ${candidateVsPriorGod.winRateA} is below ${args.minPriorGodWinRate}`,
    );
  }

  return {
    version: 1,
    passed: reasons.length === 0,
    generated_at: new Date().toISOString(),
    config: {
      seed: args.seed,
      rounds: args.rounds,
      max_ticks: args.maxTicks ?? null,
      min_prior_god_win_rate: args.minPriorGodWinRate,
    },
    bootstrap,
    baseline: {
      manifest_path: args.baselineManifest,
      god_model_path: baselineGod.model_path,
      goat_model_path: baselineGoat.model_path,
      warnings: [...baselineGod.warnings, ...baselineGoat.warnings],
      god_vs_goat: baselineVsGoat,
    },
    candidate: {
      manifest_path: args.candidateManifest,
      god_model_path: candidateGod.model_path,
      warnings: candidateGod.warnings,
      god_vs_goat: candidateVsGoat,
      god_vs_prior_god: candidateVsPriorGod,
    },
    gate: {
      passed: reasons.length === 0,
      reasons,
      deterministic,
      bootstrap,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await compareGodModels(args);
  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`god_comparison_summary=${args.out}`);
  }
  console.log(`god_comparison_passed=${summary.passed ? "true" : "false"}`);
  for (const reason of summary.gate.reasons) {
    console.log(`god_gate_reason=${reason}`);
  }
  if (args.failOnRegression && !summary.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
