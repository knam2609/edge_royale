import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActionTrainingRows,
  countActionTrainingRows,
  fillActionTrainingBuffers,
  summarizeTrainingRows,
} from "../src/ai/neuralTraining.js";
import { MODEL_INPUT_SIZE } from "../src/ai/neuralFeatures.js";
import {
  generateTrainingDataset,
  hashTrainingDatasetCorpus,
  hashTrainingDataset,
  replayTrainingEpisode,
  runTrainingEpisode,
} from "../src/ai/trainingData.js";

function createDatasetFromEpisodes(baseDataset, episodes) {
  const dataset = {
    schema_version: baseDataset.schema_version,
    generator: baseDataset.generator,
    seed: baseDataset.seed,
    tiers: baseDataset.tiers,
    episodes_requested: episodes.length,
    max_ticks: baseDataset.max_ticks,
    episode_count: episodes.length,
    sample_count: episodes.reduce((sum, episode) => sum + episode.samples.length, 0),
    episodes,
  };

  return {
    ...dataset,
    dataset_hash: hashTrainingDataset(dataset),
  };
}

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

test("generated datasets can cap stored negative legal actions", () => {
  const maxStoredNegatives = 2;
  const dataset = generateTrainingDataset({
    tiers: ["top", "goat"],
    seed: 616,
    episodes: 2,
    maxTicks: 120,
    maxStoredNegatives,
  });

  assert.equal(dataset.max_stored_negatives, maxStoredNegatives);
  assert.ok(dataset.sample_count > 0);

  for (const episode of dataset.episodes) {
    for (const sample of episode.samples) {
      const chosen = sample.legal_actions[sample.chosen_action_index];
      assert.ok(chosen);
      assert.deepEqual(chosen.action, sample.chosen_action);
      assert.equal(sample.stored_legal_action_count, sample.legal_actions.length);
      assert.ok(sample.legal_action_count >= sample.legal_actions.length);
      assert.ok(sample.legal_actions.length <= maxStoredNegatives + 1);
      assert.deepEqual(
        sample.legal_actions.map((candidate) => candidate.index),
        sample.legal_actions.map((_, index) => index),
      );
    }
  }

  const rowSummary = countActionTrainingRows(dataset, { maxNegativesPerDecision: 8 });
  assert.equal(rowSummary.positives, dataset.sample_count);
  assert.ok(rowSummary.negatives > 0);
  assert.ok(rowSummary.negatives <= dataset.sample_count * maxStoredNegatives);
  assert.equal(rowSummary.rows, rowSummary.positives + rowSummary.negatives);
});

test("dataset corpus hash is deterministic and order-sensitive", () => {
  assert.equal(hashTrainingDatasetCorpus(["alpha", "beta"]), hashTrainingDatasetCorpus(["alpha", "beta"]));
  assert.notEqual(hashTrainingDatasetCorpus(["alpha", "beta"]), hashTrainingDatasetCorpus(["beta", "alpha"]));
  assert.notEqual(hashTrainingDatasetCorpus(["alpha", "beta"]), hashTrainingDatasetCorpus(["alpha", "gamma"]));
});

test("multi-shard row buffers match merged dataset rows", () => {
  const baseDataset = generateTrainingDataset({
    tiers: ["top", "goat"],
    seed: 919,
    episodes: 4,
    maxTicks: 100,
  });
  const shardOne = createDatasetFromEpisodes(baseDataset, baseDataset.episodes.slice(0, 2));
  const shardTwo = createDatasetFromEpisodes(baseDataset, baseDataset.episodes.slice(2));
  const mergedDataset = createDatasetFromEpisodes(baseDataset, [...shardOne.episodes, ...shardTwo.episodes]);

  const maxNegativesPerDecision = 2;
  const expectedRows = buildActionTrainingRows(mergedDataset, { maxNegativesPerDecision });
  const shardSummary = [shardOne, shardTwo]
    .map((dataset) => countActionTrainingRows(dataset, { maxNegativesPerDecision }))
    .reduce(
      (total, current) => ({
        rows: total.rows + current.rows,
        positives: total.positives + current.positives,
        negatives: total.negatives + current.negatives,
      }),
      { rows: 0, positives: 0, negatives: 0 },
    );

  const inputs = new Float32Array(shardSummary.rows * MODEL_INPUT_SIZE);
  const labels = new Float32Array(shardSummary.rows);
  let rowOffset = 0;
  rowOffset = fillActionTrainingBuffers(shardOne, {
    maxNegativesPerDecision,
    inputSize: MODEL_INPUT_SIZE,
    inputs,
    labels,
    rowOffset,
  });
  rowOffset = fillActionTrainingBuffers(shardTwo, {
    maxNegativesPerDecision,
    inputSize: MODEL_INPUT_SIZE,
    inputs,
    labels,
    rowOffset,
  });

  assert.equal(rowOffset, expectedRows.length);
  assert.deepEqual(Array.from(labels), expectedRows.map((row) => row.label));
  const expectedInputs = Float32Array.from(expectedRows.flatMap((row) => row.input));
  assert.deepEqual(Array.from(inputs), Array.from(expectedInputs));
});
