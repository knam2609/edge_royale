import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveDatasetInputPaths } from "../scripts/train-goat-lib.mjs";
import { normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";
import { generateTrainingDataset, hashTrainingDataset, hashTrainingDatasetCorpus } from "../src/ai/trainingData.js";

const execFileAsync = promisify(execFile);

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

async function withTempDir(run) {
  const tempDir = await mkdtemp(join(tmpdir(), "edge-royale-train-"));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("resolveDatasetInputPaths sorts shard files and de-duplicates overlaps", async () => {
  await withTempDir(async (tempDir) => {
    const datasetDir = join(tempDir, "datasets");
    await mkdir(datasetDir, { recursive: true });
    await writeFile(join(datasetDir, "shard-b.json"), "{}\n", "utf8");
    await writeFile(join(datasetDir, "shard-a.json"), "{}\n", "utf8");
    await writeFile(join(datasetDir, "notes.txt"), "ignored\n", "utf8");
    await writeFile(join(tempDir, "direct.json"), "{}\n", "utf8");

    const paths = await resolveDatasetInputPaths({
      cwd: tempDir,
      datasetPaths: ["./direct.json", "./datasets/shard-a.json"],
      datasetDirs: ["./datasets"],
    });

    const expected = [
      resolve(tempDir, "direct.json"),
      resolve(tempDir, "datasets/shard-a.json"),
      resolve(tempDir, "datasets/shard-b.json"),
    ].sort((left, right) => left.localeCompare(right));

    assert.deepEqual(paths, expected);
  });
});

test("resolveDatasetInputPaths rejects empty dataset directories", async () => {
  await withTempDir(async (tempDir) => {
    const emptyDir = join(tempDir, "empty");
    await mkdir(emptyDir, { recursive: true });

    await assert.rejects(
      resolveDatasetInputPaths({
        cwd: tempDir,
        datasetDirs: ["./empty"],
      }),
      /dataset directory contains no \.json files/,
    );
  });
});

test("train-goat consumes shard directories and writes a valid model artifact", async () => {
  await withTempDir(async (tempDir) => {
    const datasetDir = join(tempDir, "datasets");
    const outputDir = join(tempDir, "outputs");
    await mkdir(datasetDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const baseDataset = generateTrainingDataset({
      tiers: ["top", "goat"],
      seed: 2026,
      episodes: 2,
      maxTicks: 120,
    });
    const shardOne = createDatasetFromEpisodes(baseDataset, baseDataset.episodes.slice(0, 1));
    const shardTwo = createDatasetFromEpisodes(baseDataset, baseDataset.episodes.slice(1));
    await writeFile(join(datasetDir, "shard-001.json"), `${JSON.stringify(shardOne)}\n`, "utf8");
    await writeFile(join(datasetDir, "shard-002.json"), `${JSON.stringify(shardTwo)}\n`, "utf8");

    const modelPath = join(outputDir, "model.json");
    const summaryPath = join(outputDir, "summary.json");
    await execFileAsync(
      process.execPath,
      [
        "scripts/train-goat.mjs",
        "--dataset-dir",
        datasetDir,
        "--iterations",
        "1",
        "--epochs",
        "1",
        "--eval-rounds",
        "1",
        "--eval-max-ticks",
        "80",
        "--max-negatives",
        "2",
        "--out",
        modelPath,
        "--summary-out",
        summaryPath,
      ],
      {
        cwd: process.cwd(),
      },
    );

    const model = JSON.parse(await readFile(modelPath, "utf8"));
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));

    assert.ok(normalizeNeuralPolicyModel(model));
    assert.equal(model.dataset_hash, hashTrainingDatasetCorpus([shardOne.dataset_hash, shardTwo.dataset_hash]));
    assert.equal(model.training_config.dataset_sources.length, 2);
    assert.equal(summary.dataset_sources.length, 2);
  });
});
