import assert from "node:assert/strict";
import test from "node:test";

import {
  SCALING_REPORT_SCHEMA,
  assertScalingReportPassed,
} from "../scripts/edger-scaling-gate.mjs";

function passingReport() {
  return {
    schema_version: SCALING_REPORT_SCHEMA,
    passed: true,
    full_improves_held_out_joint_action_loss: true,
    full_non_regressing_frozen_league_score: true,
  };
}

test("scaling gate accepts relative loss improvement and league non-regression", () => {
  assert.equal(assertScalingReportPassed(passingReport()).passed, true);
});

test("scaling gate rejects legacy absolute-loss report contract", () => {
  assert.throws(
    () => assertScalingReportPassed({
      ...passingReport(),
      schema_version: "edger_data_scaling_report_v1",
      full_held_out_joint_action_loss_below_10pct: true,
    }),
    /requires edger_data_scaling_report_v2/,
  );
});

test("scaling gate rejects gameplay regression", () => {
  assert.throws(
    () => assertScalingReportPassed({
      ...passingReport(),
      full_non_regressing_frozen_league_score: false,
    }),
    /full_non_regressing_frozen_league_score/,
  );
});
