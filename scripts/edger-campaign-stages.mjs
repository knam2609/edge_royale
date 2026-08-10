export const TARGET_STAGES = Object.freeze([
  "full-cache",
  "offline",
  "full-evaluation",
]);

export const CAMPAIGN_STAGES = Object.freeze([
  "scaling",
  "full-cache",
  "offline",
  "live-v1-reference",
  "league-smoke",
  "league-production",
  "qa",
  "full-evaluation",
]);

const TERMINAL_STAGE = Object.freeze({
  "full-cache": "full-cache",
  offline: "offline",
  "full-evaluation": "full-evaluation",
});

export function assertTargetStage(targetStage) {
  if (!TARGET_STAGES.includes(targetStage)) {
    throw new Error(`--target-stage must be ${TARGET_STAGES.join(", ")}`);
  }
  return targetStage;
}

export function stagesThroughTarget(targetStage) {
  const terminal = TERMINAL_STAGE[assertTargetStage(targetStage)];
  return CAMPAIGN_STAGES.slice(0, CAMPAIGN_STAGES.indexOf(terminal) + 1);
}

export function isTargetTerminalStage(stage, targetStage) {
  return stage === TERMINAL_STAGE[assertTargetStage(targetStage)];
}

export function stageIncludesParquet(stage) {
  return stage === "full-cache";
}

export function assertCompletedStageMarker(marker, {
  stage,
  gitCommit,
  recoveryManifestChecksum,
}) {
  if (
    marker?.schema_version !== "edger_remote_stage_status_v2" ||
    marker.stage !== stage ||
    marker.status !== "passed" ||
    marker.immutable !== true ||
    marker.git_commit !== gitCommit ||
    marker.recovery_manifest_checksum !== recoveryManifestChecksum
  ) {
    throw new Error(
      `completed stage ${stage} does not match target SHA/recovery checksum`,
    );
  }
  return marker;
}
