import test from "node:test";
import assert from "node:assert/strict";

import { buildActionTrainingRows, summarizeTrainingRows } from "../src/ai/neuralTraining.js";
import {
  generateTrainingDataset,
  hashTrainingDataset,
  replayTrainingEpisode,
  runTrainingEpisode,
} from "../src/ai/trainingData.js";

test("training episode exports replayable decisions and final hashes", () => {
  const episode = runTrainingEpisode({
    blueTier: "goat",
    redTier: "top",
    seed: 1234,
    maxTicks: 140,
  });

  assert.ok(episode.samples.length > 0);
  assert.ok(episode.replay_hash);
  assert.ok(episode.state_hash);
  assert.ok(episode.samples.every((sample) => sample.legal_actions.length > 0));

  const replayed = replayTrainingEpisode(episode);
  assert.equal(replayed.final_tick, episode.final_tick);
  assert.equal(replayed.state_hash, episode.state_hash);
  assert.equal(replayed.replay_hash, episode.replay_hash);
});

test("generated datasets are deterministic and produce supervised action rows", () => {
  const config = {
    tiers: ["top", "goat"],
    seed: 515,
    episodes: 2,
    maxTicks: 100,
  };

  const first = generateTrainingDataset(config);
  const second = generateTrainingDataset(config);
  assert.deepEqual(first, second);
  assert.equal(first.dataset_hash, hashTrainingDataset(first));
  assert.ok(first.sample_count > 0);

  const rows = buildActionTrainingRows(first, { maxNegativesPerDecision: 2 });
  const summary = summarizeTrainingRows(rows);
  assert.equal(summary.positives, first.sample_count);
  assert.ok(summary.negatives > 0);
  assert.equal(summary.rows, rows.length);
});
