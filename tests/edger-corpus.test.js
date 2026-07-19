import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDatasetManifest,
  createTrainingEpisode,
  deriveDecisionSequence,
  loadTrainingEpisode,
  splitForEpisodeId,
  storeTrainingEpisode,
  validateDatasetManifest,
  validateTrainingEpisode,
  verifyTrainingEpisodeReplay,
} from "../scripts/edger-corpus-core.mjs";
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
