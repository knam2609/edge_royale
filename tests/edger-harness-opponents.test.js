import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { EDGER_RETIRED_V1_MODEL } from "../scripts/edger-harness-opponents.mjs";
import { runCollectionSpec, runDeterministicCollectionCanary } from "../scripts/edger-collection-core.mjs";
import { runCadenceSpec } from "../scripts/edger-v2-cadence-worker.mjs";

// Owner decision, November 28, 2026 (docs/EDGER_HARNESS_REVIEW.md): the bare
// `edger` id in the cadence tooling and corpus collection plays the retired
// v1. The expected values were produced by the same calls on a clean checkout
// of 503ebd9 (pre-rewrite d53fdf8), the last commit with v1 live, and must
// not move.
const RETIRED_V1_MODULE = new URL(
  "../artifacts/edger-training/retired/edger_policy_bootstrap_20260701/edgerPolicyCurrent.js",
  import.meta.url,
);
const C3_MODEL = new URL("../artifacts/edger-training/promoted/edger_policy_current.json", import.meta.url);

function sha256(url) {
  return createHash("sha256").update(fs.readFileSync(url)).digest("hex");
}

test("the harness pin is the retired v1 module, byte for byte", () => {
  assert.equal(sha256(RETIRED_V1_MODULE), "69333cd508d3aebab3a246c6a9b1638960fb20611c6198eb81e08b9aae682847");
  assert.equal(EDGER_RETIRED_V1_MODEL.model_id, "edger_policy_bootstrap_20260701");
});

test("corpus collection plays and labels the retired v1 as before the promotion", () => {
  const canary = runDeterministicCollectionCanary({ seed: 20260718, ticks: 600 });
  assert.equal(canary.actions.length, 9);
  assert.equal(canary.final_state_hash, "f7772d80");
  assert.equal(canary.replay_checksum, "06acb7052697409feedf2c9ba5889b8d09350f6aaede15831766a151f511c8f2");

  const collected = runCollectionSpec({ seed: 20261128, edger_actor: "blue", opponent: "aggressive", global_match_index: 0 });
  assert.equal(collected.action_stream_hash, "4e40025597223195307b231911f9a68bec7c90feeb4356ea48f8453f5d06007f");
  assert.equal(collected.episode.result.winner, "blue");
  assert.deepEqual(collected.episode.policies.blue, {
    policy_id: "edger",
    checkpoint_id: "edger_policy_bootstrap_20260701",
    behavior_probabilities: "known",
    league_rating: null,
  });
});

test("the cadence worker's edger opponent is the retired v1, as before the promotion", () => {
  // The candidate is c3; if a later promotion replaces this file, pick the
  // retired c3 copy instead of re-deriving the expected values.
  assert.equal(sha256(C3_MODEL), "26a5615041d8af9381687fe901183f0cdbf8872d4f57d9cccda7f91860f9eb9f");
  const match = runCadenceSpec({
    kind: "evaluate",
    spec_id: 0,
    pair_id: "harness-pin|0",
    seed: 20261128,
    candidate_actor: "red",
    cadence: "learned",
    opponent: "edger",
    model_path: fileURLToPath(C3_MODEL),
  });
  assert.equal(match.action_stream_hash, "d94b1ce711f6f8eccd7355ea2a4cbda4c42600aba2b74856cc436e28fe28b412");
  assert.equal(match.final_state_hash, "0fc9a544");
  assert.equal(match.candidate_point, 1);
  assert.equal(match.tick, 2025);
});
