import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { generateTrainingDataset } from "../src/ai/trainingData.js";

function parseArgs(argv) {
  const parsed = {
    seed: 303,
    episodes: 8,
    maxTicks: 900,
    tiers: ["top", "goat"],
    pretty: false,
    out: "artifacts/training/datasets/goat-dataset.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--episodes" && argv[i + 1]) {
      parsed.episodes = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--max-ticks" && argv[i + 1]) {
      parsed.maxTicks = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      parsed.out = argv[++i];
      continue;
    }
    if (arg === "--pretty") {
      parsed.pretty = true;
    }
  }

  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 303;
  }
  if (!Number.isFinite(parsed.episodes) || parsed.episodes <= 0) {
    parsed.episodes = 8;
  }
  if (!Number.isFinite(parsed.maxTicks) || parsed.maxTicks <= 0) {
    parsed.maxTicks = 900;
  }
  if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) {
    parsed.tiers = ["top", "goat"];
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const dataset = generateTrainingDataset({
  seed: args.seed,
  episodes: args.episodes,
  maxTicks: args.maxTicks,
  tiers: args.tiers,
});

const outPath = resolve(process.cwd(), args.out);
await mkdir(dirname(outPath), { recursive: true });
const json = args.pretty ? JSON.stringify(dataset, null, 2) : JSON.stringify(dataset);
await writeFile(outPath, `${json}\n`, "utf8");

console.log(`wrote ${outPath}`);
console.log(`dataset_hash=${dataset.dataset_hash} episodes=${dataset.episode_count} samples=${dataset.sample_count}`);
