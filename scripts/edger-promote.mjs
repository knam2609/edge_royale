import process from "node:process";
import fs from "node:fs";

import {
  DEFAULT_GENERATED_JS_PATH,
  DEFAULT_PROMOTED_MODEL_PATH,
  loadModelJson,
  writeGeneratedJs,
  writeJsonFile,
} from "./edger-model-utils.mjs";
import { checkPromotionReport } from "./edger-evaluation-core.mjs";

function parseArgs(argv) {
  const parsed = {
    model: DEFAULT_PROMOTED_MODEL_PATH,
    out: DEFAULT_PROMOTED_MODEL_PATH,
    jsOut: DEFAULT_GENERATED_JS_PATH,
    report: null,
    requireGates: false,
    checkOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      parsed.model = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      parsed.out = argv[++i];
    } else if (arg === "--js-out" && argv[i + 1]) {
      parsed.jsOut = argv[++i];
    } else if (arg === "--report" && argv[i + 1]) {
      parsed.report = argv[++i];
    } else if (arg === "--require-gates") {
      parsed.requireGates = true;
    } else if (arg === "--check-only") {
      parsed.checkOnly = true;
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const model = loadModelJson(args.model);

if (args.requireGates) {
  if (!args.report) {
    console.error("--require-gates requires --report <evaluation-report-json>");
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(args.report, "utf8"));
  const result = checkPromotionReport(report);
  if (!result.passed) {
    console.error("promotion gates failed:");
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
  if (report.model_id && report.model_id !== model.model_id) {
    console.error(`report model_id ${report.model_id} does not match candidate ${model.model_id}`);
    process.exit(1);
  }
}

if (args.checkOnly) {
  console.log(`promotion gates passed for ${args.model}`);
  process.exit(0);
}

writeJsonFile(args.out, model);
writeGeneratedJs(args.jsOut, model);

console.log(`promoted ${args.model}`);
console.log(`wrote ${args.out}`);
console.log(`wrote ${args.jsOut}`);
