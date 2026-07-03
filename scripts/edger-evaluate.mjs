import process from "node:process";
import fs from "node:fs";
import path from "node:path";

import { HEURISTIC_BOT_ID, INTERNAL_BASELINE_BOTS, normalizeBotId } from "../src/ai/botRuntime.js";
import { DEFAULT_PROMOTED_MODEL_PATH, loadModelJson } from "./edger-model-utils.mjs";
import { evaluateCandidateModel, summarizeBenchmarkForConsole } from "./edger-evaluation-core.mjs";

function parseArgs(argv) {
  const parsed = {
    model: DEFAULT_PROMOTED_MODEL_PATH,
    seed: 20260630,
    roundsPerOpponent: 30,
    opponents: [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS],
    maxTicks: 6040,
    jsonOut: null,
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
    } else if (arg === "--json-out" && argv[i + 1]) {
      parsed.jsonOut = argv[++i];
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

const args = parseArgs(process.argv.slice(2));
const model = loadModelJson(args.model);
const report = evaluateCandidateModel(model, {
  modelPath: args.model,
  // The full promotion gate always includes the documented internal opponents.
  // `--opponents` is parsed for CLI compatibility but intentionally not used to
  // weaken candidate promotion evaluation.
  seed: args.seed,
  roundsPerOpponent: args.roundsPerOpponent,
  maxTicks: args.maxTicks,
});

if (args.jsonOut) {
  fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
  fs.writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(summarizeBenchmarkForConsole(report));

if (!report.gates.determinism.passed || !report.gates.replay.passed) {
  process.exitCode = 1;
}
