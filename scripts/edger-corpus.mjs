#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

import {
  normalizeBotId,
} from "../src/ai/botRuntime.js";
import {
  createProductionEngine,
} from "../src/sim/productionMatch.js";
import {
  DEFAULT_CORPUS_STORE,
  buildDatasetManifest,
  canonicalJson,
  createTrainingEpisode,
  listLocalEpisodeUris,
  loadTrainingEpisode,
  quarantineTrainingPayload,
  readDatasetManifest,
  runReplayToCompletion,
  sha256Hex,
  storeTrainingEpisode,
  validateDatasetManifest,
  validateTrainingEpisode,
  verifyTrainingEpisodeReplay,
  writeDatasetManifest,
} from "./edger-corpus-core.mjs";
import {
  DEFAULT_COLLECTION_OPPONENTS,
  buildCollectionSpecs,
  collectionSpecChecksum,
  getCleanGitProvenance,
  runDeterministicCollectionCanary,
} from "./edger-collection-core.mjs";

const MANUAL_EXPORT_SCHEMA_VERSION = "edger_manual_replay_export_v1";
const CAMPAIGN_COOLDOWN_DAYS = 14;
const MONTHLY_BACKSTOP_DAYS = 30;

function parseArgs(argv) {
  const parsed = {
    command: argv[0] ?? "help",
    store: process.env.EDGER_CORPUS_STORE ?? DEFAULT_CORPUS_STORE,
    manifest: null,
    out: null,
    state: null,
    seed: 20260718,
    matches: 8,
    opponents: [...DEFAULT_COLLECTION_OPPONENTS],
    workers: Math.min(16, os.availableParallelism()),
    pairOffset: 0,
    files: [],
    report: null,
    canaryTicks: 80,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--store" && argv[index + 1]) {
      parsed.store = argv[++index];
    } else if (arg === "--manifest" && argv[index + 1]) {
      parsed.manifest = argv[++index];
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--state" && argv[index + 1]) {
      parsed.state = argv[++index];
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--matches" && argv[index + 1]) {
      parsed.matches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--pair-offset" && argv[index + 1]) {
      parsed.pairOffset = Number.parseInt(argv[++index], 10);
    } else if (arg === "--opponents" && argv[index + 1]) {
      parsed.opponents = argv[++index].split(",").map((value) => normalizeBotId(value.trim()));
    } else if (arg === "--file" && argv[index + 1]) {
      parsed.files.push(argv[++index]);
    } else if (arg === "--report" && argv[index + 1]) {
      parsed.report = argv[++index];
    } else if (arg === "--canary-ticks" && argv[index + 1]) {
      parsed.canaryTicks = Number.parseInt(argv[++index], 10);
    } else if (!arg.startsWith("--")) {
      parsed.files.push(arg);
    }
  }
  if (!Number.isInteger(parsed.seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(parsed.matches) || parsed.matches < 2 || parsed.matches % 2 !== 0) {
    throw new Error("--matches must be a positive even integer");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be between 1 and 32");
  }
  if (!Number.isInteger(parsed.pairOffset) || parsed.pairOffset < 0) {
    throw new Error("--pair-offset must be a non-negative integer");
  }
  parsed.report ??= path.join(
    "artifacts",
    "edger-training",
    "reports",
    `edger_collection_${parsed.seed}_${parsed.pairOffset}_${parsed.matches}.json`,
  );
  parsed.state ??= parsed.store.startsWith("s3://")
    ? `${parsed.store.replace(/\/+$/, "")}/state/campaign-state.json`
    : path.join(parsed.store, "state", "campaign-state.json");
  return parsed;
}

function runCollectionWorker(workerData) {
  return new Promise((resolve) => {
    const results = [];
    const failures = [];
    const worker = new Worker(
      new URL("./edger-corpus-worker.mjs", import.meta.url),
      { workerData },
    );
    let settled = false;
    const finish = (unexpectedFailure = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (unexpectedFailure) {
        failures.push(unexpectedFailure);
      }
      resolve({ results, failures });
    };
    worker.on("message", (message) => {
      if (message.type === "result") {
        results.push(message.result);
      } else if (message.type === "failure") {
        failures.push(message.failure);
      } else if (message.type === "done") {
        finish();
      }
    });
    worker.once("error", (error) => finish({
      worker_failure: true,
      error: error.stack || error.message,
    }));
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish({
          worker_failure: true,
          error: `collection worker exited with code ${code}`,
        });
      }
    });
  });
}

function runValidationWorker(entries) {
  return new Promise((resolve) => {
    const results = [];
    const failures = [];
    const worker = new Worker(
      new URL("./edger-corpus-validate-worker.mjs", import.meta.url),
      { workerData: { entries } },
    );
    let settled = false;
    const finish = (unexpectedFailure = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (unexpectedFailure) {
        failures.push(unexpectedFailure);
      }
      resolve({ results, failures });
    };
    worker.on("message", (message) => {
      if (message.type === "result") {
        results.push(message.result);
      } else if (message.type === "failure") {
        failures.push(message.failure);
      } else if (message.type === "done") {
        finish();
      }
    });
    worker.once("error", (error) => finish({
      worker_failure: true,
      error: error.stack || error.message,
    }));
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish({
          worker_failure: true,
          error: `validation worker exited with code ${code}`,
        });
      }
    });
  });
}

function summarizeCoverage(results) {
  const coverage = {
    opponents: {},
    edger_sides: { blue: 0, red: 0 },
    outcomes: { win: 0, loss: 0, draw: 0 },
  };
  for (const result of results) {
    coverage.opponents[result.opponent] = (coverage.opponents[result.opponent] ?? 0) + 1;
    coverage.edger_sides[result.edger_actor] += 1;
    coverage.outcomes[result.outcome] += 1;
  }
  return coverage;
}

async function collectCommand(args) {
  const provenance = getCleanGitProvenance();
  const specs = buildCollectionSpecs({
    matches: args.matches,
    seed: args.seed,
    pairOffset: args.pairOffset,
    opponents: args.opponents,
  });
  const startedAt = new Date();
  const workerCount = Math.min(args.workers, specs.length);
  const partitions = Array.from({ length: workerCount }, () => []);
  specs.forEach((spec, index) => partitions[index % partitions.length].push(spec));
  const workerReports = await Promise.all(
    partitions.map((partition) => runCollectionWorker({
      specs: partition,
      store: args.store,
      provenance,
    })),
  );
  const results = workerReports
    .flatMap((workerReport) => workerReport.results)
    .sort((left, right) => left.global_match_index - right.global_match_index);
  const failures = workerReports.flatMap((workerReport) => workerReport.failures);
  const finishedAt = new Date();
  const elapsedSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  const episodeIds = results.map((result) => result.episode_id);
  const newlyCompleted = results.filter((result) => !result.resumed).length;
  const projected16WorkerHours = newlyCompleted === results.length && results.length > 0
    ? (
        elapsedSeconds *
        (10_000 / results.length) *
        (workerCount / 16) /
        3600
      )
    : null;
  const report = {
    schema_version: "edger_collection_report_v1",
    status: failures.length === 0 && results.length === specs.length ? "passed" : "failed",
    spec_checksum: collectionSpecChecksum(specs),
    git_provenance: provenance,
    command: {
      seed: args.seed,
      pair_offset: args.pairOffset,
      matches: args.matches,
      opponents: args.opponents,
      store: args.store,
    },
    workers: {
      requested: args.workers,
      used: workerCount,
    },
    timings: {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      elapsed_seconds: elapsedSeconds,
      match_elapsed_ms: results.map((result) => ({
        global_match_index: result.global_match_index,
        elapsed_ms: result.elapsed_ms,
      })),
    },
    episode_ids: episodeIds,
    replay_verification: {
      checked: results.length,
      passed: results.filter((result) => result.replay_verified).length,
      all_passed: results.every((result) => result.replay_verified),
    },
    coverage: summarizeCoverage(results),
    deduplication: {
      unique_episode_ids: new Set(episodeIds).size,
      duplicate_episode_ids: episodeIds.length - new Set(episodeIds).size,
      resumed_receipts: results.filter((result) => result.resumed).length,
      newly_completed: newlyCompleted,
    },
    production_projection: {
      target_matches: 10_000,
      target_workers: 16,
      projected_hours: projected16WorkerHours,
      within_eight_hours:
        projected16WorkerHours === null ? null : projected16WorkerHours <= 8,
      valid_from_fresh_collection: projected16WorkerHours !== null,
    },
    results,
    failures,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  fs.writeFileSync(args.report, canonicalJson(report));
  console.log(canonicalJson({
    command: "collect",
    report: path.resolve(args.report),
    status: report.status,
    matches: results.length,
    resumed_receipts: report.deduplication.resumed_receipts,
    failures: failures.length,
    spec_checksum: report.spec_checksum,
  }).trimEnd());
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

function importManualExport(payload, filePath) {
  if (payload.schema_version !== MANUAL_EXPORT_SCHEMA_VERSION) {
    throw new Error(`manual export schema_version must be ${MANUAL_EXPORT_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(payload.seed)) {
    throw new Error("manual export seed must be an integer");
  }
  if (!Array.isArray(payload.replay?.actions)) {
    throw new Error("manual export replay.actions must be an array");
  }
  const initialEngine = createProductionEngine({ seed: payload.seed });
  const initialCardState = cloneProductionInitialCardState(initialEngine);
  const engine = createProductionEngine({
    seed: payload.seed,
    initialCardState,
  });
  const finalTick = Number.parseInt(payload.result?.tick ?? payload.final_tick, 10);
  if (!Number.isInteger(finalTick)) {
    throw new Error("manual export must include result.tick");
  }
  runReplayToCompletion({
    engine,
    actions: payload.replay.actions,
    finalTick,
  });
  if (!engine.getMatchResult()) {
    throw new Error("manual export did not replay to a complete match result");
  }
  if (payload.final_state_hash && payload.final_state_hash !== engine.getStateHash()) {
    throw new Error("manual export final_state_hash mismatch");
  }
  if (
    payload.replay.events &&
    JSON.stringify(payload.replay.events) !== JSON.stringify(engine.state.replay.events)
  ) {
    throw new Error("manual export replay events mismatch");
  }
  return createTrainingEpisode({
    seed: payload.seed,
    initialCardState,
    actions: engine.state.replay.actions,
    events: engine.state.replay.events,
    result: engine.getMatchResult(),
    finalStateHash: engine.getStateHash(),
    policies: {
      blue: {
        policy_id: "opted_in_human",
        checkpoint_id: null,
        behavior_probabilities: "unknown",
      },
      red: policyDescriptor(EDGER_BOT_ID),
    },
    source: {
      kind: "opted_in_player",
      collector: "manual_replay_import",
      human_action_actors: ["blue"],
      import_file_checksum: sha256Hex(fs.readFileSync(filePath)),
    },
  });
}

function importCommand(args) {
  if (args.files.length === 0) {
    throw new Error("import requires at least one --file");
  }
  const report = {
    command: "import",
    imported: [],
    quarantined: [],
  };
  for (const filePath of args.files) {
    const raw = fs.readFileSync(filePath);
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      const episode = payload.schema_version === "edger_training_episode_v1"
        ? validateTrainingEpisode(payload, { verifyReplay: true })
        : importManualExport(payload, filePath);
      report.imported.push({
        file: path.resolve(filePath),
        ...storeTrainingEpisode({ episode, store: args.store }),
      });
    } catch (error) {
      report.quarantined.push({
        file: path.resolve(filePath),
        reason: error instanceof Error ? error.message : String(error),
        ...quarantineTrainingPayload({ payload: raw, store: args.store }),
      });
    }
  }
  console.log(canonicalJson(report).trimEnd());
  if (report.quarantined.length > 0) {
    process.exitCode = 2;
  }
}

function manifestCommand(args) {
  const manifest = buildDatasetManifest({ store: args.store });
  const out = args.out ?? args.manifest ?? "artifacts/edger-training/manifests/edger_dataset_manifest.json";
  const resolved = writeDatasetManifest(out, manifest);
  console.log(canonicalJson({
    command: "manifest",
    manifest: resolved,
    manifest_hash: manifest.manifest_hash,
    statistics: manifest.statistics,
  }).trimEnd());
}

async function validateCommand(args) {
  const manifest = args.manifest ? readDatasetManifest(args.manifest) : null;
  if (manifest) {
    validateDatasetManifest(manifest);
  }
  const entries = (
    manifest?.shards.map((shard) => ({
      uri: shard.uri,
      checksum: shard.checksum,
      episode_id: shard.episode_id,
    })) ??
    listLocalEpisodeUris(args.store).map((uri) => ({
      uri,
      checksum: null,
      episode_id: path.basename(uri).split(".")[0] || null,
    }))
  ).map((entry, index) => ({ index, ...entry }));
  const startedAt = new Date();
  const workerCount = Math.min(args.workers, Math.max(1, entries.length));
  const partitions = Array.from({ length: workerCount }, () => []);
  entries.forEach((entry, index) => {
    partitions[index % partitions.length].push(entry);
  });
  const workerReports = entries.length === 0
    ? []
    : await Promise.all(partitions.map(runValidationWorker));
  const results = workerReports
    .flatMap((workerReport) => workerReport.results)
    .sort((left, right) => left.index - right.index);
  const failures = workerReports.flatMap((workerReport) => workerReport.failures);
  const report = {
    schema_version: "edger_corpus_validation_report_v1",
    command: "validate",
    status: failures.length === 0 && results.length === entries.length
      ? "passed"
      : "failed",
    checked_at: new Date().toISOString(),
    elapsed_seconds: (Date.now() - startedAt.getTime()) / 1000,
    workers: {
      requested: args.workers,
      used: entries.length === 0 ? 0 : workerCount,
    },
    manifest_hash: manifest?.manifest_hash ?? null,
    episodes: results.length,
    expected_episodes: entries.length,
    checks: {
      schemas: results.filter((result) => result.schema_verified).length,
      compressed_checksums: results.filter(
        (result) => result.checksum_verified === true,
      ).length,
      episode_ids: results.filter(
        (result) => result.episode_id_verified === true,
      ).length,
      replay: results.filter((result) => result.replay_verified).length,
      all_passed: failures.length === 0 && results.length === entries.length,
    },
    results,
    failures,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  fs.writeFileSync(args.report, canonicalJson(report));
  console.log(canonicalJson(report).trimEnd());
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

function runCanaryOnce({ seed, ticks }) {
  return runDeterministicCollectionCanary({ seed, ticks });
}

function canaryCommand(args) {
  const first = runCanaryOnce({ seed: args.seed, ticks: args.canaryTicks });
  const second = runCanaryOnce({ seed: args.seed, ticks: args.canaryTicks });
  const passed = JSON.stringify(first) === JSON.stringify(second);
  const report = {
    command: "canary",
    seed: args.seed,
    ticks: args.canaryTicks,
    passed,
    action_count: first.actions.length,
    final_state_hash: first.final_state_hash,
    replay_checksum: first.replay_checksum,
  };
  console.log(canonicalJson(report).trimEnd());
  if (!passed) {
    process.exitCode = 1;
  }
  return report;
}

function loadCampaignState(statePath) {
  if (statePath.startsWith("s3://")) {
    try {
      return JSON.parse(
        execFileSync(
          "aws",
          ["s3", "cp", statePath, "-", "--only-show-errors"],
          { encoding: "utf8" },
        ),
      );
    } catch {
      return {
        last_campaign_at: null,
        last_campaign_episode_count: 0,
        last_observed_episode_count: 0,
      };
    }
  }
  if (!fs.existsSync(statePath)) {
    return {
      last_campaign_at: null,
      last_campaign_episode_count: 0,
      last_observed_episode_count: 0,
    };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function writeCampaignState(statePath, state) {
  const serialized = canonicalJson(state);
  if (statePath.startsWith("s3://")) {
    execFileSync(
      "aws",
      ["s3", "cp", "-", statePath, "--only-show-errors"],
      { input: serialized, stdio: ["pipe", "pipe", "pipe"] },
    );
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
  fs.writeFileSync(statePath, serialized);
}

function elapsedDays(isoDate, now) {
  if (!isoDate) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000);
}

export function evaluateCampaignTrigger({ state, episodeCount, now = new Date() }) {
  const previousCampaignCount = Math.max(0, state.last_campaign_episode_count ?? 0);
  const newEpisodes = Math.max(0, episodeCount - previousCampaignCount);
  const growthRate = previousCampaignCount > 0
    ? newEpisodes / previousCampaignCount
    : episodeCount > 0
      ? 1
      : 0;
  const cooldownSatisfied = elapsedDays(state.last_campaign_at, now) >= CAMPAIGN_COOLDOWN_DAYS;
  const scaleTrigger = growthRate >= 0.2 || newEpisodes >= 100_000;
  const monthlyBackstop =
    newEpisodes > 0 && elapsedDays(state.last_campaign_at, now) >= MONTHLY_BACKSTOP_DAYS;
  return {
    should_trigger: cooldownSatisfied && (scaleTrigger || monthlyBackstop),
    cooldown_satisfied: cooldownSatisfied,
    scale_trigger: scaleTrigger,
    monthly_backstop: monthlyBackstop,
    new_episodes: newEpisodes,
    growth_rate: growthRate,
  };
}

function healthCommand(args) {
  const manifest = args.manifest
    ? readDatasetManifest(args.manifest)
    : buildDatasetManifest({ store: args.store });
  const statePath = args.state.startsWith("s3://") ? args.state : path.resolve(args.state);
  const state = loadCampaignState(statePath);
  const now = new Date();
  const trigger = evaluateCampaignTrigger({
    state,
    episodeCount: manifest.statistics.episodes,
    now,
  });
  const simulatorCount = manifest.shards.filter((shard) => shard.source === "simulator").length;
  const playerCount = manifest.shards.filter((shard) => shard.source === "opted_in_player").length;
  const playerFraction = manifest.shards.length > 0 ? playerCount / manifest.shards.length : 0;
  const report = {
    schema_version: "edger_corpus_health_report_v1",
    checked_at: now.toISOString(),
    manifest_hash: manifest.manifest_hash,
    statistics: manifest.statistics,
    mix: {
      simulator_episodes: simulatorCount,
      opted_in_player_episodes: playerCount,
      opted_in_player_fraction: playerFraction,
      within_default_player_cap: playerFraction <= 0.1,
    },
    campaign_trigger: trigger,
  };
  state.last_observed_episode_count = manifest.statistics.episodes;
  state.last_observed_manifest_hash = manifest.manifest_hash;
  state.last_health_check_at = now.toISOString();
  writeCampaignState(statePath, state);
  if (args.report) {
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(args.report, canonicalJson(report));
  }
  console.log(canonicalJson(report).trimEnd());
}

function campaignCompleteCommand(args) {
  if (!args.manifest) {
    throw new Error("campaign-complete requires --manifest");
  }
  const manifest = readDatasetManifest(args.manifest);
  const statePath = args.state.startsWith("s3://") ? args.state : path.resolve(args.state);
  const state = loadCampaignState(statePath);
  state.last_campaign_at = new Date().toISOString();
  state.last_campaign_episode_count = manifest.statistics.episodes;
  state.last_campaign_manifest_hash = manifest.manifest_hash;
  state.last_observed_episode_count = manifest.statistics.episodes;
  writeCampaignState(statePath, state);
  console.log(canonicalJson({
    command: "campaign-complete",
    state: statePath,
    episode_count: manifest.statistics.episodes,
    manifest_hash: manifest.manifest_hash,
  }).trimEnd());
}

function help() {
  console.log(`Usage:
  node scripts/edger-corpus.mjs collect [--store DIR|s3://...] [--matches EVEN] [--seed N] [--pair-offset N] [--workers 1-32] [--opponents ids] [--report FILE]
  node scripts/edger-corpus.mjs import --file replay.json [--store DIR|s3://...]
  node scripts/edger-corpus.mjs validate [--store DIR|s3://...] [--manifest FILE] [--workers 1-32] [--report FILE]
  node scripts/edger-corpus.mjs manifest [--store DIR|s3://...] [--out FILE]
  node scripts/edger-corpus.mjs health [--manifest FILE] [--state FILE] [--report FILE]
  node scripts/edger-corpus.mjs campaign-complete --manifest FILE [--state FILE]
  node scripts/edger-corpus.mjs canary [--seed N] [--canary-ticks N]`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.command === "collect") {
    await collectCommand(args);
  } else if (args.command === "import") {
    importCommand(args);
  } else if (args.command === "validate") {
    await validateCommand(args);
  } else if (args.command === "manifest") {
    manifestCommand(args);
  } else if (args.command === "health") {
    healthCommand(args);
  } else if (args.command === "campaign-complete") {
    campaignCompleteCommand(args);
  } else if (args.command === "canary") {
    canaryCommand(args);
  } else {
    help();
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
