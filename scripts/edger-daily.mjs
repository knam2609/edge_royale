import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {
    seed: null,
    profile: "daily",
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) {
      parsed.seed = Number.parseInt(argv[++i], 10);
    } else if (arg === "--profile" && argv[i + 1]) {
      parsed.profile = argv[++i];
    } else if (arg === "--out-dir" && argv[i + 1]) {
      parsed.outDir = argv[++i];
    }
  }
  if (!Number.isFinite(parsed.seed)) {
    const now = new Date();
    parsed.seed = Number.parseInt(
      `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`,
      10,
    );
  }
  return parsed;
}

function runStep(label, command, args, { allowFailure = false } = {}) {
  console.log(`\n== ${label} ==`);
  console.log([command, ...args].join(" "));
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  return result.status ?? 1;
}

function writeSummary(runDir, summary) {
  fs.mkdirSync(runDir, { recursive: true });
  const summaryPath = path.join(runDir, "daily_summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${summaryPath}`);
}

const args = parseArgs(process.argv.slice(2));
const runId = `daily-${args.profile}-${args.seed}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = args.outDir ?? path.join("artifacts", "edger-training", "runs", runId);
const modelPath = path.join(runDir, "edger_policy_candidate.json");
const evaluationPath = path.join(runDir, "evaluation_report.json");

const summary = {
  run_id: runId,
  seed: args.seed,
  profile: args.profile,
  run_dir: runDir,
  model: modelPath,
  evaluation_report: evaluationPath,
  promotion_ready: false,
  promoted_files_updated: false,
  browser_smoke_passed: false,
  status: "started",
};

try {
  runStep("train", process.execPath, [
    "scripts/edger-train.mjs",
    "--mode",
    "ppo",
    "--seed",
    String(args.seed),
    "--profile",
    args.profile,
    "--out-dir",
    runDir,
  ]);

  const evaluationExit = runStep("evaluate", process.execPath, [
    "scripts/edger-evaluate.mjs",
    "--model",
    modelPath,
    "--json-out",
    evaluationPath,
  ], { allowFailure: true });

  if (!fs.existsSync(evaluationPath)) {
    throw new Error(`evaluation did not write ${evaluationPath}`);
  }
  summary.evaluation_exit = evaluationExit;
  const report = JSON.parse(fs.readFileSync(evaluationPath, "utf8"));
  summary.promotion_ready = Boolean(report.promotion?.passed);
  summary.promotion_failures = report.promotion?.failures ?? [];

  if (!summary.promotion_ready) {
    summary.status = "gates_failed";
    writeSummary(runDir, summary);
    process.exit(0);
  }

  const smokeExit = runStep("browser smoke", "npm", ["run", "smoke:browser"], { allowFailure: true });
  summary.browser_smoke_passed = smokeExit === 0;
  summary.browser_smoke_exit = smokeExit;
  if (!summary.browser_smoke_passed) {
    summary.status = "browser_smoke_failed";
    writeSummary(runDir, summary);
    process.exit(0);
  }

  runStep("promote", process.execPath, [
    "scripts/edger-promote.mjs",
    "--model",
    modelPath,
    "--report",
    evaluationPath,
    "--require-gates",
  ]);

  summary.promoted_files_updated = true;
  summary.status = "promoted";
  writeSummary(runDir, summary);
} catch (error) {
  summary.status = "failed";
  summary.error = error instanceof Error ? error.message : String(error);
  writeSummary(runDir, summary);
  console.error(summary.error);
  process.exit(1);
}
