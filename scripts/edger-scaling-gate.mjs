export const SCALING_REPORT_SCHEMA = "edger_data_scaling_report_v2";

export const REQUIRED_SCALING_FACTS = Object.freeze([
  "passed",
  "full_improves_held_out_joint_action_loss",
  "full_non_regressing_frozen_league_score",
]);

export function assertScalingReportPassed(report) {
  if (report?.schema_version !== SCALING_REPORT_SCHEMA) {
    throw new Error(
      `league training requires ${SCALING_REPORT_SCHEMA}; got ${report?.schema_version ?? "missing"}`,
    );
  }
  const failures = REQUIRED_SCALING_FACTS.filter((key) => report[key] !== true);
  if (failures.length > 0) {
    throw new Error(
      `league training is gated by the scaling experiment: ${failures.join(", ")}`,
    );
  }
  return report;
}
