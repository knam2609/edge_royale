import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { hashTrainingDataset } from "../src/ai/trainingData.js";

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
}

function summarizeDataset(rawDataset, datasetPath = null) {
  if (!rawDataset || typeof rawDataset !== "object") {
    throw new Error(`invalid training dataset payload: ${datasetPath ?? "<generated>"}`);
  }
  if (!Array.isArray(rawDataset.episodes)) {
    throw new Error(`training dataset is missing episodes[]: ${datasetPath ?? "<generated>"}`);
  }

  const episodeCount = rawDataset.episodes.length;
  const sampleCount = rawDataset.episodes.reduce((sum, episode) => {
    return sum + (Array.isArray(episode?.samples) ? episode.samples.length : 0);
  }, 0);

  const dataset = {
    ...rawDataset,
    episode_count: episodeCount,
    sample_count: sampleCount,
  };
  const datasetHash = hashTrainingDataset(dataset);

  return {
    path: datasetPath,
    dataset: {
      ...dataset,
      dataset_hash: datasetHash,
    },
    dataset_hash: datasetHash,
    episode_count: episodeCount,
    sample_count: sampleCount,
    tiers: normalizeStringArray(rawDataset.tiers),
  };
}

export async function resolveDatasetInputPaths({
  cwd = process.cwd(),
  datasetPaths = [],
  datasetDirs = [],
} = {}) {
  const resolvedPaths = normalizeStringArray(datasetPaths).map((datasetPath) => resolve(cwd, datasetPath));

  for (const datasetDir of normalizeStringArray(datasetDirs)) {
    const resolvedDir = resolve(cwd, datasetDir);
    let entries;
    try {
      entries = await readdir(resolvedDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`failed to read dataset directory: ${resolvedDir}`, { cause: error });
    }

    const shardPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(resolvedDir, entry.name))
      .sort((left, right) => left.localeCompare(right));

    if (shardPaths.length === 0) {
      throw new Error(`dataset directory contains no .json files: ${resolvedDir}`);
    }

    resolvedPaths.push(...shardPaths);
  }

  return [...new Set(resolvedPaths)].sort((left, right) => left.localeCompare(right));
}

export async function loadDatasetFile(datasetPath) {
  const resolvedPath = resolve(process.cwd(), datasetPath);

  let rawJson;
  try {
    rawJson = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`failed to read dataset file: ${resolvedPath}`, { cause: error });
  }

  let rawDataset;
  try {
    rawDataset = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`invalid dataset JSON: ${resolvedPath}`, { cause: error });
  }

  const summary = summarizeDataset(rawDataset, resolvedPath);
  if (summary.episode_count <= 0 || summary.sample_count <= 0) {
    throw new Error(`empty training dataset: ${resolvedPath}`);
  }

  return summary;
}
