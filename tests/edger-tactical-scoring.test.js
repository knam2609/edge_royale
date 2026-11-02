import test from "node:test";
import assert from "node:assert/strict";
import {
  SCENARIO_FIXTURES, evaluateScenarioFeasibility, scoreDefense, scoreElixirPunishment,
} from "../scripts/edger-evaluation-core.mjs";
import {
  OPPORTUNITY_BANK_SCHEMA, buildOpportunityBank, capturesFireballOpportunity,
  classifyFireballOpportunity, evaluateOpportunityBank, evaluateOpportunityBankFile,
  opportunityEngine, opportunityState, validateOpportunityBank,
} from "../scripts/edger-opportunity-bank.mjs";
import { EDGER_COMPATIBILITY_COHORT, canonicalCompactJson, sha256Hex } from "../scripts/edger-corpus-core.mjs";
import { buildEdgerV2Observation } from "../src/ai/v2/observation.js";
import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createTroop } from "../src/sim/entities.js";

const play = (cardId, x, y) => ({ type: "PLAY_CARD", cardId, x, y });
const fixture = (id) => SCENARIO_FIXTURES.find((f) => f.id === id);
const digest = (value) => sha256Hex(canonicalCompactJson(value));
function seal(bank) {
  delete bank.bank_sha256;
  bank.bank_sha256 = digest(bank);
  return bank;
}

// Synthetic states exercise validation and scoring only; the CLI builder is
// responsible for replay-verifying actual test episodes for a real bank.
function unitBank() {
  const episodeId = "0000005a" + "0".repeat(56); // stable split bucket 90
  return seal({
    schema_version: OPPORTUNITY_BANK_SCHEMA,
    compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    source_manifest_hash: "a".repeat(64),
    sampling: "first_per_episode_actor_class_v1",
    opportunity_rule: { tower_damage: FIREBALL_CONFIG.tower_damage, radius_tiles: FIREBALL_CONFIG.radius_tiles, cluster_troops: 3, lethal_first: true },
    episodes: [{ episode_id: episodeId, checksum: "b".repeat(64), replay_checksum: "c".repeat(64) }],
    entries: ["finish_low_tower", "spell_cluster_value"].map((id) => {
      const state = opportunityState(fixture(id).makeEngine());
      return { episode_id: episodeId, tick: 1, actor: "red", category: id === "finish_low_tower" ? "lethal" : "cluster", state, state_sha256: digest(state) };
    }),
  });
}

test("defense rejects back-center, wrong lane, ahead of threat, and late deployment", () => {
  const engine = fixture("defense_giant_lane").makeEngine();
  assert.equal(scoreDefense(engine, play("mini_pekka", 9.5, 5.5)), 0);
  assert.equal(scoreDefense(engine, play("mini_pekka", 14.5, 14.5)), 0);
  assert.equal(scoreDefense(engine, play("mini_pekka", 3.5, 16.5)), 0);
  assert.equal(scoreDefense(engine, play("giant", 3.5, 14.5)), 0);
  assert.ok(scoreDefense(engine, play("mini_pekka", 3.5, 14.5)) >= 0.7);
  engine.state.entities.find((e) => e.id === "blue_giant").y = 7.5;
  assert.equal(scoreDefense(engine, play("mini_pekka", 3.5, 7.5)), 0);
});

test("punishment requires front pressure and the opponent's elixir shortage", () => {
  const engine = fixture("punish_low_elixir").makeEngine();
  assert.equal(scoreElixirPunishment(engine, play("giant", 9.5, 5.5)), 0);
  assert.equal(scoreElixirPunishment(engine, play("fireball", 3.5, 25.5)), 0);
  assert.ok(scoreElixirPunishment(engine, play("giant", 3.5, 14.5)) >= 0.55);
  engine.state.elixir.blue.elixir = 3;
  assert.equal(scoreElixirPunishment(engine, play("giant", 3.5, 14.5)), 0);
});

test("all five variants per category have blue canonical mirrors and reachable floors", () => {
  assert.equal(SCENARIO_FIXTURES.length, 50);
  assert.equal(evaluateScenarioFeasibility().passed, true);
  for (const red of SCENARIO_FIXTURES.filter((f) => f.actor === "red")) {
    const blue = fixture(`${red.id}_blue`);
    const redEngine = red.makeEngine(), blueEngine = blue.makeEngine();
    const redObservation = buildEdgerV2Observation({ engine: redEngine, actor: "red" });
    const blueObservation = buildEdgerV2Observation({ engine: blueEngine, actor: "blue" });
    assert.deepEqual(blueObservation.board, redObservation.board, red.id);
    assert.deepEqual(blueObservation.global, redObservation.global, red.id);
    for (const action of enumerateLegalCardActions({ engine: redEngine, actor: "red" })) {
      const mirror = { ...action, x: 18 - action.x, y: 32 - action.y };
      assert.equal(blue.score(blueEngine, mirror), red.score(redEngine, action), red.id);
    }
  }
});

test("opportunity snapshots reproduce observation inputs and legal actions", () => {
  for (const f of SCENARIO_FIXTURES) {
    const original = f.makeEngine(), restored = opportunityEngine(opportunityState(original));
    assert.deepEqual(buildEdgerV2Observation({ engine: restored, actor: f.actor }), buildEdgerV2Observation({ engine: original, actor: f.actor }));
    assert.deepEqual(enumerateLegalCardActions({ engine: restored, actor: f.actor }), enumerateLegalCardActions({ engine: original, actor: f.actor }));
  }
});

test("bank scores aim separately from card choice, with the unchanged class floors", () => {
  const bank = unitBank();
  const wrongAim = evaluateOpportunityBank(null, bank, { selector: () => play("fireball", 0.5, 0.5) });
  assert.equal(wrongAim.passed, false);
  assert.equal(wrongAim.categories.lethal.candidate_card_choices, 1);
  assert.equal(wrongAim.categories.lethal.candidate_captures, 0);
  assert.equal(wrongAim.categories.lethal.minimum, 0.8);
  assert.equal(wrongAim.categories.cluster.minimum, 0.7);
  const aimed = evaluateOpportunityBank(null, bank, { selector: ({ engine, actor, legalActions }) => {
    const category = classifyFireballOpportunity(engine, actor, legalActions);
    return legalActions.find((a) => capturesFireballOpportunity(engine, actor, a, category));
  } });
  assert.equal(aimed.passed, true);
  const illegalAim = evaluateOpportunityBank(null, bank, { selector: () => play("fireball", 3.6, 25.5) });
  assert.equal(illegalAim.categories.lethal.candidate_captures, 0);
});

test("bank fails closed on missing classes, checksums, training split, duplicates and false labels", () => {
  const bank = unitBank();
  assert.equal(validateOpportunityBank(bank), bank);
  assert.equal(evaluateOpportunityBankFile(null, null).passed, false);
  assert.equal(evaluateOpportunityBankFile(null, "/missing-opportunity-bank.json").passed, false);
  const empty = seal({ ...bank, entries: [] });
  assert.equal(evaluateOpportunityBank(null, empty).passed, false);
  const damaged = structuredClone(bank); damaged.entries[0].state.tick += 1;
  assert.throws(() => validateOpportunityBank(damaged), /checksum/);
  const train = structuredClone(bank); train.episodes[0].episode_id = "0".repeat(64);
  assert.throws(() => validateOpportunityBank(seal(train)), /test episodes/);
  const duplicate = structuredClone(bank); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => validateOpportunityBank(seal(duplicate)), /duplicate/);
  const falseLabel = structuredClone(bank); falseLabel.entries = [falseLabel.entries[0]]; falseLabel.entries[0].category = "cluster";
  assert.throws(() => validateOpportunityBank(seal(falseLabel)), /label/);
});

test("builder never reads train/validation shards and does not invent missing coverage", () => {
  const manifest = {
    schema_version: "edger_dataset_manifest_v1", compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    shards: [{ episode_id: "0".repeat(64), split: "train", uri: "/must-not-read", checksum: "a".repeat(64) }],
  };
  manifest.manifest_hash = digest(manifest);
  const bank = buildOpportunityBank(manifest);
  assert.equal(bank.episodes.length, 0);
  assert.equal(bank.entries.length, 0);
  assert.equal(evaluateOpportunityBank(null, bank).passed, false);
});

test("opportunity labels use engine center-radius geometry and require affordable Fireball", () => {
  const engine = fixture("spell_cluster_value").makeEngine();
  engine.state.entities = engine.state.entities.filter((e) => e.entity_type === "tower");
  for (let i = 0; i < 3; i += 1) engine.state.entities.push(createTroop({ id: `edge${i}`, cardId: "goblins", team: "blue", x: 0.5 + FIREBALL_CONFIG.radius_tiles + 0.1, y: 0.5 }));
  assert.equal(capturesFireballOpportunity(engine, "red", play("fireball", 0.5, 0.5), "cluster"), false);
  assert.equal(classifyFireballOpportunity(engine, "red"), "cluster");
  engine.state.elixir.red.elixir = 3;
  assert.equal(classifyFireballOpportunity(engine, "red"), null);
});

// Real mid-game states have advanced spawn/effect counters and recent combat
// events, which the v2 observation reads (globals 84, 85, 87). Synthetic
// fixtures leave them at their initial values, so they cannot catch a
// snapshot that drops them.
test("opportunity snapshots reproduce a mid-game production state", async () => {
  const { createProductionEngine } = await import("../src/sim/productionMatch.js");
  const { selectHeuristicAction } = await import("../src/ai/botRuntime.js");
  const { buildEdgerOracleFeatures } = await import("../src/ai/mlPolicy.js");
  const engine = createProductionEngine({ seed: 20261102 });
  while (!(engine.state.recent_combat_events.length > 0 && engine.state.spawn_sequence > 4 && engine.state.effect_sequence > 1)) {
    assert.ok(engine.state.tick < 3000 && !engine.getMatchResult(), "fixture match must reach combat, spawns and an effect");
    const tick = engine.state.tick + 1;
    const actions = [];
    if (tick % 20 === 0) {
      for (const actor of ["blue", "red"]) {
        const legalActions = enumerateLegalCardActions({ engine, actor });
        const action = selectHeuristicAction({ engine, actor, legalActions });
        if (action?.type === "PLAY_CARD") actions.push({ ...action, actor, tick });
      }
    }
    engine.step(actions);
  }
  const state = opportunityState(engine);
  for (const key of ["spawn_sequence", "effect_sequence", "recent_combat_events"]) {
    assert.deepEqual(state[key], JSON.parse(JSON.stringify(engine.state[key])), key);
  }
  const restored = opportunityEngine(state);
  for (const actor of ["blue", "red"]) {
    assert.deepEqual(buildEdgerV2Observation({ engine: restored, actor }), buildEdgerV2Observation({ engine, actor }), actor);
    const legalActions = enumerateLegalCardActions({ engine, actor });
    assert.deepEqual(enumerateLegalCardActions({ engine: restored, actor }), legalActions, actor);
    for (const action of [{ type: "PASS" }, ...legalActions]) {
      assert.deepEqual(buildEdgerOracleFeatures({ engine: restored, actor, action }), buildEdgerOracleFeatures({ engine, actor, action }));
    }
  }
});

test("bank entries must carry every snapshot field", () => {
  const bank = unitBank();
  const stale = structuredClone(bank);
  delete stale.entries[0].state.spawn_sequence;
  stale.entries[0].state_sha256 = digest(stale.entries[0].state);
  assert.throws(() => validateOpportunityBank(seal(stale)), /invalid\/duplicate/);
  const oldSchema = seal({ ...structuredClone(bank), schema_version: "edger_fireball_opportunity_bank_v1" });
  assert.throws(() => validateOpportunityBank(oldSchema), /schema/);
});
