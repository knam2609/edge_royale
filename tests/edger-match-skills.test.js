import test from "node:test";
import assert from "node:assert/strict";

import { SCENARIO_FIXTURES } from "../scripts/edger-evaluation-core.mjs";
import {
  createMatchSkillTracker,
  recordSkillDecision,
  recordSkillDeployment,
  summarizeMatchSkills,
} from "../scripts/edger-match-skills.mjs";
import { capturesFireballOpportunity } from "../scripts/edger-fireball-opportunity.mjs";
import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";

const fixture = (id) => SCENARIO_FIXTURES.find((f) => f.id === id);

function decide(tracker, id, choose, { legal = true } = {}) {
  const f = fixture(id);
  const engine = f.makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: f.actor });
  const selected = choose({ engine, actor: f.actor, legalActions });
  const before = JSON.stringify(engine.state);
  const category = recordSkillDecision(tracker, { engine, actor: f.actor, legalActions, selected, legal });
  assert.equal(JSON.stringify(engine.state), before, "the tracker must not change engine state");
  return category;
}

const capture = ({ engine, actor, legalActions }) =>
  legalActions.find((action) => capturesFireballOpportunity(engine, actor, action, "lethal"));
const missedFireball = ({ legalActions }) =>
  legalActions.find((action) => action.cardId === "fireball" && action.x === 0.5 && action.y === 0.5);

test("decisions at an opportunity count captures only for legal, correctly aimed Fireballs", () => {
  const tracker = createMatchSkillTracker();
  assert.equal(decide(tracker, "finish_low_tower", capture), "lethal");
  assert.equal(decide(tracker, "finish_low_tower_blue", capture), "lethal");
  assert.equal(decide(tracker, "finish_low_tower", missedFireball), "lethal");
  assert.equal(decide(tracker, "finish_low_tower", () => ({ type: "PASS" })), "lethal");
  assert.equal(decide(tracker, "finish_low_tower", capture, { legal: false }), "lethal");
  assert.equal(decide(tracker, "finish_low_tower", ({ legalActions }) =>
    legalActions.find((action) => action.cardId === "knight")), "lethal");
  assert.deepEqual(tracker.fireball_opportunities.lethal, { decisions: 6, captures: 2, fireball_choices: 4 });
  assert.equal(decide(tracker, "spell_cluster_value", ({ engine, actor, legalActions }) =>
    legalActions.find((action) => capturesFireballOpportunity(engine, actor, action, "cluster"))), "cluster");
  assert.deepEqual(tracker.fireball_opportunities.cluster, { decisions: 1, captures: 1, fireball_choices: 1 });
  // No Fireball in hand: no opportunity, nothing counted.
  assert.equal(decide(tracker, "punish_low_elixir", () => ({ type: "PASS" })), null);
  assert.equal(tracker.fireball_opportunities.lethal.decisions + tracker.fireball_opportunities.cluster.decisions, 7);
});

test("deployments cover the fixed deck and refuse other cards", () => {
  const tracker = createMatchSkillTracker();
  assert.deepEqual(Object.keys(tracker.deployments), DEFAULT_DECK);
  recordSkillDeployment(tracker, "fireball");
  recordSkillDeployment(tracker, "giant");
  recordSkillDeployment(tracker, "giant");
  assert.equal(tracker.deployments.fireball, 1);
  assert.equal(tracker.deployments.giant, 2);
  assert.throws(() => recordSkillDeployment(tracker, "rocket"), /outside the fixed deck/);
});

test("summary pools every group except safety and counts games with opportunities and captures", () => {
  const result = (group, deployments, lethal) => {
    const skill = createMatchSkillTracker();
    Object.assign(skill.deployments, deployments);
    Object.assign(skill.fireball_opportunities.lethal, lethal);
    return { group, skill };
  };
  const results = [
    result("champion", { fireball: 2, knight: 4 }, { decisions: 3, captures: 1, fireball_choices: 2 }),
    result("champion", { knight: 2 }, { decisions: 0, captures: 0, fireball_choices: 0 }),
    result("weak:random", { giant: 1 }, { decisions: 2, captures: 0, fireball_choices: 1 }),
    result("safety", { fireball: 9 }, { decisions: 9, captures: 9, fireball_choices: 9 }),
    result("safety", { fireball: 9 }, { decisions: 9, captures: 9, fireball_choices: 9 }),
  ];
  const summary = summarizeMatchSkills(results);
  assert.equal(summary.blocking, false);
  assert.deepEqual(Object.keys(summary.groups), ["champion", "safety", "weak:random"]);
  const pooled = summary.pooled_excluding_safety;
  assert.equal(pooled.games, 3);
  assert.equal(pooled.deployments.fireball, 2);
  assert.equal(pooled.deployments.knight, 6);
  assert.equal(pooled.deployments_per_game.knight, 2);
  assert.deepEqual(pooled.fireball_opportunities.lethal, {
    decisions: 5, captures: 1, fireball_choices: 3, games_with_opportunity: 2, games_with_capture: 1,
    capture_rate_per_decision: 0.2, capture_rate_per_game: 0.5,
  });
  assert.equal(pooled.fireball_opportunities.cluster.capture_rate_per_decision, null);
  assert.equal(summary.groups.safety.deployments.fireball, 18);
  assert.equal(summarizeMatchSkills([]).pooled_excluding_safety.games, 0);
  assert.throws(() => summarizeMatchSkills([{ group: "champion" }]), /match skill record/);
});
