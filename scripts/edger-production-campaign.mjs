#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  assertCompletedStageMarker,
  assertTargetStage,
  isTargetTerminalStage,
  stageIncludesParquet,
} from "./edger-campaign-stages.mjs";
import {
  validateRecoveryManifest,
} from "./edger-scaling-recovery.mjs";

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
    targetStage: process.env.EDGER_TARGET_STAGE ?? "full-evaluation",
    scalingRecoveryManifest:
      process.env.EDGER_SCALING_RECOVERY_MANIFEST ?? null,
    runLabel: process.env.EDGER_RUN_LABEL ?? `local-${process.pid}`,
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
    } else if (arg === "--target-stage" && argv[index + 1]) {
      parsed.targetStage = argv[++index];
    } else if (arg === "--scaling-recovery-manifest" && argv[index + 1]) {
      parsed.scalingRecoveryManifest = path.resolve(argv[++index]);
    } else if (arg === "--run-label" && argv[index + 1]) {
      parsed.runLabel = argv[++index];
    }
  }
  if (!parsed.campaignUri?.startsWith("s3://")) {
    throw new Error("--campaign-uri must be an s3:// URI");
  }
  if (!parsed.corpusStore?.startsWith("s3://")) {
    throw new Error("--corpus-store must be an s3:// URI");
  }
  assertTargetStage(parsed.targetStage);
  if (!parsed.scalingRecoveryManifest) {
    throw new Error("--scaling-recovery-manifest is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(parsed.runLabel)) {
    throw new Error("--run-label may contain only letters, numbers, dot, underscore, dash");
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

function listLocalFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function tryHeadS3Object(uri) {
  const { bucket, key } = parseS3Uri(uri);
  try {
    return JSON.parse(aws([
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--output",
      "json",
    ]));
  } catch {
    return null;
  }
}

function objectMetadata({ sha256, gitCommit, recoveryManifestChecksum }) {
  return {
    sha256,
    "git-commit": gitCommit,
    "recovery-checksum": recoveryManifestChecksum,
  };
}

function assertObjectMetadata(head, expected, uri) {
  const actual = head?.Metadata ?? {};
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`existing target object metadata mismatch at ${uri}: ${key}`);
    }
  }
}

function uploadFileImmutable(localFile, uri, bindings) {
  const checksum = sha256File(localFile);
  const metadata = objectMetadata({ sha256: checksum, ...bindings });
  const existing = tryHeadS3Object(uri);
  if (existing) {
    assertObjectMetadata(existing, metadata, uri);
    return checksum;
  }
  aws([
    "s3",
    "cp",
    localFile,
    uri,
    "--metadata",
    Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join(","),
    "--checksum-algorithm",
    "SHA256",
    "--only-show-errors",
  ], { stdio: "inherit", encoding: undefined });
  const uploaded = tryHeadS3Object(uri);
  if (!uploaded) {
    throw new Error(`immutable upload missing after write: ${uri}`);
  }
  assertObjectMetadata(uploaded, metadata, uri);
  return checksum;
}

function uploadDirectoryImmutable(localDir, uri, {
  includeParquet = false,
  bindings,
} = {}) {
  const selected = listLocalFiles(localDir).filter((filePath) => {
    if (filePath.endsWith(".time.txt")) {
      return false;
    }
    if (filePath.endsWith(".parquet") && !includeParquet) {
      return false;
    }
    return true;
  });
  const { bucket, key } = parseS3Uri(uri.replace(/\/+$/, ""));
  const prefix = `${key}/`;
  const existing = JSON.parse(aws([
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--prefix",
    prefix,
    "--output",
    "json",
  ])).Contents ?? [];
  const selectedPaths = new Set(selected.map(
    (filePath) => path.relative(localDir, filePath).split(path.sep).join("/"),
  ));
  const unexpected = existing
    .map((object) => object.Key.slice(prefix.length))
    .filter((relative) => relative && !selectedPaths.has(relative));
  if (unexpected.length > 0) {
    throw new Error(`existing target prefix contains unbound objects: ${unexpected.join(", ")}`);
  }
  for (const filePath of selected) {
    const relative = path.relative(localDir, filePath).split(path.sep).join("/");
    uploadFileImmutable(filePath, `${uri.replace(/\/+$/, "")}/${relative}`, bindings);
  }
}

function uploadFailureDirectory(localDir, uri) {
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

function writeImmutableJson(uri, payload, bindings) {
  const temporary = path.join(
    os.tmpdir(),
    `edger-status-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  const { bucket, key } = parseS3Uri(uri);
  try {
    if (tryHeadS3Object(uri)) {
      throw new Error(`immutable marker already exists: ${uri}`);
    }
    const checksum = sha256File(temporary);
    const metadata = objectMetadata({ sha256: checksum, ...bindings });
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
      "--checksum-algorithm",
      "SHA256",
      "--metadata",
      Object.entries(metadata).map(([name, value]) => `${name}=${value}`).join(","),
    ]);
    const uploaded = tryHeadS3Object(uri);
    if (!uploaded) {
      throw new Error(`immutable marker missing after write: ${uri}`);
    }
    assertObjectMetadata(uploaded, metadata, uri);
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

function durableArtifacts(root, { includeParquet = false } = {}) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return listLocalFiles(root)
    .filter((filePath) => !filePath.endsWith(".time.txt"))
    .filter((filePath) => includeParquet || !filePath.endsWith(".parquet"))
    .map((filePath) => ({
      path: path.relative(root, filePath).split(path.sep).join("/"),
      bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function verifyStageArtifacts(root, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("completed stage marker has no checksum-bound artifacts");
  }
  for (const artifact of artifacts) {
    const filePath = path.join(root, artifact.path);
    if (
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).size !== artifact.bytes ||
      sha256File(filePath) !== artifact.sha256
    ) {
      throw new Error(`resumed stage artifact checksum mismatch: ${artifact.path}`);
    }
  }
  const expectedPaths = new Set(artifacts.map((artifact) => artifact.path));
  const unexpected = listLocalFiles(root)
    .map((filePath) => path.relative(root, filePath).split(path.sep).join("/"))
    .filter((relative) => !expectedPaths.has(relative));
  if (unexpected.length > 0) {
    throw new Error(`resumed stage contains unbound target objects: ${unexpected.join(", ")}`);
  }
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gitCommit = currentGitCommit();
  requireCleanGit();
  const recovery = validateRecoveryManifest(
    JSON.parse(fs.readFileSync(args.scalingRecoveryManifest, "utf8")),
  );
  if (args.campaignUri !== recovery.target.campaign_uri) {
    throw new Error("campaign URI does not match scaling recovery manifest target");
  }
  const recoveryManifestChecksum = sha256File(args.scalingRecoveryManifest);
  const bindings = { gitCommit, recoveryManifestChecksum };
  fs.mkdirSync(args.workDir, { recursive: true });

  async function runStage(name, callback) {
    const stageDir = path.join(args.workDir, name);
    const completedUri = `${args.campaignUri}/status/completed/${name}.json`;
    const stageUri = `${args.campaignUri}/stages/${name}`;
    const completedHead = tryHeadS3Object(completedUri);
    const completed = tryReadS3Json(completedUri);
    if (completedHead && !completed) {
      throw new Error(`existing completed marker is invalid JSON: ${completedUri}`);
    }
    if (completed) {
      assertCompletedStageMarker(completed, {
        stage: name,
        gitCommit,
        recoveryManifestChecksum,
      });
      fs.rmSync(stageDir, { recursive: true, force: true });
      downloadDirectory(stageUri, stageDir);
      verifyStageArtifacts(stageDir, completed.artifacts);
      console.log(`resumed immutable completed stage ${name}`);
      return completed.evidence ?? null;
    }

    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const resources = {
      peak_rss_kib: 0,
      peak_disk_used_kib: diskUsedKiB(stageDir),
    };
    const run = makeCommandRunner(stageDir, resources);
    const startedAt = new Date();
    try {
      const evidence = await callback({ stageDir, run, resources });
      const includeParquet = stageIncludesParquet(name);
      uploadDirectoryImmutable(stageDir, stageUri, { includeParquet, bindings });
      const payload = {
        schema_version: "edger_remote_stage_status_v2",
        stage: name,
        status: "passed",
        immutable: true,
        git_commit: gitCommit,
        recovery_manifest_checksum: recoveryManifestChecksum,
        target_stage: args.targetStage,
        run_label: args.runLabel,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        resources,
        limits: {
          peak_rss_kib_below: MEMORY_LIMIT_KIB,
          disk_used_kib_below: DISK_LIMIT_KIB,
        },
        artifacts: durableArtifacts(stageDir, { includeParquet }),
        evidence: evidence ?? null,
      };
      writeImmutableJson(completedUri, payload, bindings);
      return evidence ?? null;
    } catch (error) {
      const attempt = new Date().toISOString().replaceAll(/[:.]/g, "-");
      uploadFailureDirectory(
        stageDir,
        `${args.campaignUri}/failed-stages/${name}/${attempt}`,
      );
      writeAttemptJson(
        `${args.campaignUri}/status/attempts/${name}-${attempt}.json`,
        {
          schema_version: "edger_remote_stage_status_v2",
          stage: name,
          status: "failed",
          immutable: false,
          git_commit: gitCommit,
          recovery_manifest_checksum: recoveryManifestChecksum,
          target_stage: args.targetStage,
          run_label: args.runLabel,
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          resources,
          error: error instanceof Error ? error.stack : String(error),
        },
      );
      throw error;
    }
  }

  function finishTarget() {
    console.log(JSON.stringify({
      status: "passed",
      target_stage: args.targetStage,
      git_commit: gitCommit,
      campaign_uri: args.campaignUri,
      recovery_manifest_checksum: recoveryManifestChecksum,
      run_label: args.runLabel,
      promotion_input_uri: args.targetStage === "full-evaluation"
        ? `${args.campaignUri}/ready-for-promotion`
        : null,
    }, null, 2));
  }

  const scalingDir = path.join(args.workDir, "scaling");
  await runStage("scaling", async ({ stageDir, run }) => {
    run("npm", [
      "run",
      "edger:scaling:recover",
      "--",
      "--manifest",
      args.scalingRecoveryManifest,
      "--out-dir",
      stageDir,
      "--target-git-sha",
      gitCommit,
      "--campaign-uri",
      args.campaignUri,
    ]);
    const recoveryReport = JSON.parse(
      fs.readFileSync(path.join(stageDir, "recovery_report.json"), "utf8"),
    );
    if (
      recoveryReport.passed !== true ||
      recoveryReport.recovery_manifest_sha256 !== recoveryManifestChecksum ||
      recoveryReport.source_lineage?.target_git_commit !== gitCommit
    ) {
      throw new Error("recovered scaling report lineage mismatch");
    }
    return {
      recovery_manifest_checksum: recoveryManifestChecksum,
      source_lineage: recoveryReport.source_lineage,
      regenerated_scaling_report_sha256:
        recoveryReport.regenerated_scaling_report_sha256,
    };
  });

  const corpusManifest = path.join(scalingDir, "edger_manifest_100pct.json");
  uploadFileImmutable(
    corpusManifest,
    `${args.campaignUri}/corpus/manifest.json`,
    bindings,
  );

  const fullCacheDir = path.join(args.workDir, "full-cache");
  await runStage("full-cache", async ({ stageDir, run }) => {
    // Exercise the pinned cache contract in this runner before the hours-long scan.
    run("npm", ["run", "test:edger-streaming"]);
    const dataset = path.join(stageDir, "edger_decisions_100pct.parquet");
    const buildReport = `${dataset}.build.json`;
    const validationReport = path.join(stageDir, "cache-validation.json");
    run("npm", [
      "run",
      "edger:dataset",
      "--",
      "--manifest",
      corpusManifest,
      "--out",
      dataset,
    ]);
    const expected = recovery.expected.cache;
    run("npm", [
      "run",
      "edger:cache:validate",
      "--",
      "--dataset",
      dataset,
      "--build-report",
      buildReport,
      "--manifest-hash",
      recovery.expected.corpus_manifest_hash,
      "--schema-sha256",
      expected.schema_sha256,
      "--rows",
      String(expected.rows),
      "--train-rows",
      String(expected.split_rows.train),
      "--validation-rows",
      String(expected.split_rows.validation),
      "--test-rows",
      String(expected.split_rows.test),
      "--out",
      validationReport,
    ]);
    const validation = JSON.parse(fs.readFileSync(validationReport, "utf8"));
    if (validation.passed !== true) {
      throw new Error("full cache validation did not pass");
    }
    return {
      manifest_hash: validation.manifest_hash,
      rows: validation.rows,
      split_rows: validation.split_rows,
      parquet_schema_sha256: validation.parquet_schema_sha256,
      logical_content_sha256: validation.logical_content_sha256,
      parquet_sha256: validation.parquet_sha256,
    };
  });

  if (isTargetTerminalStage("full-cache", args.targetStage)) {
    finishTarget();
    return;
  }

  const offlineDir = path.join(args.workDir, "offline");
  await runStage("offline", async ({ stageDir, run }) => {
    const checkpoint = path.join(stageDir, "shadow-parent.pt");
    const model = path.join(stageDir, "shadow-parent.json");
    const recoveredParent = recovery.expected.scales["100pct"].checkpoint_id;
    run("npm", [
      "run", "edger:train:offline", "--",
      "--dataset", path.join(fullCacheDir, "edger_decisions_100pct.parquet"),
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
    if (accepted.training?.git_commit !== gitCommit) {
      throw new Error("offline checkpoint is not bound to current campaign Git SHA");
    }
    if (accepted.training?.parent_checkpoint !== recoveredParent) {
      throw new Error("offline checkpoint parent is not exact recovered 100% checkpoint");
    }
    if (!Number.isFinite(kl) || kl > 0.05) {
      throw new Error(`offline accepted validation KL ${kl} exceeds 0.05`);
    }
    return {
      checkpoint_id: accepted.training.checkpoint_id,
      git_commit: accepted.training.git_commit,
      parent_checkpoint: accepted.training.parent_checkpoint,
      validation_kl_from_bc: kl,
    };
  });

  if (isTargetTerminalStage("offline", args.targetStage)) {
    finishTarget();
    return;
  }

  const referenceDir = path.join(args.workDir, "live-v1-reference");
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
    uploadDirectoryImmutable(inputDir, `${args.campaignUri}/campaign-input`, {
      bindings,
    });
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
    uploadDirectoryImmutable(stageDir, `${args.campaignUri}/ready-for-promotion`, {
      bindings,
    });
    return {
      candidate_sha256: sha256File(path.join(stageDir, "candidate.json")),
      evaluation_report_sha256: sha256File(
        path.join(stageDir, "evaluation-report.json"),
      ),
    };
  });

  finishTarget();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
