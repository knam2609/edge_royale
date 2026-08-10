#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

import { HEURISTIC_BOT_ID } from "../src/ai/botRuntime.js";
import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import {
  DEFAULT_CORPUS_STORE,
  buildDatasetManifest,
  canonicalJson,
  mergeDatasetManifests,
  readDatasetManifest,
  writeDatasetManifest,
} from "./edger-corpus-core.mjs";
import { assertScalingReportPassed } from "./edger-scaling-gate.mjs";
import { spawnNativePython } from "./python-runtime.mjs";

const LEAGUE_SCHEMA_VERSION = "edger_snapshot_league_v1";

function parseArgs(argv) {
  const parsed = {
    scalingReport: null,
    model: null,
    liveChampionModel: "artifacts/edger-training/promoted/edger_policy_current.json",
    liveChampionReference: null,
    historicalAnchors: [],
    league: null,
    rolloutStore: process.env.EDGER_CORPUS_STORE ?? DEFAULT_CORPUS_STORE,
    baseManifest: null,
    manifestOut: "artifacts/edger-training/manifests/edger_league_manifest.json",
    reportOut: null,
    matches: 32,
    workers: 16,
    seed: 20260718,
    temperature: 1,
    datasetOut: null,
    checkpoint: null,
    outCheckpoint: null,
    epochs: 1,
    batchSize: 32,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scaling-report" && argv[index + 1]) {
      parsed.scalingReport = argv[++index];
    } else if (
      (arg === "--model" || arg === "--shadow-parent-model") &&
      argv[index + 1]
    ) {
      parsed.model = argv[++index];
    } else if (arg === "--live-champion-model" && argv[index + 1]) {
      parsed.liveChampionModel = argv[++index];
    } else if (arg === "--live-champion-reference" && argv[index + 1]) {
      parsed.liveChampionReference = argv[++index];
    } else if (arg === "--historical-anchors" && argv[index + 1]) {
      parsed.historicalAnchors = argv[++index].split(",").filter(Boolean);
    } else if (arg === "--league" && argv[index + 1]) {
      parsed.league = argv[++index];
    } else if (
      (arg === "--store" || arg === "--rollout-store") &&
      argv[index + 1]
    ) {
      parsed.rolloutStore = argv[++index];
    } else if (arg === "--base-manifest" && argv[index + 1]) {
      parsed.baseManifest = argv[++index];
    } else if (arg === "--manifest-out" && argv[index + 1]) {
      parsed.manifestOut = argv[++index];
    } else if (arg === "--report-out" && argv[index + 1]) {
      parsed.reportOut = argv[++index];
    } else if (arg === "--matches" && argv[index + 1]) {
      parsed.matches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--temperature" && argv[index + 1]) {
      parsed.temperature = Number.parseFloat(argv[++index]);
    } else if (arg === "--dataset-out" && argv[index + 1]) {
      parsed.datasetOut = argv[++index];
    } else if (
      (arg === "--checkpoint" || arg === "--shadow-parent-checkpoint") &&
      argv[index + 1]
    ) {
      parsed.checkpoint = argv[++index];
    } else if (arg === "--out-checkpoint" && argv[index + 1]) {
      parsed.outCheckpoint = argv[++index];
    } else if (arg === "--epochs" && argv[index + 1]) {
      parsed.epochs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--batch-size" && argv[index + 1]) {
      parsed.batchSize = Number.parseInt(argv[++index], 10);
    }
  }
  if (!parsed.scalingReport || !parsed.model) {
    throw new Error("--scaling-report and --model are required");
  }
  if (!Number.isInteger(parsed.matches) || parsed.matches < 2 || parsed.matches % 2 !== 0) {
    throw new Error("--matches must be a positive even integer");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be between 1 and 32 (production campaigns use 16-32)");
  }
  return parsed;
}

function normalizeSnapshot(snapshot, fallbackPolicyId) {
  if (!snapshot?.model_path) {
    throw new Error(`league snapshot ${fallbackPolicyId} requires model_path`);
  }
  const modelPath = path.resolve(snapshot.model_path);
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  if (model.schema_version === "edger_policy_model_v2") {
    validateEdgerV2PolicyModel(model);
  } else {
    validateEdgerPolicyModel(model);
  }
  return {
    kind: "model",
    policy_id: snapshot.policy_id ?? model.model_id ?? fallbackPolicyId,
    checkpoint_id: snapshot.checkpoint_id ?? model.training?.checkpoint_id ?? null,
    model_path: modelPath,
    league_rating: Number.isFinite(snapshot.league_rating)
      ? snapshot.league_rating
      : null,
    score: Number.isFinite(snapshot.score) ? snapshot.score : 0.5,
  };
}

function loadLeague(args, mainModel) {
  const configuredHistorical = args.historicalAnchors.map((modelPath, index) =>
    normalizeSnapshot({ model_path: modelPath }, `historical_anchor_${index}`));
  if (!args.league) {
    return {
      schema_version: LEAGUE_SCHEMA_VERSION,
      champion: normalizeSnapshot({
        model_path: args.liveChampionModel,
      }, "live_champion"),
      historical: configuredHistorical,
      contenders: [],
    };
  }
  const raw = JSON.parse(fs.readFileSync(args.league, "utf8"));
  if (raw.schema_version !== LEAGUE_SCHEMA_VERSION) {
    throw new Error(`league schema_version must be ${LEAGUE_SCHEMA_VERSION}`);
  }
  if ((raw.historical ?? []).length > 7) {
    throw new Error("snapshot league supports at most seven historical promoted snapshots");
  }
  if ((raw.contenders ?? []).length > 4) {
    throw new Error("snapshot league supports at most four non-dominated contenders");
  }
  return {
    schema_version: LEAGUE_SCHEMA_VERSION,
    champion: normalizeSnapshot(raw.champion, "current_champion"),
    historical: [
      ...(raw.historical ?? []).map((snapshot, index) =>
        normalizeSnapshot(snapshot, `historical_${index}`)),
      ...configuredHistorical,
    ],
    contenders: (raw.contenders ?? []).map((snapshot, index) =>
      normalizeSnapshot(snapshot, `contender_${index}`)),
  };
}

function weightedChoice(items, weights, rng) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      return items[index];
    }
  }
  return items.at(-1);
}

function selectOpponent(league, rng) {
  const allocation = rng();
  if (allocation < 0.4) {
    return { bucket: "champion", opponent: league.champion };
  }
  if (allocation < 0.6) {
    return {
      bucket: "heuristic",
      opponent: {
        kind: "bot",
        policy_id: HEURISTIC_BOT_ID,
        checkpoint_id: null,
        league_rating: null,
      },
    };
  }
  if (allocation < 0.8) {
    const pool = league.historical.length > 0 ? league.historical : [league.champion];
    return {
      bucket: "historical_uniform",
      opponent: pool[Math.floor(rng() * pool.length)],
    };
  }
  const pool = [...league.historical, ...league.contenders];
  const candidates = pool.length > 0 ? pool : [league.champion];
  const weights = candidates.map(
    (snapshot) => (1 - snapshot.score) ** 2 + 0.05,
  );
  return {
    bucket: "pfsp",
    opponent: weightedChoice(candidates, weights, rng),
  };
}

function makeMatchSpecs({ matches, seed, league }) {
  const rng = createRng(seed);
  const specs = [];
  for (let pairIndex = 0; pairIndex < matches / 2; pairIndex += 1) {
    const matchSeed = 1 + Math.floor(rng() * 2_000_000_000);
    const selection = selectOpponent(league, rng);
    for (const mainActor of ["blue", "red"]) {
      specs.push({
        match_index: specs.length,
        pair_index: pairIndex,
        seed: matchSeed,
        main_actor: mainActor,
        allocation_bucket: selection.bucket,
        opponent: selection.opponent,
      });
    }
  }
  return specs;
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./edger-league-worker.mjs", import.meta.url),
      { workerData },
    );
    worker.once("message", (message) => {
      if (message.ok) {
        resolve(message.results);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`league worker exited with code ${code}`));
      }
    });
  });
}

async function collectLeagueEpisodes({ args, mainModel, league, specs }) {
  const partitions = Array.from(
    { length: Math.min(args.workers, specs.length) },
    () => [],
  );
  specs.forEach((spec, index) => {
    partitions[index % partitions.length].push(spec);
  });
  const workerData = {
    mainModelPath: path.resolve(args.model),
    mainPolicyId: mainModel.model_id,
    mainCheckpointId: mainModel.training?.checkpoint_id ?? null,
    mainLeagueRating: mainModel.training?.league_rating ?? null,
    temperature: args.temperature,
    store: args.rolloutStore,
  };
  const results = (
    await Promise.all(
      partitions.map((partition) =>
        runWorker({ ...workerData, specs: partition })),
    )
  ).flat();
  return results.sort((left, right) => left.match_index - right.match_index);
}

function runVtraceIfRequested(args) {
  const requested = [args.datasetOut, args.checkpoint, args.outCheckpoint];
  if (requested.every((value) => !value)) {
    return null;
  }
  if (requested.some((value) => !value)) {
    throw new Error(
      "--dataset-out, --checkpoint, and --out-checkpoint are required together",
    );
  }
  const dataset = new URL("./edger-dataset.mjs", import.meta.url).pathname;
  const nodeResult = spawnSync(process.execPath, [
    dataset,
    "--manifest",
    args.manifestOut,
    "--out",
    args.datasetOut,
    "--max-player-fraction",
    "0",
  ], { stdio: "inherit" });
  if (nodeResult.status !== 0) {
    throw new Error(`league dataset preparation failed with exit ${nodeResult.status}`);
  }
  const trainResult = spawnNativePython([
    "scripts/edger-v2-training.py",
    "vtrace",
    "--dataset",
    args.datasetOut,
    "--checkpoint",
    args.checkpoint,
    "--out",
    args.outCheckpoint,
    "--epochs",
    String(args.epochs),
    "--batch-size",
    String(args.batchSize),
    "--seed",
    String(args.seed),
  ], { stdio: "inherit" });
  if (trainResult.status !== 0) {
    throw new Error(`V-trace learner failed with exit ${trainResult.status}`);
  }
  return {
    dataset: path.resolve(args.datasetOut),
    checkpoint: path.resolve(args.outCheckpoint),
  };
}

const args = parseArgs(process.argv.slice(2));
assertScalingReportPassed(
  JSON.parse(fs.readFileSync(args.scalingReport, "utf8")),
);
const mainModel = validateEdgerV2PolicyModel(
  JSON.parse(fs.readFileSync(args.model, "utf8")),
);
const league = loadLeague(args, mainModel);
if (league.historical.length > 7) {
  throw new Error("snapshot league supports at most seven historical promoted snapshots");
}
const specs = makeMatchSpecs({
  matches: args.matches,
  seed: args.seed,
  league,
});

try {
  const results = await collectLeagueEpisodes({
    args,
    mainModel,
    league,
    specs,
  });
  const rolloutManifest = buildDatasetManifest({
    episodeUris: results.map((result) => result.uri),
  });
  const baseManifest = args.baseManifest
    ? readDatasetManifest(args.baseManifest)
    : null;
  const manifest = baseManifest
    ? mergeDatasetManifests([baseManifest, rolloutManifest])
    : rolloutManifest;
  writeDatasetManifest(args.manifestOut, manifest);
  const training = runVtraceIfRequested(args);
  const report = {
    schema_version: "edger_league_campaign_report_v1",
    seed: args.seed,
    workers: args.workers,
    production_worker_range_met: args.workers >= 16 && args.workers <= 32,
    matches: results.length,
    paired_seeds: results.length / 2,
    main_model_id: mainModel.model_id,
    shadow_learner_parent: {
      model: path.resolve(args.model),
      model_id: mainModel.model_id,
      checkpoint: args.checkpoint ? path.resolve(args.checkpoint) : null,
    },
    live_champion: {
      model: path.resolve(args.liveChampionModel),
      policy_id: league.champion.policy_id,
      reference_report: args.liveChampionReference
        ? path.resolve(args.liveChampionReference)
        : null,
    },
    historical_anchor_ids: league.historical.map((snapshot) => snapshot.policy_id),
    allocation: specs.reduce((counts, spec) => {
      counts[spec.allocation_bucket] = (counts[spec.allocation_bucket] ?? 0) + 1;
      return counts;
    }, {}),
    results,
    base_manifest: baseManifest
      ? {
          path: path.resolve(args.baseManifest),
          manifest_hash: baseManifest.manifest_hash,
          episodes: baseManifest.statistics.episodes,
        }
      : null,
    rollout: {
      store: args.rolloutStore,
      manifest_hash: rolloutManifest.manifest_hash,
      episodes: rolloutManifest.statistics.episodes,
    },
    manifest: path.resolve(args.manifestOut),
    manifest_hash: manifest.manifest_hash,
    training,
  };
  if (args.reportOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.reportOut)), { recursive: true });
    fs.writeFileSync(args.reportOut, canonicalJson(report));
  }
  console.log(canonicalJson(report).trimEnd());
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
