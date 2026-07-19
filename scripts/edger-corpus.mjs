#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  EDGER_BOT_ID,
  HEURISTIC_BOT_ID,
  enumerateLegalCardActions,
  normalizeBotId,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../src/ai/botRuntime.js";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import { createRng } from "../src/sim/random.js";
import {
  cloneProductionInitialCardState,
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
    matches: 1,
    opponents: [HEURISTIC_BOT_ID],
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
  if (!Number.isInteger(parsed.matches) || parsed.matches < 1) {
    throw new Error("--matches must be a positive integer");
  }
  parsed.state ??= parsed.store.startsWith("s3://")
    ? `${parsed.store.replace(/\/+$/, "")}/state/campaign-state.json`
    : path.join(parsed.store, "state", "campaign-state.json");
  return parsed;
}

function controllerFor(seed) {
  return {
    rng: createRng(seed),
    nextDecisionTick: 1,
  };
}

function policyDescriptor(botId) {
  const normalized = normalizeBotId(botId);
  return {
    policy_id: normalized,
    checkpoint_id: normalized === EDGER_BOT_ID ? EDGER_POLICY_MODEL.model_id : null,
    behavior_probabilities:
      normalized === EDGER_BOT_ID || normalized === HEURISTIC_BOT_ID ? "known" : "unknown",
    league_rating: null,
  };
}

function maybeBotAction({ engine, actor, botId, controller }) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }
  const normalized = normalizeBotId(botId);
  const legalActions = enumerateLegalCardActions({ engine, actor });
  const decisionDelay = rollDecisionDelayTicks({
    botId: normalized,
    rng: controller.rng,
  });
  controller.nextDecisionTick = tick + decisionDelay;
  const selected = selectBotAction({
    botId: normalized,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
    edgerModel: EDGER_POLICY_MODEL,
  });
  if (selected?.type !== "PLAY_CARD") {
    return null;
  }
  return {
    tick,
    type: "PLAY_CARD",
    actor,
    cardId: selected.cardId,
    x: selected.x,
    y: selected.y,
  };
}

function runProductionBotMatch({ seed, blueBot, redBot, maxTicks = 6040 }) {
  const engine = createProductionEngine({ seed });
  const initialCardState = cloneProductionInitialCardState(engine);
  const blue = controllerFor(seed ^ 0x9e3779b9);
  const red = controllerFor(seed ^ 0x85ebca6b);

  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const actions = [];
    const blueAction = maybeBotAction({
      engine,
      actor: "blue",
      botId: blueBot,
      controller: blue,
    });
    const redAction = maybeBotAction({
      engine,
      actor: "red",
      botId: redBot,
      controller: red,
    });
    if (blueAction) {
      actions.push(blueAction);
    }
    if (redAction) {
      actions.push(redAction);
    }
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  if (!engine.getMatchResult()) {
    throw new Error(`production match did not finish by tick ${maxTicks}`);
  }
  return { engine, initialCardState };
}

function collectCommand(args) {
  const stored = [];
  for (let matchIndex = 0; matchIndex < args.matches; matchIndex += 1) {
    const opponent = args.opponents[matchIndex % args.opponents.length] ?? HEURISTIC_BOT_ID;
    const swapSides = matchIndex % 2 === 1;
    const blueBot = swapSides ? opponent : EDGER_BOT_ID;
    const redBot = swapSides ? EDGER_BOT_ID : opponent;
    const seed = args.seed + matchIndex;
    const { engine, initialCardState } = runProductionBotMatch({
      seed,
      blueBot,
      redBot,
    });
    const episode = createTrainingEpisode({
      seed,
      initialCardState,
      actions: engine.state.replay.actions,
      events: engine.state.replay.events,
      result: engine.getMatchResult(),
      finalStateHash: engine.getStateHash(),
      policies: {
        blue: policyDescriptor(blueBot),
        red: policyDescriptor(redBot),
      },
      source: {
        kind: "simulator",
        collector: "scripts/edger-corpus.mjs",
      },
    });
    stored.push(storeTrainingEpisode({ episode, store: args.store }));
  }
  console.log(canonicalJson({ command: "collect", stored }).trimEnd());
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

function validateCommand(args) {
  const manifest = args.manifest ? readDatasetManifest(args.manifest) : null;
  const uris = manifest?.shards.map((shard) => shard.uri) ?? listLocalEpisodeUris(args.store);
  const results = [];
  for (const uri of uris) {
    const episode = loadTrainingEpisode(uri);
    results.push({ uri, ...verifyTrainingEpisodeReplay(episode) });
  }
  if (manifest) {
    validateDatasetManifest(manifest);
  }
  console.log(canonicalJson({
    command: "validate",
    episodes: results.length,
    results,
  }).trimEnd());
}

function runCanaryOnce({ seed, ticks }) {
  const engine = createProductionEngine({ seed });
  const blue = controllerFor(seed ^ 0x9e3779b9);
  const red = controllerFor(seed ^ 0x85ebca6b);
  const actions = [];
  while (engine.state.tick < ticks && !engine.getMatchResult()) {
    const blueAction = maybeBotAction({
      engine,
      actor: "blue",
      botId: HEURISTIC_BOT_ID,
      controller: blue,
    });
    const redAction = maybeBotAction({
      engine,
      actor: "red",
      botId: EDGER_BOT_ID,
      controller: red,
    });
    const tickActions = [blueAction, redAction].filter(Boolean);
    actions.push(...tickActions);
    engine.step(tickActions);
  }
  return {
    actions,
    final_state_hash: engine.getStateHash(),
    replay_checksum: sha256Hex(engine.exportReplay()),
  };
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
  node scripts/edger-corpus.mjs collect [--store DIR|s3://...] [--matches N] [--seed N] [--opponents ids]
  node scripts/edger-corpus.mjs import --file replay.json [--store DIR|s3://...]
  node scripts/edger-corpus.mjs validate [--store DIR|s3://...] [--manifest FILE]
  node scripts/edger-corpus.mjs manifest [--store DIR|s3://...] [--out FILE]
  node scripts/edger-corpus.mjs health [--manifest FILE] [--state FILE] [--report FILE]
  node scripts/edger-corpus.mjs campaign-complete --manifest FILE [--state FILE]
  node scripts/edger-corpus.mjs canary [--seed N] [--canary-ticks N]`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.command === "collect") {
    collectCommand(args);
  } else if (args.command === "import") {
    importCommand(args);
  } else if (args.command === "validate") {
    validateCommand(args);
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
