import fs from "node:fs";
import path from "node:path";

import { canonicalJson, createBootstrapPolicyModel, getCurrentGitCommit } from "./edger-model-utils.mjs";
import { trainEdgerPolicy } from "./edger-training-core.mjs";

function parseArgs(argv) {
  const parsed = {
    mode: "ppo",
    profile: "smoke",
    seed: 20260701,
    outDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      parsed.mode = argv[++i];
    } else if (arg === "--profile" && argv[i + 1]) {
      parsed.profile = argv[++i];
    } else if (arg === "--seed" && argv[i + 1]) {
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
const mode = args.mode === "bootstrap" ? "bootstrap" : "ppo";
const runId = `${mode}-${args.profile}-${args.seed}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = args.outDir ?? path.join("artifacts", "edger-training", "runs", runId);
const gitCommit = getCurrentGitCommit();
const training = mode === "bootstrap"
  ? {
      model: createBootstrapPolicyModel({
        modelId: `edger_policy_bootstrap_${args.seed}`,
        seed: args.seed,
        gitCommit,
      }),
      report: {
        seed: args.seed,
        profile: args.profile,
        method: "bootstrap_heuristic_prior_export",
        behavior_examples: 0,
        ppo_decisions: 0,
      },
    }
  : trainEdgerPolicy({
      seed: args.seed,
      profileName: args.profile,
      modelId: `edger_policy_ppo_${args.profile}_${args.seed}`,
      gitCommit,
    });

fs.mkdirSync(runDir, { recursive: true });
const modelPath = path.join(runDir, "edger_policy_candidate.json");
const reportPath = path.join(runDir, "training_report.json");
fs.writeFileSync(modelPath, canonicalJson(training.model));
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      run_id: runId,
      mode,
      profile: args.profile,
      seed: args.seed,
      model: modelPath,
      method: training.model.training.method,
      status: mode === "bootstrap" ? "bootstrap_exported" : "ppo_candidate_exported",
      training: training.report,
      notes: training.model.training.notes,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${modelPath}`);
console.log(`wrote ${reportPath}`);
