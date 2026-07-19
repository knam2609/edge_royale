#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SEED = 20260718;
const MEMORY_LIMIT_KIB = 28 * 1024 * 1024;
const DISK_LIMIT_KIB = 160 * 1024 * 1024;

function parseArgs(argv) {
  const parsed = {
    campaignUri: process.env.EDGER_CAMPAIGN_URI ?? null,
    corpusStore: process.env.EDGER_CORPUS_STORE ?? null,
    referenceHardware:
      process.env.EDGER_REFERENCE_HARDWARE ??
      "aws-c7g.4xlarge-ap-southeast-2",
    workDir:
      process.env.EDGER_CAMPAIGN_WORK_DIR ??
      path.resolve("artifacts/edger-training/production-campaign"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--campaign-uri" && argv[index + 1]) {
      parsed.campaignUri = argv[++index];
    } else if (arg === "--corpus-store" && argv[index + 1]) {
      parsed.corpusStore = argv[++index];
    } else if (arg === "--reference-hardware" && argv[index + 1]) {
      parsed.referenceHardware = argv[++index];
    } else if (arg === "--work-dir" && argv[index + 1]) {
      parsed.workDir = path.resolve(argv[++index]);
    }
  }
  if (!parsed.campaignUri?.startsWith("s3://")) {
    throw new Error("--campaign-uri must be an s3:// URI");
  }
  if (!parsed.corpusStore?.startsWith("s3://")) {
    throw new Error("--corpus-store must be an s3:// URI");
  }
  parsed.campaignUri = parsed.campaignUri.replace(/\/+$/, "");
  return parsed;
}

function currentGitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function requireCleanGit() {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf8" },
  ).trim();
  if (status) {
    throw new Error("production campaign requires a clean Git worktree");
  }
}

function sha256File(filePath) {
  const digest = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}

function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`invalid S3 object URI ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}

function aws(args, options = {}) {
  return execFileSync(
    "aws",
    [...args, "--region", process.env.AWS_REGION ?? "ap-southeast-2"],
    { encoding: "utf8", ...options },
  );
}

function tryReadS3Json(uri) {
  try {
    return JSON.parse(aws(["s3", "cp", uri, "-", "--only-show-errors"]));
  } catch {
    return null;
  }
}

function uploadDirectory(localDir, uri) {
  if (!fs.existsSync(localDir)) {
    return;
  }
  aws([
    "s3",
    "cp",
    `${localDir}${path.sep}`,
    `${uri.replace(/\/+$/, "")}/`,
    "--recursive",
    "--exclude",
    "*.parquet",
    "--only-show-errors",
  ], { stdio: "inherit", encoding: undefined });
}

function downloadDirectory(uri, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  aws([
    "s3",
    "cp",
    `${uri.replace(/\/+$/, "")}/`,
    `${localDir}${path.sep}`,
    "--recursive",
    "--only-show-errors",
  ], { stdio: "inherit", encoding: undefined });
}

function writeImmutableJson(uri, payload) {
  const temporary = path.join(
    os.tmpdir(),
    `edger-status-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  const { bucket, key } = parseS3Uri(uri);
  try {
    aws([
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--body",
      temporary,
      "--if-none-match",
      "*",
    ]);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeAttemptJson(uri, payload) {
  const temporary = path.join(
    os.tmpdir(),
    `edger-attempt-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  try {
    aws(["s3", "cp", temporary, uri, "--only-show-errors"]);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function diskUsedKiB(target) {
  const lines = execFileSync("df", ["-Pk", target], { encoding: "utf8" })
    .trim()
    .split("\n");
  return Number.parseInt(lines.at(-1).trim().split(/\s+/)[2], 10);
}

function durableArtifacts(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (!entry.name.endsWith(".parquet") && !entry.name.endsWith(".time.txt")) {
        files.push({
          path: path.relative(root, filePath),
          bytes: fs.statSync(filePath).size,
          sha256: sha256File(filePath),
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function makeCommandRunner(stageDir, resources) {
  let commandIndex = 0;
  return (command, args, { env = {} } = {}) => {
    const timeFile = path.join(
      stageDir,
      `${String(commandIndex).padStart(2, "0")}-${path.basename(command)}.time.txt`,
    );
    commandIndex += 1;
    const result = spawnSync(
      "/usr/bin/time",
      ["-v", "-o", timeFile, command, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: "inherit",
      },
    );
    const timing = fs.readFileSync(timeFile, "utf8");
    const rssMatch = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(timing);
    if (rssMatch) {
      resources.peak_rss_kib = Math.max(
        resources.peak_rss_kib,
        Number.parseInt(rssMatch[1], 10),
      );
    }
    resources.peak_disk_used_kib = Math.max(
      resources.peak_disk_used_kib,
      diskUsedKiB(stageDir),
    );
    if (resources.peak_rss_kib >= MEMORY_LIMIT_KIB) {
      throw new Error(
        `peak resident memory ${resources.peak_rss_kib} KiB reached the 28 GiB gate`,
      );
    }
    if (resources.peak_disk_used_kib >= DISK_LIMIT_KIB) {
      throw new Error(
        `disk use ${resources.peak_disk_used_kib} KiB reached the 160 GiB gate`,
      );
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `${command} exited ${result.status ?? "null"} (${result.signal ?? "no signal"})`,
      );
    }
  };
}

const args = parseArgs(process.argv.slice(2));
const gitCommit = currentGitCommit();
requireCleanGit();
fs.mkdirSync(args.workDir, { recursive: true });

async function runStage(name, callback) {
  const stageDir = path.join(args.workDir, name);
  const completedUri = `${args.campaignUri}/status/completed/${name}.json`;
  const stageUri = `${args.campaignUri}/stages/${name}`;
  const completed = tryReadS3Json(completedUri);
  if (completed) {
    if (
      completed.status !== "passed" ||
      completed.immutable !== true ||
      completed.git_commit !== gitCommit
    ) {
      throw new Error(`completed stage ${name} is not immutable at campaign SHA ${gitCommit}`);
    }
    downloadDirectory(stageUri, stageDir);
    console.log(`resumed immutable completed stage ${name}`);
    return;
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const resources = { peak_rss_kib: 0, peak_disk_used_kib: diskUsedKiB(stageDir) };
  const run = makeCommandRunner(stageDir, resources);
  const startedAt = new Date();
  try {
    await callback({ stageDir, run, resources });
    uploadDirectory(stageDir, stageUri);
    const payload = {
      schema_version: "edger_remote_stage_status_v1",
      stage: name,
      status: "passed",
      immutable: true,
      git_commit: gitCommit,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      resources,
      limits: {
        peak_rss_kib_below: MEMORY_LIMIT_KIB,
        disk_used_kib_below: DISK_LIMIT_KIB,
      },
      artifacts: durableArtifacts(stageDir),
    };
    writeImmutableJson(completedUri, payload);
  } catch (error) {
    const attempt = new Date().toISOString().replaceAll(/[:.]/g, "-");
    uploadDirectory(stageDir, `${args.campaignUri}/failed-stages/${name}/${attempt}`);
    writeAttemptJson(
      `${args.campaignUri}/status/attempts/${name}-${attempt}.json`,
      {
        schema_version: "edger_remote_stage_status_v1",
        stage: name,
        status: "failed",
        immutable: false,
        git_commit: gitCommit,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        resources,
        error: error instanceof Error ? error.stack : String(error),
      },
    );
    throw error;
  }
}

const corpusManifest = path.join(args.workDir, "corpus-manifest.json");
if (!fs.existsSync(corpusManifest)) {
  aws([
    "s3",
    "cp",
    `${args.campaignUri}/corpus/manifest.json`,
    corpusManifest,
    "--only-show-errors",
  ]);
}

const scalingDir = path.join(args.workDir, "scaling");
const scaleLabels = ["1pct", "10pct", "100pct"];

function ensureScalingCaches(run) {
  if (scaleLabels.every((label) =>
    fs.existsSync(path.join(scalingDir, `edger_decisions_${label}.parquet`)))) {
    return;
  }
  fs.mkdirSync(scalingDir, { recursive: true });
  run("npm", [
    "run",
    "edger:dataset",
    "--",
    "--manifest",
    corpusManifest,
    "--scales-dir",
    scalingDir,
  ]);
}

await runStage("scaling", async ({ stageDir, run }) => {
  if (stageDir !== scalingDir) {
    throw new Error("scaling stage directory invariant failed");
  }
  ensureScalingCaches(run);
  for (const label of scaleLabels) {
    const dataset = path.join(stageDir, `edger_decisions_${label}.parquet`);
    const checkpoint = path.join(stageDir, `bc-${label}.pt`);
    const model = path.join(stageDir, `model-${label}.json`);
    const frozen = path.join(stageDir, `frozen-${label}.json`);
    run("npm", [
      "run", "edger:train:bc", "--",
      "--dataset", dataset,
      "--out", checkpoint,
      "--seed", String(SEED),
      "--epochs", "1",
      "--batch-size", "32",
      "--learning-rate", "1e-3",
    ]);
    run("npm", [
      "run", "edger:export:v2", "--",
      "--checkpoint", checkpoint,
      "--out", model,
    ]);
    run("npm", [
      "run", "edger:evaluate:scaling", "--",
      "--candidate", model,
      "--checkpoint", checkpoint,
      "--workers", "16",
      "--seed", String(SEED),
      "--out", frozen,
    ]);
  }
  run("npm", [
    "run", "edger:scaling:report", "--",
    "--one-checkpoint", path.join(stageDir, "bc-1pct.pt"),
    "--ten-checkpoint", path.join(stageDir, "bc-10pct.pt"),
    "--full-checkpoint", path.join(stageDir, "bc-100pct.pt"),
    "--one-manifest", path.join(stageDir, "edger_manifest_1pct.json"),
    "--ten-manifest", path.join(stageDir, "edger_manifest_10pct.json"),
    "--full-manifest", path.join(stageDir, "edger_manifest_100pct.json"),
    "--one-model", path.join(stageDir, "model-1pct.json"),
    "--ten-model", path.join(stageDir, "model-10pct.json"),
    "--full-model", path.join(stageDir, "model-100pct.json"),
    "--one-league", path.join(stageDir, "frozen-1pct.json"),
    "--ten-league", path.join(stageDir, "frozen-10pct.json"),
    "--full-league", path.join(stageDir, "frozen-100pct.json"),
    "--out", path.join(stageDir, "scaling_report.json"),
  ]);
});

const offlineDir = path.join(args.workDir, "offline");
await runStage("offline", async ({ stageDir, run }) => {
  ensureScalingCaches(run);
  const checkpoint = path.join(stageDir, "shadow-parent.pt");
  const model = path.join(stageDir, "shadow-parent.json");
  run("npm", [
    "run", "edger:train:offline", "--",
    "--dataset", path.join(scalingDir, "edger_decisions_100pct.parquet"),
    "--checkpoint", path.join(scalingDir, "bc-100pct.pt"),
    "--out", checkpoint,
    "--seed", String(SEED),
    "--epochs", "1",
    "--batch-size", "32",
    "--learning-rate", "1e-4",
  ]);
  run("npm", [
    "run", "edger:export:v2", "--",
    "--checkpoint", checkpoint,
    "--out", model,
  ]);
  const accepted = JSON.parse(fs.readFileSync(model, "utf8"));
  const kl = accepted.training?.metrics?.validation_kl_from_bc;
  if (!Number.isFinite(kl) || kl > 0.05) {
    throw new Error(`offline accepted validation KL ${kl} exceeds 0.05`);
  }
});

const referenceDir = path.join(args.workDir, "reference");
await runStage("live-v1-reference", async ({ stageDir, run }) => {
  const reference = path.join(stageDir, "live-champion-reference.json");
  run("npm", [
    "run", "edger:reference:v2", "--",
    "--champion", "artifacts/edger-training/promoted/edger_policy_current.json",
    "--games-per-opponent", "200",
    "--workers", "16",
    "--seed", String(SEED),
    "--out", reference,
  ]);
  const inputDir = path.join(stageDir, "campaign-input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.copyFileSync(
    path.join(scalingDir, "scaling_report.json"),
    path.join(inputDir, "scaling_report.json"),
  );
  fs.copyFileSync(
    path.join(offlineDir, "shadow-parent.json"),
    path.join(inputDir, "shadow-parent.json"),
  );
  fs.copyFileSync(
    path.join(offlineDir, "shadow-parent.pt"),
    path.join(inputDir, "shadow-parent.pt"),
  );
  fs.copyFileSync(
    "artifacts/edger-training/promoted/edger_policy_current.json",
    path.join(inputDir, "live-champion.json"),
  );
  fs.copyFileSync(reference, path.join(inputDir, "live-champion-reference.json"));
  uploadDirectory(inputDir, `${args.campaignUri}/campaign-input`);
});

await runStage("league-smoke", async ({ stageDir, run }) => {
  run("npm", [
    "run", "edger:train:league", "--",
    "--scaling-report", path.join(scalingDir, "scaling_report.json"),
    "--shadow-parent-model", path.join(offlineDir, "shadow-parent.json"),
    "--live-champion-model", "artifacts/edger-training/promoted/edger_policy_current.json",
    "--live-champion-reference", path.join(referenceDir, "live-champion-reference.json"),
    "--rollout-store", `${args.campaignUri}/league-smoke/rollout`,
    "--matches", "32",
    "--workers", "16",
    "--seed", String(SEED),
    "--manifest-out", path.join(stageDir, "smoke-manifest.json"),
    "--report-out", path.join(stageDir, "smoke-report.json"),
  ]);
});

const leagueDir = path.join(args.workDir, "league-production");
await runStage("league-production", async ({ stageDir, run }) => {
  const checkpoint = path.join(stageDir, "candidate.pt");
  run("npm", [
    "run", "edger:train:league", "--",
    "--scaling-report", path.join(scalingDir, "scaling_report.json"),
    "--shadow-parent-model", path.join(offlineDir, "shadow-parent.json"),
    "--shadow-parent-checkpoint", path.join(offlineDir, "shadow-parent.pt"),
    "--live-champion-model", "artifacts/edger-training/promoted/edger_policy_current.json",
    "--live-champion-reference", path.join(referenceDir, "live-champion-reference.json"),
    "--base-manifest", corpusManifest,
    "--rollout-store", `${args.campaignUri}/league-production/rollout`,
    "--matches", "1000",
    "--workers", "16",
    "--seed", String(SEED),
    "--epochs", "1",
    "--batch-size", "32",
    "--manifest-out", path.join(stageDir, "manifest.json"),
    "--dataset-out", path.join(stageDir, "league.parquet"),
    "--out-checkpoint", checkpoint,
    "--report-out", path.join(stageDir, "league-report.json"),
  ]);
  run("npm", [
    "run", "edger:export:v2", "--",
    "--checkpoint", checkpoint,
    "--out", path.join(stageDir, "candidate.json"),
  ]);
});

const qaDir = path.join(args.workDir, "qa");
await runStage("qa", async ({ stageDir, run }) => {
  run("npm", ["test"]);
  fs.writeFileSync(path.join(stageDir, "test-report.json"), `${JSON.stringify({
    schema_version: "edger_external_qa_report_v1",
    kind: "npm-test",
    command: "npm test",
    git_commit: gitCommit,
    passed: true,
  }, null, 2)}\n`);
  run("npm", ["run", "smoke:browser"]);
  fs.writeFileSync(path.join(stageDir, "browser-report.json"), `${JSON.stringify({
    schema_version: "edger_external_qa_report_v1",
    kind: "browser-smoke",
    command: "npm run smoke:browser",
    git_commit: gitCommit,
    passed: true,
  }, null, 2)}\n`);
});

const evaluationDir = path.join(args.workDir, "evaluation");
await runStage("full-evaluation", async ({ stageDir, run }) => {
  const candidate = path.join(leagueDir, "candidate.json");
  run("npm", [
    "run", "edger:benchmark:throughput", "--",
    "--candidate", candidate,
    "--matches", "32",
    "--workers", "16",
    "--target-matches", "11300",
    "--max-minutes", "180",
    "--reference-hardware", args.referenceHardware,
    "--out", path.join(stageDir, "throughput-report.json"),
    "--enforce",
  ]);
  run("npm", [
    "run", "edger:evaluate:v2", "--",
    "--candidate", candidate,
    "--champion", "artifacts/edger-training/promoted/edger_policy_current.json",
    "--reference", path.join(referenceDir, "live-champion-reference.json"),
    "--test-report", path.join(qaDir, "test-report.json"),
    "--browser-report", path.join(qaDir, "browser-report.json"),
    "--profile", "full",
    "--workers", "16",
    "--seed", String(SEED),
    "--reference-hardware", args.referenceHardware,
    "--out", path.join(stageDir, "evaluation-report.json"),
  ]);
  fs.copyFileSync(candidate, path.join(stageDir, "candidate.json"));
  uploadDirectory(stageDir, `${args.campaignUri}/ready-for-promotion`);
});

console.log(JSON.stringify({
  status: "passed",
  git_commit: gitCommit,
  campaign_uri: args.campaignUri,
  promotion_input_uri: `${args.campaignUri}/ready-for-promotion`,
}, null, 2));
