// Fireball opportunity rules shared by the evaluation-only opportunity bank
// (scripts/edger-opportunity-bank.mjs) and the diagnostic cadence tools
// (forced-capture branches and rollout aim diagnostics). Pure functions of
// engine state; they never read the bank, and computing them never changes a
// decision.
import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { EDGER_V2_CARD_ACTIONS } from "../src/ai/v2/observation.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";

export const FIREBALL_OPPORTUNITY_CATEGORIES = Object.freeze(["lethal", "cluster"]);
// The learner's rule (scripts/edger-v2-training.py fireball_opportunity) reads
// the v4 spell globals: 96-98 Fireball lethal per enemy tower, 102 the most
// enemy troops one Fireball could hit, over 8.
export const FIREBALL_CARD_INDEX = EDGER_V2_CARD_ACTIONS.indexOf("fireball");
const FIREBALL_LETHAL_GLOBALS = Object.freeze([96, 97, 98]);
const FIREBALL_TROOP_HITS_GLOBAL = 102;
const SPELL_TROOP_HITS_DENOMINATOR = 8;
const CLUSTER_MINIMUM_TROOP_HITS = 3;

function fireballTargets(engine, actor, action) {
  return engine.state.entities.filter((entity) => entity.team !== actor && entity.hp > 0 &&
    (entity.x - action.x) ** 2 + (entity.y - action.y) ** 2 <= FIREBALL_CONFIG.radius_tiles ** 2);
}

// The entities that make a cast capture its class: enemy towers within reach
// of Fireball's tower damage (lethal), or enemy troops in the radius (cluster).
export function intendedFireballTargets(engine, actor, action, category) {
  const hits = fireballTargets(engine, actor, action);
  return category === "lethal"
    ? hits.filter((e) => e.entity_type === "tower" && e.hp <= FIREBALL_CONFIG.tower_damage)
    : hits.filter((e) => e.entity_type === "troop");
}

export function capturesFireballOpportunity(engine, actor, action, category) {
  if (action?.type !== "PLAY_CARD" || action.cardId !== "fireball") return false;
  const intended = intendedFireballTargets(engine, actor, action, category);
  return category === "lethal" ? intended.length > 0 : intended.length >= CLUSTER_MINIMUM_TROOP_HITS;
}

export function classifyFireballOpportunity(engine, actor, legalActions = enumerateLegalCardActions({ engine, actor })) {
  const casts = legalActions.filter((a) => a.cardId === "fireball");
  if (casts.some((a) => capturesFireballOpportunity(engine, actor, a, "lethal"))) return "lethal";
  if (casts.some((a) => capturesFireballOpportunity(engine, actor, a, "cluster"))) return "cluster";
  return null;
}

// The same class from one decision's v2 global features and card mask, as the
// learner computes it. Tests and rollout diagnostics compare it with the
// engine rule above.
export function fireballOpportunityFromGlobals(global, cardMask) {
  if (!cardMask[FIREBALL_CARD_INDEX]) return null;
  if (FIREBALL_LETHAL_GLOBALS.some((index) => global[index] > 0.5)) return "lethal";
  const hits = Math.round(global[FIREBALL_TROOP_HITS_GLOBAL] * SPELL_TROOP_HITS_DENOMINATOR);
  return hits >= CLUSTER_MINIMUM_TROOP_HITS ? "cluster" : null;
}
