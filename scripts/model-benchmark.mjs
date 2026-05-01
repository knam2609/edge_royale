import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runBenchmark } from "../src/ai/benchmark.js";
import { normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";

function parseArgs(argv) {
  const parsed = {
    model: null,
    tiers: ["noob", "mid", "top", "goat"],
    seed: 404,
    rounds: 10,
    maxTicks: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      parsed.model = argv[++i];
      continue;
    }
    if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
      continue;
    }
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--rounds" && argv[i + 1]) {
      parsed.rounds = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--max-ticks" && argv[i + 1]) {
      parsed.maxTicks = Number.parseInt(argv[++i], 10);
    }
  }

  if (!parsed.model) {
    throw new Error("missing --model path");
  }
  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 404;
  }
  if (!Number.isFinite(parsed.rounds) || parsed.rounds <= 0) {
    parsed.rounds = 10;
  }
  if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) {
    parsed.tiers = ["noob", "mid", "top", "goat"];
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const modelPath = resolve(process.cwd(), args.model);
const model = normalizeNeuralPolicyModel(JSON.parse(await readFile(modelPath, "utf8")));
if (!model) {
  throw new Error(`invalid neural Goat model: ${modelPath}`);
}

console.log(`model=${modelPath}`);
console.log(`seed=${args.seed} rounds=${args.rounds}`);
console.log("model_goat | opponent | win_rate | wins-losses | draws");
console.log("---------- | -------- | -------- | ----------- | -----");

for (const tier of args.tiers) {
  const result = runBenchmark({
    botA: "goat",
    botB: tier,
    trainedModelA: model,
    seed: args.seed + tier.length * 17,
    rounds: args.rounds,
    maxTicks: args.maxTicks,
  });
  console.log(
    `${"goat".padEnd(10)} | ${tier.padEnd(8)} | ${result.winRateA.toFixed(3).padEnd(8)} | ${`${result.winsA}-${result.winsB}`.padEnd(11)} | ${result.draws}`,
  );
}
