import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateCollectionReports,
} from "../scripts/edger-collection-aggregate-core.mjs";
import {
  buildCollectionSpecs,
  collectionSpecChecksum,
} from "../scripts/edger-collection-core.mjs";

const OPPONENTS = ["edger_heuristic", "random", "aggressive", "defender"];

function makeReports() {
  return [0, 16].map((pairOffset) => {
    const specs = buildCollectionSpecs({
      matches: 32,
      seed: 20260718,
      pairOffset,
      opponents: OPPONENTS,
    });
    const results = specs.map((spec) => ({
      ...spec,
      episode_id: spec.spec_id.padEnd(64, "0").slice(0, 64),
      replay_verified: true,
    }));
    return {
      schema_version: "edger_collection_report_v1",
      status: "passed",
      spec_checksum: collectionSpecChecksum(specs),
      git_provenance: { commit: "a".repeat(40), clean: true },
      command: {
        seed: 20260718,
        pair_offset: pairOffset,
        matches: 32,
        opponents: OPPONENTS,
        store: "s3://test/corpus",
      },
      replay_verification: { checked: 32, passed: 32, all_passed: true },
      results,
      failures: [],
    };
  });
}

function aggregate(reports) {
  return aggregateCollectionReports(reports, {
    expectedMatches: 64,
    expectedShards: 2,
  });
}

test("collection aggregation accepts complete frozen shard coverage", () => {
  const report = aggregate(makeReports());
  assert.equal(report.status, "passed", report.errors.join("\n"));
  assert.equal(report.matches, 64);
  assert.equal(report.paired_seeds, 32);
  assert.deepEqual(report.edger_sides, { blue: 32, red: 32 });
  assert.deepEqual(report.opponents, {
    aggressive: 16,
    defender: 16,
    edger_heuristic: 16,
    random: 16,
  });
});

test("collection aggregation rejects gaps, overlaps, and duplicate episodes", () => {
  const gap = makeReports();
  gap[1].results.shift();
  assert.equal(aggregate(gap).status, "failed");

  const overlap = makeReports();
  overlap[1].results[0].global_match_index = overlap[0].results[0].global_match_index;
  assert.equal(aggregate(overlap).status, "failed");

  const duplicate = makeReports();
  duplicate[1].results[0].episode_id = duplicate[0].results[0].episode_id;
  assert.match(aggregate(duplicate).errors.join("\n"), /episode IDs/);
});

test("collection aggregation rejects wrong counts, mixed specs, and replay failures", () => {
  const wrongSide = makeReports();
  wrongSide[1].results[0].edger_actor = "red";
  assert.equal(aggregate(wrongSide).status, "failed");

  const wrongOpponent = makeReports();
  wrongOpponent[1].results[0].opponent = "random";
  assert.equal(aggregate(wrongOpponent).status, "failed");

  const mixedCommit = makeReports();
  mixedCommit[1].git_provenance.commit = "b".repeat(40);
  assert.match(aggregate(mixedCommit).errors.join("\n"), /mixed Git commits/);

  const mixedSpec = makeReports();
  mixedSpec[1].command.seed += 1;
  assert.equal(aggregate(mixedSpec).status, "failed");

  const replayFailure = makeReports();
  replayFailure[1].results[0].replay_verified = false;
  replayFailure[1].replay_verification.all_passed = false;
  assert.match(aggregate(replayFailure).errors.join("\n"), /replay/i);
});
