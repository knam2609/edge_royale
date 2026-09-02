import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertCompletedStageMarker,
  stageIncludesParquet,
  stagesThroughTarget,
} from "../scripts/edger-campaign-stages.mjs";

test("target stages stop at full-cache, offline, or full-evaluation and resume prerequisites", () => {
  assert.deepEqual(stagesThroughTarget("full-cache"), ["scaling", "full-cache"]);
  assert.deepEqual(stagesThroughTarget("offline"), [
    "scaling",
    "full-cache",
    "offline",
  ]);
  assert.deepEqual(stagesThroughTarget("full-evaluation"), [
    "scaling",
    "full-cache",
    "offline",
    "live-v1-reference",
    "league-smoke",
    "league-production",
    "qa",
    "full-evaluation",
  ]);
});

test("Parquet is durable only in full-cache stage", () => {
  assert.equal(stageIncludesParquet("full-cache"), true);
  for (const stage of ["scaling", "offline", "league-production", "full-evaluation"]) {
    assert.equal(stageIncludesParquet(stage), false);
  }
});

test("full-cache runs the pinned contract tests before scanning the corpus", () => {
  const source = fs.readFileSync("scripts/edger-production-campaign.mjs", "utf8");
  const fullCache = source.slice(source.indexOf('await runStage("full-cache"'));
  const preflight = fullCache.indexOf('run("npm", ["run", "test:edger-streaming"])');
  assert.ok(preflight >= 0);
  assert.ok(preflight < fullCache.indexOf('"edger:dataset"'));
  const launcher = fs.readFileSync("scripts/edger-streaming-tests.mjs", "utf8");
  assert.match(launcher, /PYTHONDONTWRITEBYTECODE: "1"/);
});

test("existing target marker with mismatched SHA or recovery checksum is refused", () => {
  const marker = {
    schema_version: "edger_remote_stage_status_v2",
    stage: "offline",
    status: "passed",
    immutable: true,
    git_commit: "a".repeat(40),
    recovery_manifest_checksum: "b".repeat(64),
  };
  assert.equal(assertCompletedStageMarker(marker, {
    stage: "offline",
    gitCommit: "a".repeat(40),
    recoveryManifestChecksum: "b".repeat(64),
  }), marker);
  assert.throws(
    () => assertCompletedStageMarker(marker, {
      stage: "offline",
      gitCommit: "c".repeat(40),
      recoveryManifestChecksum: "b".repeat(64),
    }),
    /does not match/,
  );
  assert.throws(
    () => assertCompletedStageMarker(marker, {
      stage: "offline",
      gitCommit: "a".repeat(40),
      recoveryManifestChecksum: "d".repeat(64),
    }),
    /does not match/,
  );
});
