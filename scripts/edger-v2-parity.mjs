#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { canonicalJson } from "./edger-corpus-core.mjs";
import { checkCandidateParity } from "./edger-v2-evaluation-core.mjs";

function parseArgs(argv) {
  const parsed = { model: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--model" && argv[index + 1]) {
      parsed.model = argv[++index];
    } else if (argv[index] === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    }
  }
  if (!parsed.model || !parsed.out) {
    throw new Error("--model and --out are required");
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const modelPath = path.resolve(args.model);
  const model = validateEdgerV2PolicyModel(
    JSON.parse(fs.readFileSync(modelPath, "utf8")),
  );
  const parity = checkCandidateParity(modelPath, model);
  const report = {
    schema_version: "edger_v2_parity_report_v1",
    model_id: model.model_id,
    git_commit: model.training?.git_commit ?? null,
    passed: parity.passed,
    ...parity,
  };
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canonicalJson(report));
  console.log(canonicalJson(report).trimEnd());
  if (!report.passed) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
