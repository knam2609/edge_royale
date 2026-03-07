import { runBenchmarkMatrix } from "../src/ai/benchmark.js";

const DEFAULT_TIERS = ["noob", "mid", "top", "pro", "goat", "god"];

function parseArgs(argv) {
  const parsed = {
    seed: 202,
    roundsPerPair: 120,
    tiers: DEFAULT_TIERS,
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

    if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[i + 1]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
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

  return parsed;
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
const matrix = runBenchmarkMatrix({
  tiers: args.tiers,
  seed: args.seed,
  roundsPerPair: args.roundsPerPair,
});
printMatrix(matrix);
