import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildDatasetManifest,
  createTrainingEpisode,
  deriveDecisionSequence,
  loadTrainingEpisode,
  mergeDatasetManifests,
  splitForEpisodeId,
  storeTrainingEpisode,
  validateDatasetManifest,
  validateTrainingEpisode,
  verifyTrainingEpisodeReplay,
} from "../scripts/edger-corpus-core.mjs";
import {
  buildCollectionSpecs,
  collectionSpecChecksum,
} from "../scripts/edger-collection-core.mjs";
import { deterministicTrainingScale } from "../scripts/edger-dataset-core.mjs";
import {
  cloneProductionInitialCardState,
  createProductionEngine,
} from "../src/sim/productionMatch.js";

function makeCompletePassiveEpisode({
  seed = 7201,
  sourceKind = "simulator",
  human = false,
} = {}) {
  const engine = createProductionEngine({ seed });
  const initialCardState = cloneProductionInitialCardState(engine);
  while (!engine.getMatchResult()) {
    engine.step([]);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  return createTrainingEpisode({
    seed,
    initialCardState,
    actions: engine.state.replay.actions,
    events: engine.state.replay.events,
    result: engine.getMatchResult(),
    finalStateHash: engine.getStateHash(),
    policies: {
      blue: {
        policy_id: human ? "opted_in_human" : "edger_heuristic",
        checkpoint_id: null,
        behavior_probabilities: human ? "unknown" : "known",
      },
      red: {
        policy_id: "edger",
        checkpoint_id: "bootstrap",
        behavior_probabilities: "known",
      },
    },
    source: {
      kind: sourceKind,
      collector: "test",
      human_action_actors: human ? ["blue"] : [],
    },
  });
}

test("immutable episode replay reproduces actions, events, result, and final hash", () => {
  const episode = makeCompletePassiveEpisode();
  const result = verifyTrainingEpisodeReplay(episode);

  assert.equal(result.episode_id, episode.episode_id);
  assert.equal(result.final_state_hash, episode.final_state_hash);
  assert.equal(result.replay_checksum, episode.replay_checksum);
  assert.equal(episode.initial.entities.length, 6);
  assert.equal(episode.result.tick, 6000);
});

test("content-addressed corpus deduplicates and keeps stable whole-game splits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-corpus-test-"));
  const episode = makeCompletePassiveEpisode({ seed: 7202 });
  const first = storeTrainingEpisode({ episode, store: root });
  const second = storeTrainingEpisode({ episode, store: root });
  const manifest = validateDatasetManifest(buildDatasetManifest({ store: root }));

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.uri, second.uri);
  assert.equal(manifest.shards.length, 1);
  assert.equal(manifest.shards[0].split, splitForEpisodeId(episode.episode_id));
  assert.equal(loadTrainingEpisode(first.uri).episode_id, episode.episode_id);
  fs.rmSync(root, { recursive: true, force: true });
});

test("parallel corpus validation checks manifest checksums, IDs, and full replays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-corpus-validate-"));
  const stored = [
    makeCompletePassiveEpisode({ seed: 7210 }),
    makeCompletePassiveEpisode({ seed: 7211 }),
  ].map((episode) => storeTrainingEpisode({ episode, store: root }));
  const manifest = buildDatasetManifest({
    episodeUris: stored.map((entry) => entry.uri),
  });
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "validation.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [
    "scripts/edger-corpus.mjs",
    "validate",
    "--manifest",
    manifestPath,
    "--workers",
    "2",
    "--report",
    reportPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.checks.compressed_checksums, 2);
  assert.equal(report.checks.episode_ids, 2);
  assert.equal(report.checks.replay, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("incompatible schemas are rejected before entering a manifest", () => {
  const episode = makeCompletePassiveEpisode({ seed: 7203 });
  const incompatible = structuredClone(episode);
  incompatible.compatibility.observation_schema_version = "wrong";
  assert.throws(
    () => validateTrainingEpisode(incompatible),
    /incompatible observation_schema_version/,
  );
});

test("decision derivation uses sparse delays and excludes unknown human probabilities from V-trace", () => {
  const episode = makeCompletePassiveEpisode({
    seed: 7204,
    sourceKind: "opted_in_player",
    human: true,
  });
  const sequence = deriveDecisionSequence(episode);
  const blue = sequence.samples.filter((sample) => sample.actor === "blue");
  const red = sequence.samples.filter((sample) => sample.actor === "red");

  assert.ok(blue.length > 0);
  assert.ok(blue.every((sample) => sample.delay_ticks >= 1 && sample.delay_ticks <= 200));
  assert.ok(blue.every((sample) => sample.vtrace_eligible === false));
  assert.ok(red.every((sample) => sample.vtrace_eligible === true));
  assert.ok(sequence.samples.every((sample) => Number.isFinite(sample.discounted_return)));
});

test("collector specs are stable paired seeds with balanced sides and opponents", () => {
  const options = {
    matches: 64,
    seed: 20260718,
    pairOffset: 0,
    opponents: ["edger_heuristic", "random", "aggressive", "defender"],
  };
  const first = buildCollectionSpecs(options);
  const second = buildCollectionSpecs(options);

  assert.equal(first.length, 64);
  assert.equal(collectionSpecChecksum(first), collectionSpecChecksum(second));
  assert.deepEqual(
    first.map((spec) => spec.global_match_index),
    Array.from({ length: 64 }, (_, index) => index),
  );
  for (let pairIndex = 0; pairIndex < 32; pairIndex += 1) {
    const pair = first.filter((spec) => spec.pair_index === pairIndex);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].seed, pair[1].seed);
    assert.deepEqual(pair.map((spec) => spec.edger_actor), ["blue", "red"]);
  }
  assert.deepEqual(
    first.reduce((counts, spec) => {
      counts[spec.opponent] = (counts[spec.opponent] ?? 0) + 1;
      return counts;
    }, {}),
    {
      aggressive: 16,
      defender: 16,
      edger_heuristic: 16,
      random: 16,
    },
  );
});

test("scaling reduces only nested training episodes and preserves held-out IDs", () => {
  const shards = Array.from({ length: 1000 }, (_, index) => {
    const episodeId = index.toString(16).padStart(64, "0");
    return {
      episode_id: episodeId,
      split: splitForEpisodeId(episodeId),
      uri: `/tmp/${episodeId}`,
      source: "simulator",
      checksum: episodeId,
    };
  });
  const one = deterministicTrainingScale(shards, 0.01);
  const ten = deterministicTrainingScale(shards, 0.1);
  const full = deterministicTrainingScale(shards, 1);
  const ids = (selected, split) => selected
    .filter((shard) => shard.split === split)
    .map((shard) => shard.episode_id);
  const oneTrain = new Set(ids(one, "train"));
  const tenTrain = new Set(ids(ten, "train"));
  const fullTrain = new Set(ids(full, "train"));

  assert.ok([...oneTrain].every((episodeId) => tenTrain.has(episodeId)));
  assert.ok([...tenTrain].every((episodeId) => fullTrain.has(episodeId)));
  for (const split of ["validation", "test"]) {
    assert.equal(JSON.stringify(ids(one, split)), JSON.stringify(ids(full, split)));
    assert.equal(JSON.stringify(ids(ten, split)), JSON.stringify(ids(full, split)));
  }
});

test("base and rollout manifests merge without rematerializing base episodes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-manifest-merge-"));
  const first = storeTrainingEpisode({
    episode: makeCompletePassiveEpisode({ seed: 7220 }),
    store: root,
  });
  const second = storeTrainingEpisode({
    episode: makeCompletePassiveEpisode({ seed: 7221 }),
    store: root,
  });
  const base = buildDatasetManifest({ episodeUris: [first.uri] });
  const rollout = buildDatasetManifest({ episodeUris: [second.uri] });
  const merged = mergeDatasetManifests([base, rollout]);

  assert.equal(merged.statistics.episodes, 2);
  assert.equal(merged.shards.length, 2);
  assert.deepEqual(
    merged.shards.map((shard) => shard.episode_id),
    [first.episode_id, second.episode_id].sort(),
  );
  fs.rmSync(root, { recursive: true, force: true });
});
