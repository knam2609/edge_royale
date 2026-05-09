import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { hashTrainingDataset } from "../src/ai/trainingData.js";

const DEFAULT_EVAL_TIERS = Object.freeze({
  default: Object.freeze(["noob", "mid", "top"]),
  noob: Object.freeze(["noob", "mid"]),
  mid: Object.freeze(["noob", "mid", "top"]),
  top: Object.freeze(["mid", "top", "pro"]),
  pro: Object.freeze(["top", "pro", "goat"]),
  goat: Object.freeze(["mid", "top", "pro", "goat"]),
  god: Object.freeze(["goat", "god"]),
});

const FAIR_TRAINING_CURRICULUM = Object.freeze({
  noob: Object.freeze([Object.freeze({ id: "noob-vs-mid", tiers: Object.freeze(["noob", "mid"]) })]),
  mid: Object.freeze([
    Object.freeze({ id: "mid-vs-noob", tiers: Object.freeze(["mid", "noob"]) }),
    Object.freeze({ id: "mid-vs-top", tiers: Object.freeze(["mid", "top"]) }),
  ]),
  top: Object.freeze([
    Object.freeze({ id: "top-vs-mid", tiers: Object.freeze(["top", "mid"]) }),
    Object.freeze({ id: "top-vs-pro", tiers: Object.freeze(["top", "pro"]) }),
  ]),
  pro: Object.freeze([
    Object.freeze({ id: "pro-vs-top", tiers: Object.freeze(["pro", "top"]) }),
    Object.freeze({ id: "pro-vs-goat", tiers: Object.freeze(["pro", "goat"]) }),
  ]),
  goat: Object.freeze([
    Object.freeze({ id: "goat-vs-mid", tiers: Object.freeze(["goat", "mid"]) }),
    Object.freeze({ id: "goat-vs-top", tiers: Object.freeze(["goat", "top"]) }),
    Object.freeze({ id: "goat-vs-pro", tiers: Object.freeze(["goat", "pro"]) }),
  ]),
});

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
}

function normalizeTierId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneTrainingDatasetPlan(dataset) {
  return {
    id: dataset.id,
    tiers: [...dataset.tiers],
  };
}

function normalizeDatasetMaxTicks(rawMaxTicks, datasetPath = null) {
  const maxTicks = Number.parseInt(rawMaxTicks, 10);
  if (!Number.isFinite(maxTicks) || maxTicks <= 0) {
    throw new Error(`training dataset is missing valid max_ticks: ${datasetPath ?? "<generated>"}`);
  }
  return maxTicks;
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
  const maxTicks = normalizeDatasetMaxTicks(rawDataset.max_ticks, datasetPath);

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
    max_ticks: maxTicks,
    tiers: normalizeStringArray(rawDataset.tiers),
  };
}

export function getDefaultEvalTiers(targetTier) {
  const tierId = normalizeTierId(targetTier);
  return [...(DEFAULT_EVAL_TIERS[tierId] ?? DEFAULT_EVAL_TIERS.default)];
}

export function getTierTrainingDatasets(targetTier) {
  const tierId = normalizeTierId(targetTier);
  if (FAIR_TRAINING_CURRICULUM[tierId]) {
    return FAIR_TRAINING_CURRICULUM[tierId].map(cloneTrainingDatasetPlan);
  }
  if (tierId === "god" && DEFAULT_EVAL_TIERS.god) {
    return [{ id: "god", tiers: ["god"] }];
  }
  if (tierId.length > 0) {
    return [{ id: tierId, tiers: [tierId] }];
  }
  return [{ id: "goat", tiers: ["goat"] }];
}

export function splitEpisodesAcrossPairings(totalEpisodes, pairingCount) {
  const total = Number.isFinite(Number(totalEpisodes)) ? Math.max(1, Math.floor(Number(totalEpisodes))) : 1;
  const count = Number.isFinite(Number(pairingCount)) ? Math.max(1, Math.floor(Number(pairingCount))) : 1;
  if (total < count) {
    return Array.from({ length: count }, () => 1);
  }

  const baseEpisodes = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => baseEpisodes + (index < remainder ? 1 : 0));
}

export function buildTierTrainingDatasets(targetTier, totalEpisodes) {
  const datasets = getTierTrainingDatasets(targetTier);
  const episodePlan = splitEpisodesAcrossPairings(totalEpisodes, datasets.length);
  return datasets.map((dataset, index) => ({
    ...cloneTrainingDatasetPlan(dataset),
    episodes: episodePlan[index] ?? 1,
  }));
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
  if (summary.episode_count <= 0) {
    throw new Error(`empty training dataset: ${resolvedPath}`);
  }

  return summary;
}
