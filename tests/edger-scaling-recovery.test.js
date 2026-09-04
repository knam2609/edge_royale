import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  RECOVERY_CAMPAIGN_URI,
  RECOVERY_SOURCE_SHA,
  assertRecoveredEvidence,
  assertSourceLineage,
  sha256Bytes,
  validateRecoveryManifest,
  verifyVersionedArtifact,
} from "../scripts/edger-scaling-recovery.mjs";

const checkedInRecovery = JSON.parse(fs.readFileSync(
  "artifacts/edger-training/recovery/edger_scaling_recovery_v1.json",
  "utf8",
));

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function manifestHash(manifest) {
  const content = structuredClone(manifest);
  delete content.manifest_hash;
  return sha256Bytes(Buffer.from(JSON.stringify(canonicalValue(content))));
}

function recoveryFixture() {
  const recovery = structuredClone(checkedInRecovery);
  const scaleTrain = {
    "1pct": ["train-1"],
    "10pct": ["train-1", "train-2"],
    "100pct": ["train-1", "train-2", "train-3"],
  };
  const scales = {};
  for (const [index, label] of ["1pct", "10pct", "100pct"].entries()) {
    const manifest = {
      schema_version: "edger_dataset_manifest_v1",
      shards: [
        ...scaleTrain[label].map((episode_id) => ({ episode_id, split: "train" })),
        { episode_id: "validation-1", split: "validation" },
        { episode_id: "test-1", split: "test" },
      ],
    };
    manifest.manifest_hash = manifestHash(manifest);
    const expected = recovery.expected.scales[label];
    expected.manifest_hash = manifest.manifest_hash;
    expected.checkpoint_id = `checkpoint-${label}`;
    expected.validation_joint_action_loss = [5.66, 4.21, 3.69][index];
    expected.frozen_league_score = [0.54, 0.795, 0.86][index];
    recovery.scales[label].checkpoint.sha256 = String(index + 1).repeat(64);
    recovery.scales[label].model.sha256 = String(index + 4).repeat(64);
    const model = {
      schema_version: "edger_policy_model_v2",
      model_id: expected.checkpoint_id,
      training: {
        checkpoint_id: expected.checkpoint_id,
        git_commit: RECOVERY_SOURCE_SHA,
        dataset_manifest_hash: expected.manifest_hash,
        metrics: {
          validation: {
            joint_action_loss: expected.validation_joint_action_loss,
          },
        },
      },
    };
    const frozenReport = {
      schema_version: "edger_frozen_league_report_v1",
      candidate_checkpoint_id: expected.checkpoint_id,
      candidate_checkpoint_checksum: recovery.scales[label].checkpoint.sha256,
      candidate_model_id: model.model_id,
      candidate_model_checksum: recovery.scales[label].model.sha256,
      suite_spec_checksum: recovery.expected.suite_spec_checksum,
      frozen_league_score: expected.frozen_league_score,
      illegal_actions: 0,
      replay_checks: { all_passed: true },
    };
    scales[label] = { manifest, model, frozenReport };
  }
  recovery.expected.corpus_manifest_hash =
    recovery.expected.scales["100pct"].manifest_hash;
  const legacyReport = {
    schema_version: "edger_data_scaling_report_v1",
    passed: false,
    full_improves_held_out_joint_action_loss: true,
    full_held_out_joint_action_loss_below_10pct: false,
    full_non_regressing_frozen_league_score: true,
    suite_spec_checksum: recovery.expected.suite_spec_checksum,
    scales: Object.fromEntries(["1pct", "10pct", "100pct"].map((label) => [label, {
      checkpoint_id: recovery.expected.scales[label].checkpoint_id,
      manifest_hash: recovery.expected.scales[label].manifest_hash,
      candidate_checkpoint_checksum: recovery.scales[label].checkpoint.sha256,
      candidate_model_checksum: recovery.scales[label].model.sha256,
    }])),
  };
  const failedAttempt = {
    schema_version: "edger_remote_stage_status_v1",
    stage: "scaling",
    status: "failed",
    git_commit: RECOVERY_SOURCE_SHA,
    error: "Error: npm exited 2 (no signal)",
  };
  return { recovery, failedAttempt, legacyReport, scales };
}

test("valid checksum-bound recovery evidence passes", () => {
  const fixture = recoveryFixture();
  assert.equal(assertRecoveredEvidence(fixture.recovery, fixture), true);
});

test("corrected cache contract uses a fresh immutable campaign prefix", () => {
  assert.equal(checkedInRecovery.target.campaign_uri, RECOVERY_CAMPAIGN_URI);
  assert.ok(RECOVERY_CAMPAIGN_URI.endsWith("/20260904-v2-recovery"));
  assert.equal(checkedInRecovery.expected.cache.schema_sha256,
    "3623ade0a47e7b66b64f46581788b2dda46cee2b78b6b02c3ceeae34c11e2f5a");
  const oldTarget = structuredClone(checkedInRecovery);
  oldTarget.target.campaign_uri = RECOVERY_CAMPAIGN_URI.replace("20260904", "20260903");
  assert.throws(() => validateRecoveryManifest(oldTarget), /recovery target must remain/);
  const healthWorkflow = fs.readFileSync(".github/workflows/edger-corpus-health.yml", "utf8");
  assert.match(healthWorkflow, /process\.stdout\.write\(r\.target\.campaign_uri\)/);
  assert.ok(!healthWorkflow.includes("campaigns/20260810-v2-recovery"));
});

test("wrong S3 version or SHA-256 fails closed", () => {
  const entry = {
    local_name: "artifact.json",
    version_id: "version-1",
    sha256: sha256Bytes(Buffer.from("expected")),
  };
  assert.throws(
    () => verifyVersionedArtifact(entry, {
      versionId: "version-2",
      bytes: Buffer.from("expected"),
    }),
    /S3 version mismatch/,
  );
  assert.throws(
    () => verifyVersionedArtifact(entry, {
      versionId: "version-1",
      bytes: Buffer.from("different"),
    }),
    /SHA-256 mismatch/,
  );
});

test("wrong source SHA or ancestry fails closed", () => {
  const recovery = structuredClone(checkedInRecovery);
  recovery.source.git_commit = "0".repeat(40);
  assert.throws(() => validateRecoveryManifest(recovery), /source SHA/);
  assert.throws(
    () => assertSourceLineage(checkedInRecovery, "1".repeat(40), {
      isAncestor: () => false,
      changedProtectedPaths: () => [],
    }),
    /not an ancestor/,
  );
});

test("artifact binding, replay status, and gate reason fail closed", () => {
  const binding = recoveryFixture();
  binding.scales["10pct"].frozenReport.candidate_model_id = "wrong-model";
  assert.throws(() => assertRecoveredEvidence(binding.recovery, binding), /binding mismatch/);

  const replay = recoveryFixture();
  replay.scales["100pct"].frozenReport.replay_checks.all_passed = false;
  assert.throws(() => assertRecoveredEvidence(replay.recovery, replay), /replay verification/);

  const gate = recoveryFixture();
  gate.legacyReport.full_held_out_joint_action_loss_below_10pct = true;
  assert.throws(() => assertRecoveredEvidence(gate.recovery, gate), /not solely/);
});
