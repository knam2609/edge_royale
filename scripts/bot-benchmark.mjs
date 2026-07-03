import process from "node:process";

import { HEURISTIC_BOT_ID, INTERNAL_BASELINE_BOTS, EDGER_BOT_ID, normalizeBotId } from "../src/ai/botRuntime.js";
import { runEdgerBenchmarkSuite } from "../src/ai/benchmark.js";

function parseArgs(argv) {
  const parsed = {
    seed: 20260630,
    roundsPerOpponent: 30,
    opponents: [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS],
    maxTicks: undefined,
    minWinRate: 0.6,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--rounds" && argv[i + 1]) {
      parsed.roundsPerOpponent = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--max-ticks" && argv[i + 1]) {
      parsed.maxTicks = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--opponents" && argv[i + 1]) {
      parsed.opponents = argv[++i]
        .split(",")
        .map((botId) => normalizeBotId(botId.trim()))
        .filter((botId) => botId.length > 0 && botId !== EDGER_BOT_ID);
      continue;
    }
    if (arg === "--min-win-rate" && argv[i + 1]) {
      parsed.minWinRate = Number.parseFloat(argv[++i]);
    }
  }

  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 20260630;
  }
  if (!Number.isFinite(parsed.roundsPerOpponent) || parsed.roundsPerOpponent <= 0) {
    parsed.roundsPerOpponent = 30;
  }
  if (!Array.isArray(parsed.opponents) || parsed.opponents.length === 0) {
    parsed.opponents = [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS];
  }
  if (!Number.isFinite(parsed.maxTicks) || parsed.maxTicks <= 0) {
    parsed.maxTicks = undefined;
  }
  if (!Number.isFinite(parsed.minWinRate) || parsed.minWinRate < 0 || parsed.minWinRate > 1) {
    parsed.minWinRate = 0.6;
  }

  parsed.opponents = [...new Set(parsed.opponents)];
  return parsed;
}

function printSuite(suite, minWinRate) {
  console.log(`bot=${suite.bot} seed=${suite.seed} rounds_per_opponent=${suite.rounds_per_opponent}`);
  console.log(`min_win_rate=${minWinRate.toFixed(3)}`);
  console.log("opponent         | win_rate | wins-losses | draws | resolved | passed");
  console.log("---------------- | -------- | ----------- | ----- | -------- | ------");

  for (const pair of suite.pairs) {
    const winRate = pair.win_rate.toFixed(3);
    const wins = `${pair.wins}-${pair.losses}`;
    const passed = pair.resolved > 0 && pair.win_rate >= minWinRate;
    console.log(
      `${pair.opponent.padEnd(16)} | ${winRate.padEnd(8)} | ${wins.padEnd(11)} | ${String(pair.draws).padEnd(5)} | ${String(pair.resolved).padEnd(8)} | ${passed ? "yes" : "no"}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const suite = runEdgerBenchmarkSuite({
  opponents: args.opponents,
  seed: args.seed,
  roundsPerOpponent: args.roundsPerOpponent,
  maxTicks: args.maxTicks,
});

printSuite(suite, args.minWinRate);

const failures = suite.pairs.filter((pair) => pair.resolved === 0 || pair.win_rate < args.minWinRate);
if (failures.length > 0) {
  for (const pair of failures) {
    console.error(
      `benchmark gate failed: ${EDGER_BOT_ID} vs ${pair.opponent} win_rate=${pair.win_rate.toFixed(3)} resolved=${pair.resolved}`,
    );
  }
  process.exitCode = 1;
}
