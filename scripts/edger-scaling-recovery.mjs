#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertScalingReportPassed } from "./edger-scaling-gate.mjs";

export const RECOVERY_SCHEMA = "edger_scaling_recovery_v1";
export const RECOVERY_REPORT_SCHEMA = "edger_scaling_recovery_report_v1";
export const RECOVERY_SOURCE_SHA = "f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33";
export const RECOVERY_SOURCE_CAMPAIGN_URI =
  "s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260718-v2-first";
export const RECOVERY_FAILED_STAGE_URI =
  `${RECOVERY_SOURCE_CAMPAIGN_URI}/failed-stages/scaling/2026-07-27T03-18-54-545Z`;
export const RECOVERY_CAMPAIGN_URI =
  "s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260904-v2-recovery";
export const SCALE_LABELS = Object.freeze(["1pct", "10pct", "100pct"]);
const ARTIFACT_KINDS = Object.freeze([
  "manifest",
  "checkpoint",
  "model",
  "frozen_report",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  const digest = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

export function parseS3ObjectUri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || match[2].endsWith("/")) {
    throw new Error(`recovery artifact requires exact S3 object URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}

function validateArtifactEntry(entry, label) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${label} artifact is missing`);
  }
  parseS3ObjectUri(entry.uri);
  if (typeof entry.version_id !== "string" || entry.version_id.length === 0) {
    throw new Error(`${label} artifact requires exact S3 version_id`);
  }
  if (!SHA256_PATTERN.test(entry.sha256 ?? "")) {
    throw new Error(`${label} artifact requires exact SHA-256`);
  }
  if (
    typeof entry.local_name !== "string" ||
    entry.local_name.length === 0 ||
    path.basename(entry.local_name) !== entry.local_name
  ) {
    throw new Error(`${label} artifact requires a safe local_name`);
  }
}

export function validateRecoveryManifest(recovery) {
  if (recovery?.schema_version !== RECOVERY_SCHEMA) {
    throw new Error(`scaling recovery requires ${RECOVERY_SCHEMA}`);
  }
  if (recovery.source?.git_commit !== RECOVERY_SOURCE_SHA) {
    throw new Error(`recovery source SHA must remain ${RECOVERY_SOURCE_SHA}`);
  }
  if (
    recovery.source?.campaign_uri !== RECOVERY_SOURCE_CAMPAIGN_URI ||
    recovery.source?.failed_stage_uri !== RECOVERY_FAILED_STAGE_URI
  ) {
    throw new Error("recovery source campaign/failure prefix changed");
  }
  if (recovery.target?.campaign_uri !== RECOVERY_CAMPAIGN_URI) {
    throw new Error(`recovery target must remain ${RECOVERY_CAMPAIGN_URI}`);
  }
  if (
    !Array.isArray(recovery.source.protected_derivation_paths) ||
    recovery.source.protected_derivation_paths.length === 0
  ) {
    throw new Error("recovery requires protected dataset/simulator derivation paths");
  }
  validateArtifactEntry(recovery.failed_attempt, "failed attempt");
  validateArtifactEntry(recovery.legacy_report, "legacy scaling report");
  if (
    recovery.failed_attempt.uri !==
      `${RECOVERY_SOURCE_CAMPAIGN_URI}/status/attempts/scaling-2026-07-27T03-18-54-545Z.json` ||
    recovery.legacy_report.uri !== `${RECOVERY_FAILED_STAGE_URI}/scaling_report.json`
  ) {
    throw new Error("recovery attempt/report URI changed");
  }
  for (const label of SCALE_LABELS) {
    for (const kind of ARTIFACT_KINDS) {
      const entry = recovery.scales?.[label]?.[kind];
      validateArtifactEntry(entry, `${label} ${kind}`);
      const expectedName = kind === "manifest"
        ? `edger_manifest_${label}.json`
        : kind === "checkpoint"
          ? `bc-${label}.pt`
          : kind === "model"
            ? `model-${label}.json`
            : `frozen-${label}.json`;
      if (
        entry.local_name !== expectedName ||
        entry.uri !== `${RECOVERY_FAILED_STAGE_URI}/${expectedName}`
      ) {
        throw new Error(`${label} ${kind} recovery object path changed`);
      }
    }
  }
  if (recovery.expected?.failure_gate !== "full_held_out_joint_action_loss_below_10pct") {
    throw new Error("recovery failure reason must remain removed <0.10 gate");
  }
  if (!SHA256_PATTERN.test(recovery.expected?.corpus_manifest_hash ?? "")) {
    throw new Error("recovery expected corpus manifest hash is invalid");
  }
  if (!SHA256_PATTERN.test(recovery.expected?.suite_spec_checksum ?? "")) {
    throw new Error("recovery expected suite checksum is invalid");
  }
  return recovery;
}

export function assertSourceLineage(recovery, targetGitSha, {
  isAncestor = (source, target) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", source, target]);
    return result.status === 0;
  },
  changedProtectedPaths = (source, target, protectedPaths) => {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${source}..${target}`, "--", ...protectedPaths],
      { encoding: "utf8" },
    ).trim();
    return output ? output.split("\n") : [];
  },
} = {}) {
  validateRecoveryManifest(recovery);
  if (!/^[a-f0-9]{40}$/.test(targetGitSha ?? "")) {
    throw new Error("recovery target Git SHA must be a full 40-character SHA");
  }
  if (!isAncestor(recovery.source.git_commit, targetGitSha)) {
    throw new Error("recovery source SHA is not an ancestor of target SHA");
  }
  const changed = changedProtectedPaths(
    recovery.source.git_commit,
    targetGitSha,
    recovery.source.protected_derivation_paths,
  );
  if (changed.length > 0) {
    throw new Error(`protected recovery derivation changed: ${changed.join(", ")}`);
  }
  return {
    source_git_commit: recovery.source.git_commit,
    target_git_commit: targetGitSha,
    protected_derivation_paths: recovery.source.protected_derivation_paths,
  };
}

export function verifyVersionedArtifact(entry, { versionId, bytes }, label = entry.local_name) {
  if (versionId !== entry.version_id) {
    throw new Error(`${label} S3 version mismatch`);
  }
  const actualHash = sha256Bytes(bytes);
  if (actualHash !== entry.sha256) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
  return actualHash;
}

function exactNumber(actual, expected, label) {
  if (!Number.isFinite(actual) || actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function splitIds(manifest, split) {
  return manifest.shards
    .filter((shard) => shard.split === split)
    .map((shard) => shard.episode_id);
}

function manifestContentHash(manifest) {
  const content = structuredClone(manifest);
  delete content.manifest_hash;
  return sha256Bytes(Buffer.from(canonicalJson(content)));
}

export function assertRecoveredEvidence(recovery, {
  failedAttempt,
  legacyReport,
  scales,
}) {
  validateRecoveryManifest(recovery);
  if (
    failedAttempt?.schema_version !== "edger_remote_stage_status_v1" ||
    failedAttempt.stage !== "scaling" ||
    failedAttempt.status !== "failed" ||
    failedAttempt.git_commit !== recovery.source.git_commit
  ) {
    throw new Error("failed scaling attempt provenance mismatch");
  }
  if (!String(failedAttempt.error ?? "").includes("npm exited 2")) {
    throw new Error("failed scaling attempt does not record report gate exit 2");
  }
  const failureGate = recovery.expected.failure_gate;
  if (
    legacyReport?.schema_version !== "edger_data_scaling_report_v1" ||
    legacyReport.passed !== false ||
    legacyReport.full_improves_held_out_joint_action_loss !== true ||
    legacyReport.full_non_regressing_frozen_league_score !== true ||
    legacyReport[failureGate] !== false
  ) {
    throw new Error("legacy scaling failure was not solely removed <0.10 gate");
  }
  if (legacyReport.suite_spec_checksum !== recovery.expected.suite_spec_checksum) {
    throw new Error("legacy scaling suite checksum mismatch");
  }

  for (const label of SCALE_LABELS) {
    const evidence = scales[label];
    const expected = recovery.expected.scales[label];
    const manifest = evidence.manifest;
    const model = evidence.model;
    const frozen = evidence.frozenReport;
    if (
      manifest?.schema_version !== "edger_dataset_manifest_v1" ||
      manifest.manifest_hash !== expected.manifest_hash ||
      manifestContentHash(manifest) !== manifest.manifest_hash
    ) {
      throw new Error(`${label} recovered manifest binding mismatch`);
    }
    if (
      model?.schema_version !== "edger_policy_model_v2" ||
      model.model_id !== expected.checkpoint_id ||
      model.training?.checkpoint_id !== expected.checkpoint_id ||
      model.training?.git_commit !== recovery.source.git_commit ||
      model.training?.dataset_manifest_hash !== expected.manifest_hash
    ) {
      throw new Error(`${label} recovered model/checkpoint binding mismatch`);
    }
    if (
      frozen?.schema_version !== "edger_frozen_league_report_v1" ||
      frozen.candidate_checkpoint_id !== expected.checkpoint_id ||
      frozen.candidate_checkpoint_checksum !== recovery.scales[label].checkpoint.sha256 ||
      frozen.candidate_model_id !== model.model_id ||
      frozen.candidate_model_checksum !== recovery.scales[label].model.sha256 ||
      frozen.suite_spec_checksum !== recovery.expected.suite_spec_checksum
    ) {
      throw new Error(`${label} recovered frozen-report binding mismatch`);
    }
    if (frozen.illegal_actions !== recovery.expected.illegal_actions) {
      throw new Error(`${label} recovered frozen report contains illegal actions`);
    }
    if (frozen.replay_checks?.all_passed !== recovery.expected.replay_checks_all_passed) {
      throw new Error(`${label} recovered replay verification failed`);
    }
    exactNumber(
      model.training?.metrics?.validation?.joint_action_loss,
      expected.validation_joint_action_loss,
      `${label} validation loss`,
    );
    exactNumber(frozen.frozen_league_score, expected.frozen_league_score, `${label} score`);
    const legacyScale = legacyReport.scales?.[label];
    if (
      legacyScale?.checkpoint_id !== expected.checkpoint_id ||
      legacyScale.manifest_hash !== expected.manifest_hash ||
      legacyScale.candidate_checkpoint_checksum !== recovery.scales[label].checkpoint.sha256 ||
      legacyScale.candidate_model_checksum !== recovery.scales[label].model.sha256
    ) {
      throw new Error(`${label} legacy report artifact binding mismatch`);
    }
  }

  const training = Object.fromEntries(
    SCALE_LABELS.map((label) => [label, new Set(splitIds(scales[label].manifest, "train"))]),
  );
  if (
    [...training["1pct"]].some((episode) => !training["10pct"].has(episode)) ||
    [...training["10pct"]].some((episode) => !training["100pct"].has(episode))
  ) {
    throw new Error("recovered scaling training sets are not nested");
  }
  for (const split of ["validation", "test"]) {
    const expected = canonicalJson(splitIds(scales["100pct"].manifest, split));
    for (const label of ["1pct", "10pct"]) {
      if (canonicalJson(splitIds(scales[label].manifest, split)) !== expected) {
        throw new Error(`recovered ${split} sets are not identical`);
      }
    }
  }
  if (scales["100pct"].manifest.manifest_hash !== recovery.expected.corpus_manifest_hash) {
    throw new Error("recovered 100% manifest is not expected corpus manifest");
  }
  return true;
}

function artifactEntries(recovery) {
  return [
    ["failed-attempt", recovery.failed_attempt],
    ["legacy-report", recovery.legacy_report],
    ...SCALE_LABELS.flatMap((label) => ARTIFACT_KINDS.map(
      (kind) => [`${label}-${kind}`, recovery.scales[label][kind]],
    )),
  ];
}

function downloadVersionedArtifact(entry, output, region) {
  if (fs.existsSync(output)) {
    throw new Error(`recovery output already exists: ${output}`);
  }
  const { bucket, key } = parseS3ObjectUri(entry.uri);
  const response = JSON.parse(execFileSync("aws", [
    "s3api",
    "get-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--version-id",
    entry.version_id,
    "--region",
    region,
    "--output",
    "json",
    output,
  ], { encoding: "utf8" }));
  verifyVersionedArtifact(entry, {
    versionId: response.VersionId,
    bytes: fs.readFileSync(output),
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function scalingReportArguments(outputDir) {
  const argumentsList = ["run", "edger:scaling:report", "--"];
  const flagNames = {
    checkpoint: "checkpoint",
    manifest: "manifest",
    model: "model",
    frozen_report: "league",
  };
  const prefixes = { "1pct": "one", "10pct": "ten", "100pct": "full" };
  for (const kind of ARTIFACT_KINDS) {
    for (const label of SCALE_LABELS) {
      argumentsList.push(
        `--${prefixes[label]}-${flagNames[kind]}`,
        path.join(outputDir, kind === "frozen_report"
          ? `frozen-${label}.json`
          : kind === "checkpoint"
            ? `bc-${label}.pt`
            : kind === "manifest"
              ? `edger_manifest_${label}.json`
              : `model-${label}.json`),
      );
    }
  }
  argumentsList.push("--out", path.join(outputDir, "scaling_report.json"));
  return argumentsList;
}

export function assertRegeneratedReport(recovery, report) {
  assertScalingReportPassed(report);
  if (report.suite_spec_checksum !== recovery.expected.suite_spec_checksum) {
    throw new Error("regenerated scaling suite checksum mismatch");
  }
  for (const label of SCALE_LABELS) {
    const actual = report.scales?.[label];
    const expected = recovery.expected.scales[label];
    if (
      actual?.checkpoint_id !== expected.checkpoint_id ||
      actual.source_checkpoint_git_commit !== recovery.source.git_commit ||
      actual.manifest_hash !== expected.manifest_hash
    ) {
      throw new Error(`${label} regenerated scaling lineage mismatch`);
    }
    exactNumber(
      actual.validation_joint_action_loss,
      expected.validation_joint_action_loss,
      `${label} regenerated validation loss`,
    );
    exactNumber(actual.frozen_league_score, expected.frozen_league_score, `${label} regenerated score`);
  }
  return report;
}

export function recoverScalingArtifacts({
  manifestPath,
  outputDir,
  targetGitSha,
  targetCampaignUri,
  region = process.env.AWS_REGION ?? "ap-southeast-2",
}) {
  const manifestBytes = fs.readFileSync(manifestPath);
  const recovery = validateRecoveryManifest(JSON.parse(manifestBytes));
  if (targetCampaignUri !== recovery.target.campaign_uri) {
    throw new Error("recovery command target campaign URI mismatch");
  }
  const sourceLineage = assertSourceLineage(recovery, targetGitSha);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [, entry] of artifactEntries(recovery)) {
    downloadVersionedArtifact(entry, path.join(outputDir, entry.local_name), region);
  }
  const recovered = Object.fromEntries(SCALE_LABELS.map((label) => [label, {
    manifest: readJson(path.join(outputDir, recovery.scales[label].manifest.local_name)),
    model: readJson(path.join(outputDir, recovery.scales[label].model.local_name)),
    frozenReport: readJson(path.join(outputDir, recovery.scales[label].frozen_report.local_name)),
  }]));
  const failedAttempt = readJson(path.join(outputDir, recovery.failed_attempt.local_name));
  const legacyReport = readJson(path.join(outputDir, recovery.legacy_report.local_name));
  assertRecoveredEvidence(recovery, {
    failedAttempt,
    legacyReport,
    scales: recovered,
  });
  const regenerated = spawnSync("npm", scalingReportArguments(outputDir), {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (regenerated.error) {
    throw regenerated.error;
  }
  if (regenerated.status !== 0) {
    throw new Error(`scaling report regeneration exited ${regenerated.status}`);
  }
  const scalingReport = assertRegeneratedReport(
    recovery,
    readJson(path.join(outputDir, "scaling_report.json")),
  );
  const report = {
    schema_version: RECOVERY_REPORT_SCHEMA,
    passed: true,
    target_campaign_uri: targetCampaignUri,
    recovery_manifest_sha256: sha256Bytes(manifestBytes),
    source_lineage: {
      ...sourceLineage,
      source_campaign_uri: recovery.source.campaign_uri,
      source_failed_stage_uri: recovery.source.failed_stage_uri,
      failed_attempt: {
        uri: recovery.failed_attempt.uri,
        version_id: recovery.failed_attempt.version_id,
        sha256: recovery.failed_attempt.sha256,
      },
      legacy_report: {
        uri: recovery.legacy_report.uri,
        version_id: recovery.legacy_report.version_id,
        sha256: recovery.legacy_report.sha256,
      },
      recovered_artifacts: Object.fromEntries(SCALE_LABELS.map((label) => [
        label,
        Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, {
          uri: recovery.scales[label][kind].uri,
          version_id: recovery.scales[label][kind].version_id,
          sha256: recovery.scales[label][kind].sha256,
        }])),
      ])),
    },
    regenerated_scaling_report_sha256: sha256File(
      path.join(outputDir, "scaling_report.json"),
    ),
    scaling_report: {
      schema_version: scalingReport.schema_version,
      suite_spec_checksum: scalingReport.suite_spec_checksum,
      scales: scalingReport.scales,
    },
  };
  fs.writeFileSync(
    path.join(outputDir, "recovery_report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

function parseArgs(argv) {
  const parsed = {
    manifestPath: null,
    outputDir: null,
    targetGitSha: null,
    targetCampaignUri: null,
    region: process.env.AWS_REGION ?? "ap-southeast-2",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" && argv[index + 1]) {
      parsed.manifestPath = path.resolve(argv[++index]);
    } else if (arg === "--out-dir" && argv[index + 1]) {
      parsed.outputDir = path.resolve(argv[++index]);
    } else if (arg === "--target-git-sha" && argv[index + 1]) {
      parsed.targetGitSha = argv[++index];
    } else if (arg === "--campaign-uri" && argv[index + 1]) {
      parsed.targetCampaignUri = argv[++index].replace(/\/+$/, "");
    } else if (arg === "--region" && argv[index + 1]) {
      parsed.region = argv[++index];
    }
  }
  if (!parsed.manifestPath || !parsed.outputDir || !parsed.targetCampaignUri) {
    throw new Error("--manifest, --out-dir, and --campaign-uri are required");
  }
  parsed.targetGitSha ??= execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return parsed;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = recoverScalingArtifacts(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
