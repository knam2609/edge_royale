#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDatasetManifest,
  canonicalJson,
  deriveDecisionSequence,
  loadTrainingEpisode,
  readDatasetManifest,
  validateDatasetManifest,
  writeDatasetManifest,
} from "./edger-corpus-core.mjs";
import { deterministicTrainingScale } from "./edger-dataset-core.mjs";
import { spawnNativePython } from "./python-runtime.mjs";

function parseArgs(argv) {
  const parsed = {
    manifest: null,
    out: null,
    scalesDir: null,
    python: process.env.PYTHON ?? "python3",
    maxPlayerFraction: 0.1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" && argv[index + 1]) {
      parsed.manifest = argv[++index];
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--scales-dir" && argv[index + 1]) {
      parsed.scalesDir = argv[++index];
    } else if (arg === "--python" && argv[index + 1]) {
      parsed.python = argv[++index];
    } else if (arg === "--max-player-fraction" && argv[index + 1]) {
      parsed.maxPlayerFraction = Number.parseFloat(argv[++index]);
    }
  }
  if (!parsed.manifest) {
    throw new Error("--manifest is required");
  }
  if (!parsed.out && !parsed.scalesDir) {
    throw new Error("--out or --scales-dir is required");
  }
  if (
    !Number.isFinite(parsed.maxPlayerFraction) ||
    parsed.maxPlayerFraction < 0 ||
    parsed.maxPlayerFraction > 0.1
  ) {
    throw new Error("--max-player-fraction must be between 0 and 0.1");
  }
  return parsed;
}

function selectDefaultMix(shards, maxPlayerFraction) {
  const simulator = shards.filter((shard) => shard.source === "simulator");
  const player = shards
    .filter((shard) => shard.source === "opted_in_player")
    .sort((left, right) => left.episode_id.localeCompare(right.episode_id));
  if (maxPlayerFraction <= 0 || simulator.length === 0) {
    return simulator;
  }
  const maximumPlayers = Math.floor(
    (simulator.length * maxPlayerFraction) / (1 - maxPlayerFraction),
  );
  return [...simulator, ...player.slice(0, maximumPlayers)].sort(
    (left, right) => left.episode_id.localeCompare(right.episode_id),
  );
}

function addBalancingWeights(rows) {
  const counts = new Map();
  for (const row of rows) {
    const outcome = row.is_winner ? "win" : row.result_winner ? "loss" : "draw";
    const key = `${row.source_kind}|${row.opponent_stratum}|${outcome}`;
    row.balance_stratum = key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const meanCount = rows.length / Math.max(1, counts.size);
  for (const row of rows) {
    row.sample_weight = meanCount / counts.get(row.balance_stratum);
  }
}

function rowsForShards(shards) {
  const rows = [];
  for (const shard of shards) {
    const episode = loadTrainingEpisode(shard.uri);
    const sequence = deriveDecisionSequence(episode);
    for (const sample of sequence.samples) {
      rows.push({
        ...sample,
        split: shard.split,
        result_winner: episode.result.winner,
        compatibility_cohort: sequence.compatibility_cohort,
        reward_version: sequence.reward_version,
        per_tick_gamma: sequence.per_tick_gamma,
      });
    }
  }
  addBalancingWeights(rows);
  return rows;
}

function writeNdjson(filePath, rows) {
  const fd = fs.openSync(filePath, "w");
  try {
    for (const row of rows) {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function buildCache({ python, manifest, shards, out, scale }) {
  const rows = rowsForShards(shards);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edger-dataset-"));
  const ndjson = path.join(tempDir, "samples.ndjson");
  writeNdjson(ndjson, rows);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const result = spawnNativePython(
    [
      "scripts/edger-v2-training.py",
      "prepare",
      "--input",
      ndjson,
      "--out",
      out,
      "--manifest-hash",
      manifest.manifest_hash,
      "--scale",
      String(scale),
    ],
    { stdio: "inherit", python },
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`PyArrow cache preparation failed with exit ${result.status}`);
  }
  return {
    scale,
    output: path.resolve(out),
    episodes: shards.length,
    samples: rows.length,
    splits: rows.reduce((counts, row) => {
      counts[row.split] = (counts[row.split] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

const args = parseArgs(process.argv.slice(2));
const manifest = validateDatasetManifest(readDatasetManifest(args.manifest));
const mixedShards = selectDefaultMix(manifest.shards, args.maxPlayerFraction);
const results = [];

if (args.scalesDir) {
  for (const [label, fraction] of [["1pct", 0.01], ["10pct", 0.1], ["100pct", 1]]) {
    const shards = deterministicTrainingScale(mixedShards, fraction);
    const scaleManifest = buildDatasetManifest({
      episodeUris: shards.map((shard) => shard.uri),
    });
    const manifestPath = path.join(
      args.scalesDir,
      `edger_manifest_${label}.json`,
    );
    writeDatasetManifest(manifestPath, scaleManifest);
    results.push(buildCache({
      python: args.python,
      manifest: scaleManifest,
      shards: scaleManifest.shards,
      out: path.join(args.scalesDir, `edger_decisions_${label}.parquet`),
      scale: fraction,
    }));
    results.at(-1).manifest = path.resolve(manifestPath);
    results.at(-1).manifest_hash = scaleManifest.manifest_hash;
  }
} else {
  results.push(buildCache({
    python: args.python,
    manifest,
    shards: mixedShards,
    out: args.out,
    scale: 1,
  }));
}

console.log(canonicalJson({
  command: "dataset",
  manifest_hash: manifest.manifest_hash,
  default_mix: {
    selected_episodes: mixedShards.length,
    simulator_episodes: mixedShards.filter((shard) => shard.source === "simulator").length,
    opted_in_player_episodes: mixedShards.filter((shard) => shard.source === "opted_in_player").length,
    max_player_fraction: args.maxPlayerFraction,
  },
  caches: results,
}).trimEnd());
