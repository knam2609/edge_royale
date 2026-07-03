import process from "node:process";

import { runBotMatch, runEdgerBenchmarkSuite } from "../src/ai/benchmark.js";
import { HEURISTIC_BOT_ID, INTERNAL_BASELINE_BOTS, normalizeBotId } from "../src/ai/botRuntime.js";
import { DEFAULT_PROMOTED_MODEL_PATH, loadModelJson } from "./edger-model-utils.mjs";

function parseArgs(argv) {
  const parsed = {
    model: DEFAULT_PROMOTED_MODEL_PATH,
    seed: 20260630,
    roundsPerOpponent: 30,
    opponents: [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS],
    maxTicks: 6040,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      parsed.model = argv[++i];
    } else if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
    } else if (arg === "--rounds" && argv[i + 1]) {
      parsed.roundsPerOpponent = Number.parseInt(argv[++i], 10);
    } else if (arg === "--max-ticks" && argv[i + 1]) {
      parsed.maxTicks = Number.parseInt(argv[++i], 10);
    } else if (arg === "--opponents" && argv[i + 1]) {
      parsed.opponents = argv[++i]
        .split(",")
        .map((botId) => normalizeBotId(botId.trim()))
        .filter(Boolean);
    }
  }

  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 20260630;
  }
  if (!Number.isFinite(parsed.roundsPerOpponent) || parsed.roundsPerOpponent <= 0) {
    parsed.roundsPerOpponent = 30;
  }
  if (!Number.isFinite(parsed.maxTicks) || parsed.maxTicks <= 0) {
    parsed.maxTicks = 6040;
  }
  parsed.opponents = [...new Set(parsed.opponents.length > 0 ? parsed.opponents : [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS])];
  return parsed;
}

function wilsonLowerBound(wins, resolved, z = 1.96) {
  if (resolved <= 0) {
    return 0;
  }
  const phat = wins / resolved;
  const denom = 1 + (z * z) / resolved;
  const center = phat + (z * z) / (2 * resolved);
  const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * resolved)) / resolved);
  return (center - spread) / denom;
}

function printSuite(suite) {
  console.log(`model=${suite.model_id}`);
  console.log(`seed=${suite.seed} rounds_per_opponent=${suite.rounds_per_opponent} max_ticks=${suite.max_ticks}`);
  console.log("opponent         | win_rate | wilson_lb | wins-losses | draws | resolved");
  console.log("---------------- | -------- | --------- | ----------- | ----- | --------");
  for (const pair of suite.pairs) {
    const lower = wilsonLowerBound(pair.wins, pair.resolved);
    const wins = `${pair.wins}-${pair.losses}`;
    console.log(
      `${pair.opponent.padEnd(16)} | ${pair.win_rate.toFixed(3).padEnd(8)} | ${lower.toFixed(3).padEnd(9)} | ${wins.padEnd(11)} | ${String(pair.draws).padEnd(5)} | ${String(pair.resolved).padEnd(8)}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const model = loadModelJson(args.model);
const deterministicA = runBotMatch({
  blueBot: "edger",
  redBot: HEURISTIC_BOT_ID,
  seed: args.seed,
  maxTicks: Math.min(args.maxTicks, 600),
  edgerModel: model,
});
const deterministicB = runBotMatch({
  blueBot: "edger",
  redBot: HEURISTIC_BOT_ID,
  seed: args.seed,
  maxTicks: Math.min(args.maxTicks, 600),
  edgerModel: model,
});
const deterministic = JSON.stringify(deterministicA) === JSON.stringify(deterministicB);

const suite = runEdgerBenchmarkSuite({
  opponents: args.opponents,
  seed: args.seed,
  roundsPerOpponent: args.roundsPerOpponent,
  maxTicks: args.maxTicks,
  edgerModel: model,
});

suite.model_id = model.model_id;
printSuite(suite);
console.log(`deterministic_same_seed=${deterministic ? "yes" : "no"}`);

if (!deterministic) {
  process.exitCode = 1;
}
