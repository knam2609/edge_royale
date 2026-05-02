import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runBenchmarkMatrix } from "../src/ai/benchmark.js";
import {
  FAIR_LADDER_MODEL_TIERS,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
  normalizeLoadedLadderModelsByTier,
} from "../src/ai/ladderModelManifest.js";

const DEFAULT_TIERS = ["noob", "mid", "top", "pro", "goat", "god"];

function parseArgs(argv) {
  const parsed = {
    seed: 202,
    roundsPerPair: 120,
    tiers: DEFAULT_TIERS,
    maxTicks: undefined,
    modelConfig: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (arg === "--rounds" && argv[i + 1]) {
      parsed.roundsPerPair = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (arg === "--max-ticks" && argv[i + 1]) {
      parsed.maxTicks = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[i + 1]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
      i += 1;
      continue;
    }

    if (arg === "--model-config" && argv[i + 1]) {
      parsed.modelConfig = argv[i + 1];
      i += 1;
    }
  }

  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 202;
  }
  if (!Number.isFinite(parsed.roundsPerPair) || parsed.roundsPerPair <= 0) {
    parsed.roundsPerPair = 120;
  }
  if (!Array.isArray(parsed.tiers) || parsed.tiers.length < 2) {
    parsed.tiers = DEFAULT_TIERS;
  }
  if (!Number.isFinite(parsed.maxTicks) || parsed.maxTicks <= 0) {
    parsed.maxTicks = undefined;
  }

  return parsed;
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.warn(`warning: could not read ${path}: ${error.message}`);
    return null;
  }
}

async function loadModelsFromConfig(modelConfigPath) {
  if (!modelConfigPath) {
    return {};
  }

  const resolvedConfigPath = resolve(process.cwd(), modelConfigPath);
  const rawManifest = await readJsonFile(resolvedConfigPath);
  const manifest = normalizeLadderModelManifest(rawManifest);
  const rawModelsByTier = {};
  const readWarnings = [];

  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const modelPath = getConfiguredLadderModelPath(manifest, tierId);
    if (!modelPath) {
      continue;
    }

    const rawModel = await readJsonFile(resolve(process.cwd(), modelPath));
    if (rawModel) {
      rawModelsByTier[tierId] = rawModel;
    } else {
      readWarnings.push(`tier ${tierId} model at ${modelPath} could not be loaded; using heuristic`);
    }
  }

  const loaded = normalizeLoadedLadderModelsByTier({ manifest, rawModelsByTier });
  for (const warning of [...readWarnings, ...loaded.warnings]) {
    console.warn(`warning: ${warning}`);
  }

  return loaded.modelsByTier;
}

function printMatrix(matrix) {
  console.log(`seed=${matrix.seed} rounds_per_pair=${matrix.rounds_per_pair}`);
  console.log("higher_tier | lower_tier | win_rate_higher | wins_higher-lower | draws");
  console.log("----------- | ---------- | --------------- | ----------------- | -----");

  for (const pair of matrix.pairs) {
    const winRate = pair.win_rate_higher.toFixed(3);
    const wins = `${pair.wins_higher}-${pair.wins_lower}`;
    console.log(
      `${pair.higher_tier.padEnd(11)} | ${pair.lower_tier.padEnd(10)} | ${winRate.padEnd(15)} | ${wins.padEnd(17)} | ${pair.draws}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const trainedModelsByTier = await loadModelsFromConfig(args.modelConfig);
if (args.modelConfig) {
  console.log(`model_config=${resolve(process.cwd(), args.modelConfig)}`);
  console.log(`model_tiers=${Object.keys(trainedModelsByTier).join(",") || "none"}`);
}
const matrix = runBenchmarkMatrix({
  tiers: args.tiers,
  seed: args.seed,
  roundsPerPair: args.roundsPerPair,
  maxTicks: args.maxTicks,
  trainedModelsByTier,
});
printMatrix(matrix);
