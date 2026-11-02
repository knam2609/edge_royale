// Evaluation-only real-state Fireball bank. Training commands never import it.
import fs from "node:fs";
import path from "node:path";
import { enumerateLegalCardActions, selectEdgerAction, selectHeuristicAction } from "../src/ai/botRuntime.js";
import { buildEdgerOracleFeatures } from "../src/ai/mlPolicy.js";
import { buildEdgerV2Observation } from "../src/ai/v2/observation.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  EDGER_COMPATIBILITY_COHORT, canonicalCompactJson, loadTrainingEpisode,
  sha256Hex, splitForEpisodeId, validateDatasetManifest, verifyTrainingEpisodeReplay, readCompressedEpisodeBytes,
} from "./edger-corpus-core.mjs";
import { PROMOTION_GATE_CONFIG } from "./edger-evaluation-core.mjs";

// v2 snapshots also carry the spawn/effect counters and the last tick's combat
// events, which the v2 observation reads (globals 84, 85 and 87). v1 banks
// omitted them, so their states did not reproduce v2 inputs; they are rejected.
export const OPPORTUNITY_BANK_SCHEMA = "edger_fireball_opportunity_bank_v2";
const SNAPSHOT_KEYS = Object.freeze([
  "seed", "tick", "isOvertime", "overtime_start_tick", "entities", "card_state", "elixir",
  "pending_effects", "spawn_sequence", "effect_sequence", "recent_combat_events",
]);
const RESTORED_KEYS = SNAPSHOT_KEYS.filter((key) => !["seed", "elixir"].includes(key));
export const OPPORTUNITY_MINIMUMS = Object.freeze({
  lethal: PROMOTION_GATE_CONFIG.scenarioCategoryMinimums.tower_finishing,
  cluster: PROMOTION_GATE_CONFIG.scenarioCategoryMinimums.spell_value,
});

function hash(value) { return sha256Hex(canonicalCompactJson(value)); }

function fireballTargets(engine, actor, action) {
  return engine.state.entities.filter((entity) => entity.team !== actor && entity.hp > 0 &&
    (entity.x - action.x) ** 2 + (entity.y - action.y) ** 2 <= FIREBALL_CONFIG.radius_tiles ** 2);
}

export function capturesFireballOpportunity(engine, actor, action, category) {
  if (action?.type !== "PLAY_CARD" || action.cardId !== "fireball") return false;
  const hits = fireballTargets(engine, actor, action);
  return category === "lethal"
    ? hits.some((e) => e.entity_type === "tower" && e.hp <= FIREBALL_CONFIG.tower_damage)
    : hits.filter((e) => e.entity_type === "troop").length >= 3;
}

export function classifyFireballOpportunity(engine, actor, legalActions = enumerateLegalCardActions({ engine, actor })) {
  const casts = legalActions.filter((a) => a.cardId === "fireball");
  if (casts.some((a) => capturesFireballOpportunity(engine, actor, a, "lethal"))) return "lethal";
  if (casts.some((a) => capturesFireballOpportunity(engine, actor, a, "cluster"))) return "cluster";
  return null;
}

// Only the inference inputs, never observations derived by a learner or a
// teacher action. Restore arena functions and ElixirTracker prototypes from
// the production factory. These snapshots are read-only decision probes.
export function opportunityState(engine) {
  return JSON.parse(JSON.stringify(Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, engine.state[key]]))));
}

export function opportunityEngine(state) {
  const engine = createProductionEngine({ seed: state.seed, initialCardState: state.card_state });
  for (const key of RESTORED_KEYS) {
    engine.state[key] = structuredClone(state[key]);
  }
  for (const actor of ["blue", "red"]) Object.assign(engine.state.elixir[actor], state.elixir[actor]);
  return engine;
}

// Everything a bank decision reads: the legal actions, the v2 observation and
// v1's per-action oracle features. Used to prove a snapshot reproduces the
// live engine before it enters a bank.
function decisionInputs(engine, actor) {
  const legalActions = enumerateLegalCardActions({ engine, actor });
  const { board, global } = buildEdgerV2Observation({ engine, actor });
  return canonicalCompactJson({
    legal_actions: legalActions,
    v2_board: Array.from(board),
    v2_global: Array.from(global),
    v1_features: [{ type: "PASS" }, ...legalActions].map((action) =>
      Array.from(buildEdgerOracleFeatures({ engine, actor, action }))),
  });
}

export function buildOpportunityBank(manifest) {
  validateDatasetManifest(manifest);
  const entries = [];
  const episodes = [];
  // Deliberately never load the train/validation shards, including for counts.
  for (const shard of [...manifest.shards].filter((s) => s.split === "test").sort((a, b) => a.episode_id.localeCompare(b.episode_id))) {
    if (splitForEpisodeId(shard.episode_id) !== "test") throw new Error("opportunity bank requires the stable test split");
    if (sha256Hex(readCompressedEpisodeBytes(shard.uri)) !== shard.checksum) throw new Error("opportunity episode checksum mismatch");
    const episode = loadTrainingEpisode(shard.uri);
    if (episode.episode_id !== shard.episode_id) throw new Error("opportunity episode ID mismatch");
    verifyTrainingEpisodeReplay(episode);
    episodes.push({ episode_id: shard.episode_id, checksum: shard.checksum, replay_checksum: episode.replay_checksum });
    const engine = createProductionEngine({ seed: episode.seed, initialCardState: episode.initial.cards });
    const actions = new Map();
    const decisions = new Map();
    for (const action of episode.action_stream) {
      const list = actions.get(action.tick) ?? []; list.push(action); actions.set(action.tick, list);
    }
    for (const decision of episode.decision_stream) {
      const actors = decisions.get(decision.tick) ?? new Set(); actors.add(decision.actor); decisions.set(decision.tick, actors);
    }
    const seen = new Set();
    while (engine.state.tick < episode.result.tick && !engine.getMatchResult()) {
      const tick = engine.state.tick + 1;
      for (const actor of [...(decisions.get(tick) ?? [])].sort()) {
        const category = classifyFireballOpportunity(engine, actor);
        if (!category || seen.has(`${actor}:${category}`)) continue;
        seen.add(`${actor}:${category}`);
        const state = opportunityState(engine);
        if (decisionInputs(opportunityEngine(state), actor) !== decisionInputs(engine, actor)) {
          throw new Error(`opportunity snapshot does not reproduce decision inputs: ${episode.episode_id} tick ${tick} ${actor}`);
        }
        entries.push({ episode_id: episode.episode_id, tick, actor, category, state, state_sha256: hash(state) });
      }
      engine.step(actions.get(tick) ?? []);
      if (engine.shouldStartOvertime()) engine.setOvertime(true);
    }
  }
  const bank = {
    schema_version: OPPORTUNITY_BANK_SCHEMA,
    compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    source_manifest_hash: manifest.manifest_hash,
    sampling: "first_per_episode_actor_class_v1",
    opportunity_rule: { tower_damage: FIREBALL_CONFIG.tower_damage, radius_tiles: FIREBALL_CONFIG.radius_tiles, cluster_troops: 3, lethal_first: true },
    episodes, entries,
  };
  bank.bank_sha256 = hash(bank);
  return validateOpportunityBank(bank);
}

export function validateOpportunityBank(bank) {
  if (bank?.schema_version !== OPPORTUNITY_BANK_SCHEMA || bank.compatibility_cohort !== EDGER_COMPATIBILITY_COHORT) {
    throw new Error("incompatible opportunity bank schema/cohort");
  }
  const { bank_sha256, ...content } = bank;
  if (bank_sha256 !== hash(content)) throw new Error("opportunity bank checksum mismatch");
  const digest = /^[a-f0-9]{64}$/;
  if (!digest.test(bank.source_manifest_hash) || bank.sampling !== "first_per_episode_actor_class_v1" ||
      canonicalCompactJson(bank.opportunity_rule) !== canonicalCompactJson({ tower_damage: FIREBALL_CONFIG.tower_damage, radius_tiles: FIREBALL_CONFIG.radius_tiles, cluster_troops: 3, lethal_first: true })) {
    throw new Error("invalid opportunity bank provenance/rule");
  }
  const episodes = new Set();
  for (const episode of bank.episodes) {
    if (!digest.test(episode.episode_id) || splitForEpisodeId(episode.episode_id) !== "test" ||
        !digest.test(episode.checksum) || !digest.test(episode.replay_checksum) || episodes.has(episode.episode_id)) {
      throw new Error("opportunity bank requires unique checksummed test episodes");
    }
    episodes.add(episode.episode_id);
  }
  const seen = new Set();
  for (const entry of bank.entries) {
    const key = `${entry.episode_id}:${entry.actor}:${entry.category}`;
    if (!episodes.has(entry.episode_id) || !["red", "blue"].includes(entry.actor) ||
        !Object.hasOwn(OPPORTUNITY_MINIMUMS, entry.category) || seen.has(key) ||
        !Number.isInteger(entry.tick) || entry.tick !== entry.state?.tick + 1 || entry.state_sha256 !== hash(entry.state) ||
        canonicalCompactJson(Object.keys(entry.state).sort()) !== canonicalCompactJson([...SNAPSHOT_KEYS].sort())) {
      throw new Error("invalid/duplicate opportunity entry");
    }
    seen.add(key);
    const engine = opportunityEngine(entry.state);
    for (const actor of ["blue", "red"]) {
      const cards = [...engine.getHand(actor), ...engine.getDeckQueue(actor)];
      if (cards.length !== 8 || DEFAULT_DECK.some((card) => cards.filter((c) => c === card).length !== 1)) throw new Error("opportunity state requires fixed decks");
    }
    if (classifyFireballOpportunity(engine, entry.actor) !== entry.category) throw new Error("opportunity label is not reproducible");
  }
  return bank;
}

export function evaluateOpportunityBank(model, bank, { selector = selectEdgerAction } = {}) {
  validateOpportunityBank(bank);
  const categories = Object.fromEntries(Object.entries(OPPORTUNITY_MINIMUMS).map(([category, minimum]) =>
    [category, { minimum, count: 0, candidate_captures: 0, candidate_card_choices: 0, heuristic_captures: 0 }]));
  const entries = bank.entries.map((entry) => {
    const engine = opportunityEngine(entry.state);
    const legalActions = enumerateLegalCardActions({ engine, actor: entry.actor });
    const args = { engine, actor: entry.actor, legalActions };
    const candidateAction = selector({ ...args, model });
    const heuristicAction = selectHeuristicAction(args);
    const legal = (action) => legalActions.some((a) => a.cardId === action?.cardId && a.x === action.x && a.y === action.y);
    const candidateCapture = legal(candidateAction) && capturesFireballOpportunity(engine, entry.actor, candidateAction, entry.category);
    const heuristicCapture = legal(heuristicAction) && capturesFireballOpportunity(engine, entry.actor, heuristicAction, entry.category);
    const category = categories[entry.category];
    category.count += 1;
    category.candidate_captures += Number(candidateCapture);
    category.candidate_card_choices += Number(candidateAction?.cardId === "fireball");
    category.heuristic_captures += Number(heuristicCapture);
    return { episode_id: entry.episode_id, tick: entry.tick, actor: entry.actor, category: entry.category,
      candidate_action: candidateAction, heuristic_action: heuristicAction, candidate_capture: candidateCapture, heuristic_capture: heuristicCapture };
  });
  for (const category of Object.values(categories)) {
    category.candidate_capture_rate = category.count ? category.candidate_captures / category.count : 0;
    category.heuristic_capture_rate = category.count ? category.heuristic_captures / category.count : 0;
    category.passed = category.count > 0 && category.candidate_capture_rate >= category.minimum;
  }
  return { passed: Object.values(categories).every((c) => c.passed), bank_sha256: bank.bank_sha256,
    source_manifest_hash: bank.source_manifest_hash, episodes: bank.episodes.length, categories, entries };
}

export function evaluateOpportunityBankFile(model, filePath) {
  if (!filePath) return { passed: false, reason: "a frozen test-split --opportunity-bank is required" };
  try {
    const bytes = fs.readFileSync(filePath);
    const report = evaluateOpportunityBank(model, JSON.parse(bytes));
    return { ...report, artifact_checksum: sha256Hex(bytes), bank_path: path.resolve(filePath),
      ...(!report.passed ? { reason: "held-out Fireball capture below minimum or missing class" } : {}) };
  } catch (error) {
    return { passed: false, reason: `invalid opportunity bank: ${error.message}` };
  }
}
