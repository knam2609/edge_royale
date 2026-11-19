// Ninth comparison tooling (docs/EDGER_TACTICAL_REVIEW.md, "Ninth comparison"):
// forced Fireball capture branches, their impact log, and rollout aim counts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2DelayLogits,
  computeEdgerV2PlacementLogits,
  createEdgerV2BootstrapModel,
  encodeEdgerV2PolicyState,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import { SCENARIO_FIXTURES } from "../scripts/edger-evaluation-core.mjs";
import {
  FIREBALL_CARD_INDEX,
  capturesFireballOpportunity,
  classifyFireballOpportunity,
  fireballOpportunityFromGlobals,
} from "../scripts/edger-fireball-opportunity.mjs";
import {
  EDGER_V2_CADENCES,
  decideForcedFireballCapture,
  forcedFireballImpact,
  runEdgerV2CadenceMatch,
} from "../scripts/edger-v2-cadence-core.mjs";
import {
  fireballAimReport,
  fireballBranchSpecs,
  summarizeFireballBranches,
  trainIterationArguments,
} from "../scripts/edger-v2-cadence-experiment.mjs";
import { runCadenceSpec } from "../scripts/edger-v2-cadence-worker.mjs";

const { LEARNED } = EDGER_V2_CADENCES;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The cadence tests' seeded actor (tests/edger-v2-cadence.test.js). Seed 12
// against aggressive has a cluster opportunity at its second decision.
function randomModel(seed = 8, scale = 0.35) {
  const model = createEdgerV2BootstrapModel({ modelId: `fireball-gap-test-${seed}` });
  const rng = createRng(seed);
  const fill = (values) => {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (rng() * 2 - 1) * scale;
    }
  };
  for (const layer of Object.values(model.weights)) {
    if (Array.isArray(layer)) {
      fill(layer);
    } else {
      fill(layer.weights);
      fill(layer.bias);
    }
  }
  return model;
}

const GAME = { seed: 12, candidateActor: "red", cadence: LEARNED, opponentBotId: "aggressive" };
const fixture = (id) => SCENARIO_FIXTURES.find((f) => f.id === id);

function firstStrictArgmax(logits, mask) {
  let best = -1;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index] && (best < 0 || logits[index] > logits[best])) {
      best = index;
    }
  }
  return best;
}

test("the engine and learner opportunity rules agree on every tactical fixture", () => {
  const seen = new Set();
  for (const f of SCENARIO_FIXTURES) {
    const engine = f.makeEngine();
    const legalActions = enumerateLegalCardActions({ engine, actor: f.actor });
    const engineClass = classifyFireballOpportunity(engine, f.actor, legalActions);
    const { global } = buildEdgerV2Observation({ engine, actor: f.actor });
    const cardMask = buildEdgerV2LegalMasks({ actor: f.actor, legalActions }).card;
    assert.equal(fireballOpportunityFromGlobals(global, cardMask), engineClass, f.id);
    seen.add(engineClass);
  }
  assert.deepEqual([...seen].sort(), ["cluster", "lethal", null].sort());
});

test("Fireball diagnostics are absent by default and never change a game", () => {
  const model = randomModel();
  const plain = runEdgerV2CadenceMatch({ ...GAME, model });
  for (const key of ["fireball_opportunities", "forced_fireball", "fireball_aim"]) {
    assert.equal(Object.hasOwn(plain, key), false, key);
  }
  const logged = runEdgerV2CadenceMatch({ ...GAME, model, fireballOpportunityLog: true });
  assert.equal(logged.action_stream_hash, plain.action_stream_hash);
  assert.equal(logged.final_state_hash, plain.final_state_hash);
  assert.equal(logged.fireball_opportunities.cluster.decision_index, 1);
  assert.equal(logged.fireball_opportunities.cluster.own_captures, false);

  const sampled = { ...GAME, model, mode: "sample", recordRows: true };
  const rows = runEdgerV2CadenceMatch(sampled);
  const aimed = runEdgerV2CadenceMatch({ ...sampled, recordFireballAim: true });
  assert.equal(aimed.action_stream_hash, rows.action_stream_hash);
  assert.equal(aimed.final_state_hash, rows.final_state_hash);
  assert.deepEqual(aimed.rows, rows.rows);
  assert.equal(aimed.fireball_aim.global_class_mismatches, 0);
  const counted = rows.rows.filter((row) => fireballOpportunityFromGlobals(row.global, row.card_mask) === "cluster");
  assert.ok(counted.length > 0, "fixture game must have cluster rows");
  assert.equal(aimed.fireball_aim.classes.cluster.rows, counted.length);
  assert.equal(aimed.fireball_aim.classes.cluster.fireball_rows,
    counted.filter((row) => row.card_index === FIREBALL_CARD_INDEX).length);
});

test("collection bodies and headers stay byte for byte with aim diagnostics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-fireball-aim-"));
  try {
    const modelPath = path.join(directory, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(randomModel()));
    const spec = (outDir, extra = {}) => ({
      spec_id: 0, match_index: 0, pair_id: "pair-0", kind: "collect", seed: 12, candidate_actor: "red",
      model_path: modelPath, cadence: LEARNED, opponent: "aggressive", episode_id: "it0-pair0-red",
      out_dir: outDir, model_sha256: "a".repeat(64), ...extra,
    });
    const plain = runCadenceSpec(spec(path.join(directory, "plain")));
    const aimed = runCadenceSpec(spec(path.join(directory, "aimed"), { fireball_aim: true }));
    for (const name of ["it0-pair0-red.bin", "it0-pair0-red.json"]) {
      assert.ok(fs.readFileSync(path.join(directory, "plain", name)).equals(fs.readFileSync(path.join(directory, "aimed", name))), name);
    }
    assert.equal(Object.hasOwn(plain, "fireball_aim"), false);
    const report = fireballAimReport([aimed], { iteration: 0, modelSha256: "a".repeat(64) });
    assert.equal(report.totals.cluster.rows, aimed.fireball_aim.classes.cluster.rows);
    assert.equal(report.episodes[0].episode_id, "it0-pair0-red");
    assert.throws(() => fireballAimReport([plain], { iteration: 0, modelSha256: "a" }), /no Fireball aim record/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a forced branch replays the game to its decision and casts the head's best capturing Fireball", () => {
  const model = randomModel();
  const own = runEdgerV2CadenceMatch({ ...GAME, model, fireballOpportunityLog: true, returnReplay: true });
  const first = own.fireball_opportunities.cluster;
  const branch = runEdgerV2CadenceMatch({
    ...GAME, model, returnReplay: true, forcedFireball: { decision_index: first.decision_index, category: "cluster" },
  });
  const before = (replay) => replay.actions.filter((action) => action.tick < first.tick);
  assert.deepEqual(before(branch.replay), before(own.replay));
  const cast = branch.replay.events.find((event) => event.type === "card_played" && event.actor === "red" &&
    event.tick === first.tick);
  assert.equal(cast.card_id, "fireball");
  const forced = branch.forced_fireball;
  assert.equal(forced.cast_played, true);
  assert.equal(forced.effect_id, cast.effect_id);
  assert.deepEqual([forced.action.x, forced.action.y], [cast.x, cast.y]);
  const impact = branch.replay.events.find((event) => event.type === "spell_impact" && event.effect_id === cast.effect_id);
  assert.deepEqual(forced.impact.impacted_entity_ids, impact.impacted_entity_ids);
  assert.equal(forced.intended_target_ids.length >= 3, true);
});

test("the forced cell is the placement head's best capturing cell, lowest index on ties", () => {
  const model = randomModel();
  for (const [id, category] of [["finish_low_tower", "lethal"], ["spell_cluster_value", "cluster"]]) {
    const f = fixture(id);
    const engine = f.makeEngine();
    const legalActions = enumerateLegalCardActions({ engine, actor: f.actor, model });
    assert.equal(classifyFireballOpportunity(engine, f.actor, legalActions), category);
    const decision = decideForcedFireballCapture({ model, engine, actor: f.actor, legalActions, category });
    assert.equal(decision.action.cardId, "fireball");
    assert.equal(capturesFireballOpportunity(engine, f.actor, decision.action, category), true, id);
    const capturing = legalActions.filter((action) => capturesFireballOpportunity(engine, f.actor, action, category));
    const mask = buildEdgerV2LegalMasks({ actor: f.actor, legalActions: capturing, selectedCardIndex: FIREBALL_CARD_INDEX }).placement;
    const encodedState = encodeEdgerV2PolicyState({ model, observation: buildEdgerV2Observation({ engine, actor: f.actor }) });
    const logits = computeEdgerV2PlacementLogits({ model, encodedState, cardIndex: FIREBALL_CARD_INDEX, mask });
    const placementIndex = firstStrictArgmax(logits, mask);
    assert.equal(decision.indices.placement_index, placementIndex, id);
    const delayMask = new Uint8Array(200).fill(1);
    const delay = computeEdgerV2DelayLogits({ model, encodedState, cardIndex: FIREBALL_CARD_INDEX, placementIndex, mask: delayMask });
    assert.equal(decision.indices.delay_index, firstStrictArgmax(delay, delayMask), id);
    assert.equal(decision.capturing_cells, capturing.length);
  }
  const engine = fixture("finish_low_tower").makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: "red", model })
    .filter((action) => action.cardId !== "fireball");
  assert.throws(() => decideForcedFireballCapture({ model, engine, actor: "red", legalActions, category: "lethal" }),
    /no legal Fireball captures/);
  assert.throws(() => decideForcedFireballCapture({ model, engine, actor: "red", legalActions, category: "arrows" }),
    /unknown Fireball opportunity category/);
});

test("forced branches fail closed when the game diverges or is not a deterministic learned game", () => {
  const model = randomModel();
  assert.throws(() => runEdgerV2CadenceMatch({ ...GAME, model, forcedFireball: { decision_index: 1, category: "lethal" } }),
    /forced branch diverged/);
  assert.throws(() => runEdgerV2CadenceMatch({ ...GAME, model, mode: "sample", forcedFireball: { decision_index: 1, category: "cluster" } }),
    /deterministic learned-cadence/);
  const unreached = runEdgerV2CadenceMatch({ ...GAME, model, forcedFireball: { decision_index: 1_000_000, category: "cluster" } });
  assert.equal(unreached.forced_fireball, null);
});

test("impact records count intended hits, falls and misses", () => {
  const lethal = { category: "lethal", intended_target_ids: ["blue_crown_left"] };
  const towerFell = forcedFireballImpact({
    forced: lethal,
    event: { tick: 40, impacted_entity_ids: ["blue_crown_left", "blue_knight_3"] },
    entities: [{ id: "blue_crown_left", hp: 0 }],
  });
  assert.equal(towerFell.landed, true);
  assert.deepEqual(towerFell.impact.intended_fallen_ids, ["blue_crown_left"]);
  const towerMissed = forcedFireballImpact({
    forced: lethal, event: { tick: 40, impacted_entity_ids: ["blue_knight_3"] }, entities: [{ id: "blue_crown_left", hp: 90 }],
  });
  assert.equal(towerMissed.landed, false);
  assert.deepEqual(towerMissed.impact.intended_hit_ids, []);
  const cluster = { category: "cluster", intended_target_ids: ["g1", "g2", "g3"] };
  const twoOfThree = forcedFireballImpact({
    forced: cluster, event: { tick: 9, impacted_entity_ids: ["g1", "g3", "k1"] }, entities: [{ id: "g1", hp: 0 }, { id: "g3", hp: 10 }],
  });
  assert.equal(twoOfThree.landed, false);
  assert.deepEqual(twoOfThree.impact.intended_fallen_ids, ["g1"]);
  const three = forcedFireballImpact({ forced: cluster, event: { tick: 9, impacted_entity_ids: ["g3", "g2", "g1"] }, entities: [] });
  assert.equal(three.landed, true);
  assert.deepEqual(three.impact.intended_fallen_ids, ["g1", "g2", "g3"]);
});

test("branch specs replay every recorded game and the summary counts unbranched games as zero", () => {
  const evaluation = {
    opponent: "aggressive", cadence: LEARNED,
    results: [1, 0].map((specId) => ({
      spec_id: specId, pair_id: "pair-0", seed: 5, candidate_actor: specId ? "red" : "blue", opponent: "aggressive",
      action_stream_hash: `a${specId}`, final_state_hash: `f${specId}`, candidate_point: specId,
    })),
  };
  const specs = fireballBranchSpecs({ evaluations: [evaluation, evaluation], modelPath: "/m.json" });
  assert.deepEqual(specs.map((spec) => [spec.spec_id, spec.candidate_actor, spec.expected_action_stream_hash]),
    [[0, "blue", "a0"], [1, "red", "a1"], [2, "blue", "a0"], [3, "red", "a1"]]);
  const branched = (delta, own) => ({ opportunity: true, branched: !own, first: { own_card: "knight", own_captures: own },
    ...(own ? {} : { forced: { delta, cast: { cast_played: true, impact: {}, landed: delta > 0 } } }) });
  const games = [
    { classes: { lethal: branched(1, false), cluster: { opportunity: false } } },
    { classes: { lethal: branched(0, true), cluster: branched(-1, false) } },
    { classes: { lethal: { opportunity: false }, cluster: { opportunity: false } } },
    { classes: { lethal: branched(0.5, false), cluster: { opportunity: false } } },
  ];
  const summary = summarizeFireballBranches(games);
  assert.equal(summary.lethal.games_with_opportunity, 3);
  assert.equal(summary.lethal.own_captures, 1);
  assert.equal(summary.lethal.branched, 2);
  assert.equal(summary.lethal.delta_mean_given_branch, 0.75);
  assert.equal(summary.lethal.delta_mean_full_suite, 1.5 / 4);
  assert.equal(summary.lethal.landed, 2);
  assert.equal(summary.cluster.delta_mean_full_suite, -1 / 4);
});

test("fireball-branch reproduces a model's own evaluation and fails closed on a hash mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-fireball-branch-"));
  try {
    const modelPath = path.join(directory, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(randomModel()));
    const seedsPath = path.join(directory, "seeds.json");
    const evaluationPath = path.join(directory, "aggressive.json");
    fs.writeFileSync(seedsPath, JSON.stringify({ schema_version: "edger_v2_cadence_seed_plan_v1", development: [12], probe: [], training: [] }));
    const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "edger-v2-cadence-experiment.mjs"), ...args],
      { cwd: ROOT, encoding: "utf8" });
    const evaluated = cli("evaluate", "--model", modelPath, "--cadence", LEARNED, "--opponent", "aggressive", "--pairs", "1",
      "--workers", "2", "--seeds", seedsPath, "--seed-set", "development", "--out", evaluationPath);
    assert.equal(evaluated.status, 0, evaluated.stderr);
    const out = path.join(directory, "branch.json");
    const branched = cli("fireball-branch", "--model", modelPath, "--evaluations", evaluationPath, "--workers", "2", "--out", out);
    assert.equal(branched.status, 0, branched.stderr);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(report.identity, { games: 2, reproduced: 2, failures: [] });
    const red = report.games.find((game) => game.candidate_actor === "red");
    assert.equal(red.classes.cluster.branched, true);
    assert.equal(red.classes.cluster.forced.cast.cast_played, true);
    assert.equal(report.classes.cluster.games, 2);

    const tampered = JSON.parse(fs.readFileSync(evaluationPath, "utf8"));
    tampered.results[0].final_state_hash = "0".repeat(64);
    fs.writeFileSync(evaluationPath, JSON.stringify(tampered));
    const refused = cli("fireball-branch", "--model", modelPath, "--evaluations", evaluationPath, "--workers", "2", "--out", out);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /did not reproduce their recorded hashes/);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).classes, null);
    fs.writeFileSync(path.join(directory, "other.json"), JSON.stringify(randomModel(9)));
    const wrongModel = cli("fireball-branch", "--model", path.join(directory, "other.json"), "--evaluations", evaluationPath, "--out", out);
    assert.notEqual(wrongModel.status, 0);
    assert.match(wrongModel.stderr, /not a deterministic learned-cadence bot evaluation of this model/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("only a non-default opportunity weight changes the learner command", () => {
  const options = {
    checkpoint: "c.pt", parentCheckpoint: "p.pt", collection: "c.json", cadence: LEARNED, arm: "B-r6", iteration: 0,
    out: "o.pt", metricsOut: "m.json", learningRate: "0.001", lossMode: "full", cardKlCoefficient: "0",
    cardKlRows: "all", decomposeEvery: "0", torchSeed: "20260926", rewardVersion: "edger_potential_reward_v1",
  };
  const plain = trainIterationArguments(options);
  assert.deepEqual(trainIterationArguments({ ...options, opportunityCardWeight: "1", opportunityCardWeightClasses: "lethal" }), plain);
  assert.deepEqual(trainIterationArguments({ ...options, opportunityCardWeight: "10", opportunityCardWeightClasses: "cluster" }),
    [...plain, "--opportunity-card-weight", "10", "--opportunity-card-weight-classes", "cluster"]);
});
