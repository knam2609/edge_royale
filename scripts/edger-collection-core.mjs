import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  EDGER_COMPATIBILITY_COHORT,
  canonicalCompactJson,
  canonicalJson,
  createTrainingEpisode,
  loadTrainingEpisode,
  readCompressedEpisodeBytes,
  sha256Hex,
  storeTrainingEpisode,
  verifyTrainingEpisodeReplay,
} from "./edger-corpus-core.mjs";

export const EDGER_COLLECTION_REPORT_SCHEMA_VERSION = "edger_collection_report_v1";
export const EDGER_COLLECTION_RECEIPT_SCHEMA_VERSION = "edger_collection_receipt_v1";
export const DEFAULT_COLLECTION_OPPONENTS = Object.freeze([
  HEURISTIC_BOT_ID,
  "random",
  "aggressive",
  "defender",
]);

function isS3Uri(value) {
  return String(value).startsWith("s3://");
}

function joinStoreUri(store, relativePath) {
  return isS3Uri(store)
    ? `${store.replace(/\/+$/, "")}/${relativePath}`
    : path.resolve(store, relativePath);
}

function readBytes(uri) {
  if (isS3Uri(uri)) {
    return execFileSync("aws", ["s3", "cp", uri, "-", "--only-show-errors"], {
      encoding: null,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  return fs.readFileSync(uri);
}

function writeBytes(uri, bytes) {
  if (isS3Uri(uri)) {
    execFileSync("aws", ["s3", "cp", "-", uri, "--only-show-errors"], {
      input: bytes,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return;
  }
  fs.mkdirSync(path.dirname(uri), { recursive: true });
  fs.writeFileSync(uri, bytes);
}

export function getCleanGitProvenance({ cwd = process.cwd() } = {}) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd, encoding: "utf8" },
  ).trim();
  if (status) {
    throw new Error(
      "authoritative Edger collection requires a clean Git worktree; commit or remove changes first",
    );
  }
  return {
    commit,
    clean: true,
    node_version: process.version,
    architecture: process.arch,
    platform: process.platform,
  };
}

export function buildCollectionSpecs({
  matches,
  seed,
  pairOffset = 0,
  opponents = DEFAULT_COLLECTION_OPPONENTS,
}) {
  if (!Number.isInteger(matches) || matches < 2 || matches % 2 !== 0) {
    throw new Error("--matches must be a positive even integer");
  }
  if (!Number.isInteger(seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(pairOffset) || pairOffset < 0) {
    throw new Error("--pair-offset must be a non-negative integer");
  }
  const normalizedOpponents = opponents.map((opponent) => normalizeBotId(opponent));
  if (normalizedOpponents.length === 0) {
    throw new Error("at least one opponent is required");
  }
  const pairs = matches / 2;
  if (pairs % normalizedOpponents.length !== 0) {
    throw new Error(
      `paired seeds (${pairs}) must divide equally across ${normalizedOpponents.length} opponents`,
    );
  }
  const specs = [];
  for (let localPairIndex = 0; localPairIndex < pairs; localPairIndex += 1) {
    const globalPairIndex = pairOffset + localPairIndex;
    const opponent = normalizedOpponents[globalPairIndex % normalizedOpponents.length];
    const matchSeed = seed + globalPairIndex;
    for (const edgerActor of ["blue", "red"]) {
      const identity = {
        compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
        seed: matchSeed,
        edger_actor: edgerActor,
        opponent,
      };
      specs.push(Object.freeze({
        global_match_index: globalPairIndex * 2 + (edgerActor === "blue" ? 0 : 1),
        pair_index: globalPairIndex,
        seed: matchSeed,
        edger_actor: edgerActor,
        opponent,
        spec_id: sha256Hex(canonicalCompactJson(identity)),
      }));
    }
  }
  return Object.freeze(specs);
}

export function collectionSpecChecksum(specs) {
  return sha256Hex(canonicalCompactJson(specs.map((spec) => ({
    global_match_index: spec.global_match_index,
    pair_index: spec.pair_index,
    seed: spec.seed,
    edger_actor: spec.edger_actor,
    opponent: spec.opponent,
    spec_id: spec.spec_id,
  }))));
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

export function runDeterministicCollectionCanary({ seed, ticks }) {
  const engine = createProductionEngine({ seed });
  const blue = controllerFor(seed ^ 0x9e3779b9);
  const red = controllerFor(seed ^ 0x85ebca6b);
  const actions = [];
  while (engine.state.tick < ticks && !engine.getMatchResult()) {
    const tickActions = [
      maybeBotAction({
        engine,
        actor: "blue",
        botId: HEURISTIC_BOT_ID,
        controller: blue,
      }),
      maybeBotAction({
        engine,
        actor: "red",
        botId: EDGER_BOT_ID,
        controller: red,
      }),
    ].filter(Boolean);
    actions.push(...tickActions);
    engine.step(tickActions);
  }
  return {
    actions,
    final_state_hash: engine.getStateHash(),
    replay_checksum: sha256Hex(engine.exportReplay()),
  };
}

export function runCollectionSpec(spec) {
  const blueBot = spec.edger_actor === "blue" ? EDGER_BOT_ID : spec.opponent;
  const redBot = spec.edger_actor === "red" ? EDGER_BOT_ID : spec.opponent;
  const engine = createProductionEngine({ seed: spec.seed });
  const initialCardState = cloneProductionInitialCardState(engine);
  const blue = controllerFor(spec.seed ^ 0x9e3779b9);
  const red = controllerFor(spec.seed ^ 0x85ebca6b);

  while (engine.state.tick < 6040 && !engine.getMatchResult()) {
    const actions = [
      maybeBotAction({ engine, actor: "blue", botId: blueBot, controller: blue }),
      maybeBotAction({ engine, actor: "red", botId: redBot, controller: red }),
    ].filter(Boolean);
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  if (!engine.getMatchResult()) {
    throw new Error(`production match ${spec.global_match_index} did not finish by tick 6040`);
  }
  const episode = createTrainingEpisode({
    seed: spec.seed,
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
      collector: "scripts/edger-corpus-worker.mjs",
    },
  });
  return {
    episode,
    action_stream_hash: sha256Hex(canonicalCompactJson(episode.action_stream)),
  };
}

function receiptUri(store, specId) {
  return joinStoreUri(
    store,
    path.posix.join(
      "receipts",
      "sha256",
      specId.slice(0, 2),
      `${specId}.edger-collection-receipt.json`,
    ),
  );
}

function resultFromReceipt(receipt, { resumed }) {
  return {
    global_match_index: receipt.spec.global_match_index,
    pair_index: receipt.spec.pair_index,
    seed: receipt.spec.seed,
    edger_actor: receipt.spec.edger_actor,
    opponent: receipt.spec.opponent,
    spec_id: receipt.spec.spec_id,
    episode_id: receipt.episode.episode_id,
    uri: receipt.episode.uri,
    checksum: receipt.episode.checksum,
    uncompressed_checksum: receipt.episode.uncompressed_checksum,
    action_stream_hash: receipt.verification.action_stream_hash,
    final_state_hash: receipt.verification.final_state_hash,
    replay_checksum: receipt.verification.replay_checksum,
    replay_verified: true,
    outcome: receipt.outcome,
    resumed,
  };
}

export function loadVerifiedCollectionReceipt({ spec, store }) {
  const uri = receiptUri(store, spec.spec_id);
  let receipt;
  try {
    receipt = JSON.parse(readBytes(uri).toString("utf8"));
  } catch {
    return null;
  }
  if (
    receipt.schema_version !== EDGER_COLLECTION_RECEIPT_SCHEMA_VERSION ||
    canonicalCompactJson(receipt.spec) !== canonicalCompactJson(spec)
  ) {
    return null;
  }
  try {
    const compressed = readCompressedEpisodeBytes(receipt.episode.uri);
    if (sha256Hex(compressed) !== receipt.episode.checksum) {
      return null;
    }
    const episode = loadTrainingEpisode(receipt.episode.uri, { verifyReplay: true });
    if (
      episode.episode_id !== receipt.episode.episode_id ||
      episode.final_state_hash !== receipt.verification.final_state_hash ||
      episode.replay_checksum !== receipt.verification.replay_checksum ||
      sha256Hex(canonicalCompactJson(episode.action_stream)) !==
        receipt.verification.action_stream_hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return resultFromReceipt(receipt, { resumed: true });
}

export function collectAndStoreSpec({ spec, store, provenance }) {
  const resumed = loadVerifiedCollectionReceipt({ spec, store });
  if (resumed) {
    return resumed;
  }
  const { episode, action_stream_hash: actionStreamHash } = runCollectionSpec(spec);
  const stored = storeTrainingEpisode({ episode, store, verifyReplay: true });
  const verification = verifyTrainingEpisodeReplay(episode);
  const winner = episode.result.winner;
  const outcome = winner === null
    ? "draw"
    : winner === spec.edger_actor
      ? "win"
      : "loss";
  const receipt = {
    schema_version: EDGER_COLLECTION_RECEIPT_SCHEMA_VERSION,
    spec,
    collector_git_commit: provenance.commit,
    episode: {
      episode_id: stored.episode_id,
      uri: stored.uri,
      checksum: stored.checksum,
      uncompressed_checksum: stored.uncompressed_checksum,
      compressed_bytes: stored.compressed_bytes,
    },
    verification: {
      action_stream_hash: actionStreamHash,
      final_state_hash: verification.final_state_hash,
      replay_checksum: verification.replay_checksum,
      actions: verification.actions,
      events: verification.events,
    },
    outcome,
  };
  writeBytes(receiptUri(store, spec.spec_id), Buffer.from(canonicalJson(receipt)));
  return resultFromReceipt(receipt, { resumed: false });
}
