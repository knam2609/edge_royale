// Reported (never gating) in-match skill measures for v2 evaluation, adopted
// by the owner on November 20, 2026 (docs/EDGER_GATE_REVIEW.md): the
// candidate's per-card deployments, and Fireball capture at the real
// opportunities it meets at its own decisions. The tracker only reads engine
// state, so it never changes a decision, an action or a game.
import { DEFAULT_DECK } from "../src/sim/cards.js";
import {
  FIREBALL_OPPORTUNITY_CATEGORIES,
  capturesFireballOpportunity,
  classifyFireballOpportunity,
} from "./edger-fireball-opportunity.mjs";

export const EDGER_MATCH_SKILLS_SCHEMA = "edger_v2_match_skills_v1";

function emptyOpportunities() {
  return Object.fromEntries(FIREBALL_OPPORTUNITY_CATEGORIES.map((category) =>
    [category, { decisions: 0, captures: 0, fireball_choices: 0 }]));
}

export function createMatchSkillTracker() {
  return {
    deployments: Object.fromEntries(DEFAULT_DECK.map((card) => [card, 0])),
    fireball_opportunities: emptyOpportunities(),
  };
}

// One candidate decision, before its action is applied. `legalActions` is the
// set the candidate chose from; a capture must be legal, as in the bank.
export function recordSkillDecision(tracker, { engine, actor, legalActions, selected, legal }) {
  const category = classifyFireballOpportunity(engine, actor, legalActions);
  if (!category) return null;
  const entry = tracker.fireball_opportunities[category];
  entry.decisions += 1;
  if (selected?.type === "PLAY_CARD" && selected.cardId === "fireball") entry.fireball_choices += 1;
  if (legal && capturesFireballOpportunity(engine, actor, selected, category)) entry.captures += 1;
  return category;
}

// One executed candidate deployment.
export function recordSkillDeployment(tracker, cardId) {
  if (!Object.hasOwn(tracker.deployments, cardId)) {
    throw new Error(`deployment of a card outside the fixed deck: ${cardId}`);
  }
  tracker.deployments[cardId] += 1;
}

function summarizeGroup(results) {
  const games = results.length;
  const deployments = Object.fromEntries(DEFAULT_DECK.map((card) => [card, 0]));
  const opportunities = Object.fromEntries(FIREBALL_OPPORTUNITY_CATEGORIES.map((category) => [category, {
    decisions: 0, captures: 0, fireball_choices: 0, games_with_opportunity: 0, games_with_capture: 0,
  }]));
  for (const result of results) {
    for (const card of DEFAULT_DECK) deployments[card] += result.skill.deployments[card];
    for (const category of FIREBALL_OPPORTUNITY_CATEGORIES) {
      const source = result.skill.fireball_opportunities[category];
      const target = opportunities[category];
      target.decisions += source.decisions;
      target.captures += source.captures;
      target.fireball_choices += source.fireball_choices;
      target.games_with_opportunity += Number(source.decisions > 0);
      target.games_with_capture += Number(source.captures > 0);
    }
  }
  for (const entry of Object.values(opportunities)) {
    entry.capture_rate_per_decision = entry.decisions ? entry.captures / entry.decisions : null;
    entry.capture_rate_per_game = entry.games_with_opportunity
      ? entry.games_with_capture / entry.games_with_opportunity
      : null;
  }
  return {
    games,
    deployments,
    deployments_per_game: Object.fromEntries(DEFAULT_DECK.map((card) =>
      [card, games ? deployments[card] / games : null])),
    fireball_opportunities: opportunities,
  };
}

// Per evaluation group, plus every group except safety pooled. Safety plays
// each game twice, so it is reported on its own and never pooled.
export function summarizeMatchSkills(results) {
  const tracked = results.filter((result) => result.skill);
  if (tracked.length !== results.length) {
    throw new Error("every evaluation result must carry its match skill record");
  }
  const groups = {};
  for (const result of tracked) (groups[result.group] ??= []).push(result);
  return {
    schema_version: EDGER_MATCH_SKILLS_SCHEMA,
    blocking: false,
    opportunity_rule: "scripts/edger-fireball-opportunity.mjs at each candidate decision, lethal first",
    groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
      .map(([group, groupResults]) => [group, summarizeGroup(groupResults)])),
    pooled_excluding_safety: summarizeGroup(tracked.filter((result) => result.group !== "safety")),
  };
}
