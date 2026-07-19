import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  EDGER_V2_ACTION_SPACE_VERSION,
  EDGER_V2_DELAY_BINS,
  EDGER_V2_OBSERVATION_SCHEMA_VERSION,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  encodeEdgerV2Action,
  isEdgerV2ActionLegal,
} from "../src/ai/v2/observation.js";
import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { REPLAY_SCHEMA_VERSION } from "../src/replay/schema.js";
import { MATCH_CONFIG } from "../src/sim/config.js";
import {
  EDGER_RULES_VERSION,
  EDGER_SIMULATOR_VERSION,
  PRODUCTION_ARENA_DESCRIPTOR,
  createProductionEngine,
  createProductionInitialEntities,
} from "../src/sim/productionMatch.js";

export const EDGER_TRAINING_EPISODE_SCHEMA_VERSION = "edger_training_episode_v1";
export const EDGER_DECISION_SEQUENCE_SCHEMA_VERSION = "edger_decision_sequence_v1";
export const EDGER_DATASET_MANIFEST_SCHEMA_VERSION = "edger_dataset_manifest_v1";
export const EDGER_REWARD_VERSION = "edger_potential_reward_v1";
export const EDGER_COMPATIBILITY_COHORT = [
  EDGER_RULES_VERSION,
  EDGER_SIMULATOR_VERSION,
  REPLAY_SCHEMA_VERSION,
  EDGER_V2_OBSERVATION_SCHEMA_VERSION,
  EDGER_V2_ACTION_SPACE_VERSION,
].join("|");
export const DEFAULT_CORPUS_STORE = "artifacts/edger-training/corpus";

const MAX_MATCH_TICKS = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40;
const PER_TICK_GAMMA = 0.9997;
const FORBIDDEN_IDENTITY_KEYS = new Set([
  "email",
  "identity",
  "name",
  "player_id",
  "profile",
  "user_id",
  "username",
]);

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObject(value[key]);
      return result;
    }, {});
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

export function canonicalCompactJson(value) {
  return JSON.stringify(sortObject(value));
}

export function sha256Hex(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(input).digest("hex");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAction(action) {
  const normalized = {
    tick: Number.parseInt(action.tick, 10),
    type: action.type,
    actor: action.actor,
  };
  if (action.type === "PLAY_CARD") {
    normalized.cardId = action.cardId;
    normalized.x = Number(action.x);
    normalized.y = Number(action.y);
  }
  return normalized;
}

function normalizePolicies(policies = {}) {
  const normalize = (actor, fallback) => {
    const policy = policies[actor] ?? {};
    return {
      policy_id: String(policy.policy_id ?? fallback),
      checkpoint_id: policy.checkpoint_id === null || policy.checkpoint_id === undefined
        ? null
        : String(policy.checkpoint_id),
      behavior_probabilities: policy.behavior_probabilities === "known"
        ? "known"
        : "unknown",
      league_rating: Number.isFinite(policy.league_rating) ? policy.league_rating : null,
    };
  };
  return {
    blue: normalize("blue", "unknown_blue"),
    red: normalize("red", "unknown_red"),
  };
}

function behaviorLogProbabilityForActor(policies, actor) {
  return policies[actor]?.behavior_probabilities === "known" ? 0 : null;
}

export function buildSparseDecisionStream({
  actions,
  finalTick,
  policies,
}) {
  const normalizedPolicies = normalizePolicies(policies);
  const decisions = [];
  for (const actor of ["blue", "red"]) {
    const actorActions = actions
      .filter((action) => action.actor === actor && action.type === "PLAY_CARD")
      .map(normalizeAction)
      .sort((left, right) => left.tick - right.tick);
    let actionIndex = 0;
    let tick = 1;
    while (tick <= finalTick) {
      const selected =
        actorActions[actionIndex]?.tick === tick
          ? actorActions[actionIndex++]
          : { type: "PASS" };
      const nextActionTick = actorActions[actionIndex]?.tick ?? finalTick + 1;
      const remaining = Math.max(1, nextActionTick - tick);
      const delayTicks = Math.min(EDGER_V2_DELAY_BINS, remaining);
      decisions.push({
        tick,
        actor,
        action: selected.type === "PASS"
          ? { type: "PASS" }
          : {
              type: "PLAY_CARD",
              cardId: selected.cardId,
              x: selected.x,
              y: selected.y,
            },
        delay_ticks: delayTicks,
        behavior_log_probability: behaviorLogProbabilityForActor(normalizedPolicies, actor),
        opponent_stratum: normalizedPolicies[actor === "blue" ? "red" : "blue"].policy_id,
      });
      tick += delayTicks;
    }
  }
  return decisions.sort((left, right) => {
    if (left.tick !== right.tick) {
      return left.tick - right.tick;
    }
    return left.actor.localeCompare(right.actor);
  });
}

function replayChecksum(replay) {
  return sha256Hex(canonicalCompactJson(replay));
}

function episodeContentForHash(episode) {
  const copy = cloneJson(episode);
  delete copy.episode_id;
  return copy;
}

function initialEntitySnapshot() {
  return createProductionInitialEntities().map((entity) => cloneJson(entity));
}

function normalizeSource(source = {}) {
  const normalized = {
    kind: source.kind === "opted_in_player" ? "opted_in_player" : "simulator",
    collector: String(source.collector ?? "edge_royale"),
    human_action_actors: Array.isArray(source.human_action_actors)
      ? source.human_action_actors.filter((actor) => actor === "blue" || actor === "red")
      : [],
  };
  if (source.import_file_checksum) {
    normalized.import_file_checksum = String(source.import_file_checksum);
  }
  return normalized;
}

function assertNoIdentity(value, pathParts = []) {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key.toLowerCase())) {
      throw new Error(`identity field is not allowed in training episodes: ${[...pathParts, key].join(".")}`);
    }
    assertNoIdentity(child, [...pathParts, key]);
  }
}

export function createTrainingEpisode({
  seed,
  initialCardState,
  actions,
  events,
  result,
  finalStateHash,
  policies,
  source,
  decisions = null,
}) {
  if (!result || !Number.isFinite(result.tick)) {
    throw new Error("complete match result is required");
  }
  const normalizedActions = actions.map(normalizeAction);
  const normalizedPolicies = normalizePolicies(policies);
  const replay = {
    version: REPLAY_SCHEMA_VERSION,
    seed,
    actions: normalizedActions,
    events: cloneJson(events),
  };
  const episode = {
    schema_version: EDGER_TRAINING_EPISODE_SCHEMA_VERSION,
    compatibility: {
      cohort: EDGER_COMPATIBILITY_COHORT,
      rules_version: EDGER_RULES_VERSION,
      simulator_version: EDGER_SIMULATOR_VERSION,
      replay_schema_version: REPLAY_SCHEMA_VERSION,
      observation_schema_version: EDGER_V2_OBSERVATION_SCHEMA_VERSION,
      action_space_version: EDGER_V2_ACTION_SPACE_VERSION,
      reward_version: EDGER_REWARD_VERSION,
    },
    seed,
    initial: {
      arena: { ...PRODUCTION_ARENA_DESCRIPTOR },
      entities: initialEntitySnapshot(),
      cards: cloneJson(initialCardState),
      elixir: { blue: 5, red: 5 },
    },
    policies: normalizedPolicies,
    action_stream: normalizedActions,
    decision_stream: decisions ?? buildSparseDecisionStream({
      actions: normalizedActions,
      finalTick: result.tick,
      policies: normalizedPolicies,
    }),
    result: cloneJson(result),
    final_state_hash: String(finalStateHash),
    source: normalizeSource(source),
    replay,
    replay_checksum: replayChecksum(replay),
  };
  assertNoIdentity(episode);
  episode.episode_id = sha256Hex(canonicalCompactJson(episodeContentForHash(episode)));
  return validateTrainingEpisode(episode);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertCompatibility(episode) {
  const expected = {
    cohort: EDGER_COMPATIBILITY_COHORT,
    rules_version: EDGER_RULES_VERSION,
    simulator_version: EDGER_SIMULATOR_VERSION,
    replay_schema_version: REPLAY_SCHEMA_VERSION,
    observation_schema_version: EDGER_V2_OBSERVATION_SCHEMA_VERSION,
    action_space_version: EDGER_V2_ACTION_SPACE_VERSION,
    reward_version: EDGER_REWARD_VERSION,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (episode.compatibility?.[key] !== value) {
      throw new Error(`incompatible ${key}: expected ${value}, got ${episode.compatibility?.[key]}`);
    }
  }
}

function validateDecision(decision, index) {
  requireObject(decision, `decision_stream[${index}]`);
  if (!Number.isInteger(decision.tick) || decision.tick < 1) {
    throw new Error(`decision_stream[${index}].tick must be a positive integer`);
  }
  if (decision.actor !== "blue" && decision.actor !== "red") {
    throw new Error(`decision_stream[${index}].actor must be blue or red`);
  }
  if (!Number.isInteger(decision.delay_ticks) || decision.delay_ticks < 1 || decision.delay_ticks > EDGER_V2_DELAY_BINS) {
    throw new Error(`decision_stream[${index}].delay_ticks must be 1-${EDGER_V2_DELAY_BINS}`);
  }
  if (decision.action?.type !== "PASS" && decision.action?.type !== "PLAY_CARD") {
    throw new Error(`decision_stream[${index}].action must be PASS or PLAY_CARD`);
  }
  if (
    decision.behavior_log_probability !== null &&
    !Number.isFinite(decision.behavior_log_probability)
  ) {
    throw new Error(`decision_stream[${index}].behavior_log_probability must be finite or null`);
  }
}

export function validateTrainingEpisode(episode, { verifyReplay = false } = {}) {
  requireObject(episode, "episode");
  if (episode.schema_version !== EDGER_TRAINING_EPISODE_SCHEMA_VERSION) {
    throw new Error(`episode schema_version must be ${EDGER_TRAINING_EPISODE_SCHEMA_VERSION}`);
  }
  assertCompatibility(episode);
  assertNoIdentity(episode);
  if (!Number.isInteger(episode.seed)) {
    throw new Error("episode.seed must be an integer");
  }
  if (
    episode.initial?.arena?.type !== "royale" ||
    episode.initial.arena.min_x !== 0 ||
    episode.initial.arena.max_x !== 18 ||
    episode.initial.arena.min_y !== 0 ||
    episode.initial.arena.max_y !== 32
  ) {
    throw new Error("episode must use the production 18x32 Royale arena");
  }
  if (!Array.isArray(episode.initial?.entities) || episode.initial.entities.length !== 6) {
    throw new Error("episode must contain the six production towers");
  }
  if (!Array.isArray(episode.action_stream) || !Array.isArray(episode.decision_stream)) {
    throw new Error("episode action_stream and decision_stream must be arrays");
  }
  episode.decision_stream.forEach(validateDecision);
  requireObject(episode.result, "episode.result");
  if (!Number.isInteger(episode.result.tick) || episode.result.tick < 1 || episode.result.tick > MAX_MATCH_TICKS) {
    throw new Error(`episode.result.tick must be within a full production match (1-${MAX_MATCH_TICKS})`);
  }
  if (episode.replay_checksum !== replayChecksum(episode.replay)) {
    throw new Error("episode replay_checksum mismatch");
  }
  const expectedId = sha256Hex(canonicalCompactJson(episodeContentForHash(episode)));
  if (episode.episode_id !== expectedId) {
    throw new Error("episode_id content hash mismatch");
  }
  if (verifyReplay) {
    verifyTrainingEpisodeReplay(episode);
  }
  return episode;
}

export function runReplayToCompletion({ engine, actions, finalTick }) {
  const byTick = new Map();
  for (const action of actions) {
    const list = byTick.get(action.tick) ?? [];
    list.push(action);
    byTick.set(action.tick, list);
  }
  while (engine.state.tick < finalTick && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    engine.step(byTick.get(tick) ?? []);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  return engine;
}

export function verifyTrainingEpisodeReplay(episode) {
  validateTrainingEpisode(episode);
  const engine = createProductionEngine({
    seed: episode.seed,
    initialCardState: episode.initial.cards,
  });
  runReplayToCompletion({
    engine,
    actions: episode.action_stream,
    finalTick: episode.result.tick,
  });
  if (engine.state.tick !== episode.result.tick) {
    throw new Error(`replay stopped at tick ${engine.state.tick}; expected ${episode.result.tick}`);
  }
  if (engine.getStateHash() !== episode.final_state_hash) {
    throw new Error(
      `final state hash mismatch: ${engine.getStateHash()} != ${episode.final_state_hash}`,
    );
  }
  if (canonicalCompactJson(engine.getMatchResult()) !== canonicalCompactJson(episode.result)) {
    throw new Error("replayed match result mismatch");
  }
  const replay = JSON.parse(engine.exportReplay());
  if (replayChecksum(replay) !== episode.replay_checksum) {
    throw new Error("replayed events/actions checksum mismatch");
  }
  return {
    episode_id: episode.episode_id,
    final_state_hash: engine.getStateHash(),
    replay_checksum: replayChecksum(replay),
    actions: replay.actions.length,
    events: replay.events.length,
  };
}

function scorePotential(engine, actor) {
  const score = engine.getScore();
  const ownCrowns = actor === "blue" ? score.blue_crowns : score.red_crowns;
  const enemyCrowns = actor === "blue" ? score.red_crowns : score.blue_crowns;
  const ownHp = actor === "blue" ? score.blue_tower_hp : score.red_tower_hp;
  const enemyHp = actor === "blue" ? score.red_tower_hp : score.blue_tower_hp;
  return (ownCrowns - enemyCrowns) * 0.25 + (ownHp - enemyHp) / 30_000;
}

function terminalReward(result, actor) {
  if (!result?.winner) {
    return 0;
  }
  return result.winner === actor ? 1 : -1;
}

function masksAsArrays(masks) {
  return {
    card: Array.from(masks.card),
    placement: Array.from(masks.placement),
    delay: Array.from(masks.delay),
  };
}

export function deriveDecisionSequence(episode) {
  validateTrainingEpisode(episode);
  const engine = createProductionEngine({
    seed: episode.seed,
    initialCardState: episode.initial.cards,
  });
  const decisionsByTick = new Map();
  for (const decision of episode.decision_stream) {
    const list = decisionsByTick.get(decision.tick) ?? [];
    list.push(decision);
    decisionsByTick.set(decision.tick, list);
  }
  const actionsByTick = new Map();
  for (const action of episode.action_stream) {
    const list = actionsByTick.get(action.tick) ?? [];
    list.push(action);
    actionsByTick.set(action.tick, list);
  }
  const samples = [];

  while (engine.state.tick < episode.result.tick && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    for (const decision of (decisionsByTick.get(tick) ?? []).sort((a, b) => a.actor.localeCompare(b.actor))) {
      const legalActions = enumerateLegalCardActions({
        engine,
        actor: decision.actor,
      });
      if (!isEdgerV2ActionLegal({
        actor: decision.actor,
        action: decision.action,
        legalActions,
      })) {
        throw new Error(
          `illegal selected action in ${episode.episode_id} at tick ${tick} for ${decision.actor}`,
        );
      }
      const selected = encodeEdgerV2Action({
        actor: decision.actor,
        action: decision.action,
        delayTicks: decision.delay_ticks,
      });
      const legalMasks = buildEdgerV2LegalMasks({
        actor: decision.actor,
        selectedCardIndex: selected.card_index,
        legalActions,
      });
      if (
        !legalMasks.card[selected.card_index] ||
        !legalMasks.placement[selected.placement_index] ||
        !legalMasks.delay[selected.delay_index]
      ) {
        throw new Error(
          `selected action was masked in ${episode.episode_id} at tick ${tick} for ${decision.actor}`,
        );
      }
      const observation = buildEdgerV2Observation({ engine, actor: decision.actor });
      const actorPolicy = episode.policies[decision.actor];
      samples.push({
        episode_id: episode.episode_id,
        tick,
        actor: decision.actor,
        opponent_stratum: decision.opponent_stratum,
        board: Array.from(observation.board),
        global: Array.from(observation.global),
        legal_masks: masksAsArrays(legalMasks),
        selected,
        delay_ticks: decision.delay_ticks,
        reward: 0,
        discounted_return: 0,
        behavior_log_probability: decision.behavior_log_probability,
        vtrace_eligible: decision.behavior_log_probability !== null,
        source_kind: episode.source.kind,
        is_winner: episode.result.winner === decision.actor,
        policy_id: actorPolicy.policy_id,
        policy_checkpoint_id: actorPolicy.checkpoint_id,
        policy_league_rating: actorPolicy.league_rating,
        potential: scorePotential(engine, decision.actor),
      });
    }
    engine.step(actionsByTick.get(tick) ?? []);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }

  for (const actor of ["blue", "red"]) {
    const actorSamples = samples.filter((sample) => sample.actor === actor);
    let nextPotential = scorePotential(engine, actor);
    let nextTick = episode.result.tick + 1;
    let nextReturn = terminalReward(episode.result, actor);
    for (let index = actorSamples.length - 1; index >= 0; index -= 1) {
      const sample = actorSamples[index];
      const deltaTicks = Math.max(1, nextTick - sample.tick);
      const discount = PER_TICK_GAMMA ** deltaTicks;
      const shaped = discount * nextPotential - sample.potential;
      const isLastDecision = index === actorSamples.length - 1;
      sample.reward = shaped + (
        isLastDecision ? discount * terminalReward(episode.result, actor) : 0
      );
      sample.discounted_return = shaped + discount * nextReturn;
      nextReturn = sample.discounted_return;
      nextPotential = sample.potential;
      nextTick = sample.tick;
      delete sample.potential;
    }
  }

  return {
    schema_version: EDGER_DECISION_SEQUENCE_SCHEMA_VERSION,
    episode_id: episode.episode_id,
    compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    reward_version: EDGER_REWARD_VERSION,
    per_tick_gamma: PER_TICK_GAMMA,
    samples,
  };
}

export function splitForEpisodeId(episodeId) {
  const bucket = Number.parseInt(episodeId.slice(0, 8), 16) % 100;
  if (bucket < 80) {
    return "train";
  }
  if (bucket < 90) {
    return "validation";
  }
  return "test";
}

function isS3Uri(uri) {
  return String(uri).startsWith("s3://");
}

function objectRelativePath(hash) {
  return path.posix.join(
    "objects",
    "sha256",
    hash.slice(0, 2),
    `${hash}.edger-episode.json.gz`,
  );
}

function quarantineRelativePath(hash) {
  return path.posix.join(
    "quarantine",
    "sha256",
    hash.slice(0, 2),
    `${hash}.json.gz`,
  );
}

function joinStoreUri(store, relative) {
  if (isS3Uri(store)) {
    return `${store.replace(/\/+$/, "")}/${relative}`;
  }
  return path.resolve(store, relative);
}

function writeObject(uri, bytes) {
  if (isS3Uri(uri)) {
    execFileSync("aws", ["s3", "cp", "-", uri, "--only-show-errors"], {
      input: bytes,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return;
  }
  fs.mkdirSync(path.dirname(uri), { recursive: true });
  if (!fs.existsSync(uri)) {
    fs.writeFileSync(uri, bytes, { flag: "wx" });
  }
}

function readObject(uri) {
  if (isS3Uri(uri)) {
    return execFileSync("aws", ["s3", "cp", uri, "-", "--only-show-errors"], {
      encoding: null,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  }
  return fs.readFileSync(uri);
}

export function storeTrainingEpisode({
  episode,
  store = DEFAULT_CORPUS_STORE,
  verifyReplay = true,
}) {
  validateTrainingEpisode(episode, { verifyReplay });
  const bytes = Buffer.from(canonicalJson(episode));
  const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
  const uri = joinStoreUri(store, objectRelativePath(episode.episode_id));
  const existed = isS3Uri(uri)
    ? false
    : fs.existsSync(uri);
  writeObject(uri, compressed);
  return {
    episode_id: episode.episode_id,
    uri,
    checksum: sha256Hex(compressed),
    uncompressed_checksum: sha256Hex(bytes),
    compressed_bytes: compressed.byteLength,
    deduplicated: existed,
  };
}

export function quarantineTrainingPayload({
  payload,
  store = DEFAULT_CORPUS_STORE,
}) {
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : canonicalJson(payload));
  const hash = sha256Hex(bytes);
  const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
  const uri = joinStoreUri(store, quarantineRelativePath(hash));
  writeObject(uri, compressed);
  return { hash, uri, checksum: sha256Hex(compressed) };
}

export function loadTrainingEpisode(uri, { verifyReplay = false } = {}) {
  const compressed = readObject(uri);
  const episode = JSON.parse(gunzipSync(compressed).toString("utf8"));
  return validateTrainingEpisode(episode, { verifyReplay });
}

export function listLocalEpisodeUris(store = DEFAULT_CORPUS_STORE) {
  if (isS3Uri(store)) {
    const parsed = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(store.replace(/\/+$/, ""));
    if (!parsed) {
      throw new Error(`invalid S3 corpus URI ${store}`);
    }
    const bucketUri = `s3://${parsed[1]}`;
    const output = execFileSync(
      "aws",
      ["s3", "ls", `${store.replace(/\/+$/, "")}/objects/sha256/`, "--recursive"],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter((key) => key?.endsWith(".edger-episode.json.gz"))
      .map((key) => `${bucketUri}/${key}`);
  }
  const root = path.resolve(store, "objects", "sha256");
  if (!fs.existsSync(root)) {
    return [];
  }
  const uris = [];
  for (const prefix of fs.readdirSync(root).sort()) {
    const prefixPath = path.join(root, prefix);
    if (!fs.statSync(prefixPath).isDirectory()) {
      continue;
    }
    for (const filename of fs.readdirSync(prefixPath).sort()) {
      if (filename.endsWith(".edger-episode.json.gz")) {
        uris.push(path.join(prefixPath, filename));
      }
    }
  }
  return uris;
}

function statisticsForEpisodes(episodes) {
  const statistics = {
    episodes: episodes.length,
    decisions: 0,
    sources: {},
    results: { blue: 0, red: 0, draw: 0 },
    opponents: {},
    splits: { train: 0, validation: 0, test: 0 },
  };
  for (const episode of episodes) {
    statistics.decisions += episode.decision_stream.length;
    statistics.sources[episode.source.kind] = (statistics.sources[episode.source.kind] ?? 0) + 1;
    const winner = episode.result.winner ?? "draw";
    statistics.results[winner] = (statistics.results[winner] ?? 0) + 1;
    const matchup = [episode.policies.blue.policy_id, episode.policies.red.policy_id].sort().join("_vs_");
    statistics.opponents[matchup] = (statistics.opponents[matchup] ?? 0) + 1;
    const split = splitForEpisodeId(episode.episode_id);
    statistics.splits[split] += 1;
  }
  return statistics;
}

export function buildDatasetManifest({
  store = DEFAULT_CORPUS_STORE,
  episodeUris = null,
}) {
  const uris = episodeUris ?? listLocalEpisodeUris(store);
  const seen = new Set();
  const shards = [];
  const episodes = [];
  for (const uri of [...uris].sort()) {
    const compressed = readObject(uri);
    const episode = validateTrainingEpisode(
      JSON.parse(gunzipSync(compressed).toString("utf8")),
    );
    if (seen.has(episode.episode_id)) {
      continue;
    }
    seen.add(episode.episode_id);
    episodes.push(episode);
    shards.push({
      uri,
      checksum: sha256Hex(compressed),
      episode_id: episode.episode_id,
      split: splitForEpisodeId(episode.episode_id),
      source: episode.source.kind,
    });
  }
  const manifest = {
    schema_version: EDGER_DATASET_MANIFEST_SCHEMA_VERSION,
    compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    split_policy: "sha256_episode_id_mod_100_v1",
    split_ranges: {
      train: "0-79",
      validation: "80-89",
      test: "90-99",
    },
    shards,
    statistics: statisticsForEpisodes(episodes),
  };
  manifest.manifest_hash = sha256Hex(canonicalCompactJson(manifest));
  return manifest;
}

export function validateDatasetManifest(manifest) {
  requireObject(manifest, "manifest");
  if (manifest.schema_version !== EDGER_DATASET_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest schema_version must be ${EDGER_DATASET_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.compatibility_cohort !== EDGER_COMPATIBILITY_COHORT) {
    throw new Error("manifest compatibility cohort mismatch");
  }
  if (!Array.isArray(manifest.shards)) {
    throw new Error("manifest.shards must be an array");
  }
  const ids = new Set();
  for (const shard of manifest.shards) {
    if (ids.has(shard.episode_id)) {
      throw new Error(`duplicate episode ${shard.episode_id} in manifest`);
    }
    ids.add(shard.episode_id);
    if (shard.split !== splitForEpisodeId(shard.episode_id)) {
      throw new Error(`unstable split for episode ${shard.episode_id}`);
    }
  }
  const copy = cloneJson(manifest);
  delete copy.manifest_hash;
  if (manifest.manifest_hash !== sha256Hex(canonicalCompactJson(copy))) {
    throw new Error("manifest_hash mismatch");
  }
  return manifest;
}

export function writeDatasetManifest(filePath, manifest) {
  validateDatasetManifest(manifest);
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(manifest));
  return path.resolve(filePath);
}

export function readDatasetManifest(filePath) {
  return validateDatasetManifest(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function readCompressedEpisodeBytes(uri) {
  return readObject(uri);
}
