import fs from "node:fs";
import path from "node:path";

import { canonicalJson, createBootstrapPolicyModel, getCurrentGitCommit } from "./edger-model-utils.mjs";

function parseArgs(argv) {
  const parsed = {
    seed: 20260701,
    outDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
    } else if (arg === "--out-dir" && argv[i + 1]) {
      parsed.outDir = argv[++i];
    }
  }

  if (!Number.isFinite(parsed.seed)) {
    parsed.seed = 20260701;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const runId = `bootstrap-${args.seed}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = args.outDir ?? path.join("artifacts", "edger-training", "runs", runId);
const model = createBootstrapPolicyModel({
  modelId: `edger_policy_bootstrap_${args.seed}`,
  seed: args.seed,
  gitCommit: getCurrentGitCommit(),
});

fs.mkdirSync(runDir, { recursive: true });
const modelPath = path.join(runDir, "edger_policy_candidate.json");
const reportPath = path.join(runDir, "training_report.json");
fs.writeFileSync(modelPath, canonicalJson(model));
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      run_id: runId,
      seed: args.seed,
      model: modelPath,
      method: model.training.method,
      status: "bootstrap_exported",
      notes: model.training.notes,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${modelPath}`);
console.log(`wrote ${reportPath}`);
