import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { buildEdgerV2LegalMasks } from "../src/ai/v2/observation.js";
import {
  createEdgerV2BootstrapModel,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import { createRng } from "../src/sim/random.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  EDGER_V2_CADENCES,
  decideEdgerV2WithCadence,
  runEdgerV2CadenceMatch,
} from "../scripts/edger-v2-cadence-core.mjs";
import {
  EDGER_V1_BASELINE_PHASES,
  EDGER_V2_DIAGNOSTIC_CONTROLLERS,
  EDGER_V2_DIAGNOSTIC_PHASES,
  assertLiveV1Baseline,
  createEdgerV2PhaseAccumulator,
  decideEdgerV2Diagnostic,
} from "../scripts/edger-v2-runtime-cost-adapter.js";
import {
  buildStateBank,
  checkBankEquivalence,
  checkFullMatch,
  classifyDiagnosticState,
  runDiagnosticMatch,
  runV1BaselineMatch,
  runV1BaselineReference,
} from "../scripts/edger-v2-runtime-cost-core.mjs";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";

const { LEARNED, FIXED_ONE_TICK } = EDGER_V2_DIAGNOSTIC_CONTROLLERS;
const CONTROLLERS = [LEARNED, FIXED_ONE_TICK];
const ACTORS = ["blue", "red"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_SEED = 1836353410;

// Seeded non-trivial actor, as in the cadence tests. playBias lowers the PASS
// logit so the actor deploys often and full matches exercise plays.
function randomModel(seed = 7, { playBias = 0 } = {}) {
  const model = createEdgerV2BootstrapModel({ modelId: `runtime-cost-test-${seed}` });
  const rng = createRng(seed);
  const fill = (values) => {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (rng() * 2 - 1) * 0.35;
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
  const delayHead = model.weights.delay_head;
  for (let index = 0; index < delayHead.weights.length; index += 1) {
    delayHead.weights[index] *= 6;
  }
  delayHead.bias.forEach((_, bin) => {
    delayHead.bias[bin] = -0.08 * bin;
  });
  model.weights.card_head.bias[0] -= playBias;
  return validateEdgerV2PolicyModel(model);
}

function stepLikeReference(engine, actions) {
  engine.step(actions);
  if (engine.shouldStartOvertime()) {
    engine.setOvertime(true);
  }
}

function toAction(tick, actor, action) {
  return action.type === "PLAY_CARD"
    ? [{ tick, type: "PLAY_CARD", actor, cardId: action.cardId, x: action.x, y: action.y }]
    : [];
}

// Red follows the model every fifth tick and blue every seventh, so states
// hold troops of both sides, spent and refilled elixir, and pending spells.
function* walkStates(model, ticks, seed = 424242) {
  const engine = createProductionEngine({ seed });
  for (let step = 0; step < ticks && !engine.getMatchResult(); step += 1) {
    yield engine;
    const tick = engine.state.tick + 1;
    const actions = [];
    for (const actor of ACTORS.filter((actor) => tick % (actor === "red" ? 5 : 7) === 0)) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      const decision = selectEdgerV2PolicyDecision({ model, engine, actor, legalActions });
      actions.push(...toAction(tick, actor, decision.action));
    }
    stepLikeReference(engine, actions);
  }
}

function decisionKey(decision) {
  return JSON.stringify({ action: decision.action, delayTicks: decision.delayTicks, indices: decision.indices });
}

function expectedPhases(controller) {
  return EDGER_V2_DIAGNOSTIC_PHASES.filter((phase) =>
    !["begin", "enumerate", "schedule"].includes(phase) &&
    (phase !== "delay_head" || controller === LEARNED));
}

test("diagnostic adapter is browser-safe, separate from the live client and uses the cadence names", () => {
  assert.deepEqual({ ...EDGER_V2_DIAGNOSTIC_CONTROLLERS }, { ...EDGER_V2_CADENCES });
  const source = fs.readFileSync(path.join(ROOT, "scripts", "edger-v2-runtime-cost-adapter.js"), "utf8");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.match(specifier, /^\.\.\/src\/(ai|sim)\//, `${specifier} must be a served engine/AI module`);
  }
  assert.doesNotMatch(source, /\brequire\(|\bBuffer\b|\bprocess\./);
  const clientFiles = [
    path.join(ROOT, "index.html"),
    ...fs.readdirSync(path.join(ROOT, "src", "client")).map((file) => path.join(ROOT, "src", "client", file)),
  ];
  for (const file of clientFiles) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /runtime-cost|cadence/, `${file} must not load the diagnostic`);
  }
});

// The v3 observation's extra inputs shift the seeded weight draw, so the
// fixture seeds were re-chosen (11 -> 12, 17 -> 19) to keep the coverage below.
test("adapter matches the frozen reference and production selector for both controllers and actors", () => {
  const model = randomModel(12, { playBias: 1.5 });
  const seen = { compared: 0, plays: 0, passes: 0, delays: new Set(), placements: new Set() };
  for (const engine of walkStates(model, 240)) {
    for (const actor of ACTORS) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      for (const controller of CONTROLLERS) {
        const reference = decideEdgerV2WithCadence({ model, engine, actor, legalActions, cadence: controller });
        const off = decideEdgerV2Diagnostic({ model, engine, actor, legalActions, controller });
        const phases = [];
        const on = decideEdgerV2Diagnostic({
          model, engine, actor, legalActions, controller, phaseHook: (phase) => phases.push(phase),
        });
        assert.equal(decisionKey(off), decisionKey(reference));
        assert.equal(decisionKey(on), decisionKey(off));
        assert.deepEqual(phases, expectedPhases(controller));
        if (controller === LEARNED) {
          const production = selectEdgerV2PolicyDecision({ model, engine, actor, legalActions });
          assert.equal(decisionKey(off), decisionKey(production));
          seen.delays.add(off.delayTicks);
        } else {
          assert.equal(off.delayTicks, 1);
          assert.equal(off.indices.delay_index, 0);
        }
        seen.compared += 1;
        seen.plays += off.action.type === "PLAY_CARD" ? 1 : 0;
        seen.passes += off.action.type === "PASS" ? 1 : 0;
        seen.placements.add(off.indices.placement_index);
      }
    }
  }
  assert.ok(seen.compared >= 900);
  assert.ok(seen.plays > 20 && seen.passes > 20, "fixture must exercise both plays and PASS");
  assert.ok(seen.placements.size > 3, "fixture must exercise several placements");
  assert.ok([...seen.delays].some((delay) => delay > 1), "learned delays must differ from one tick");
});

test("affordable PASS: a PASS-preferring actor passes with cards affordable and still scores placements", () => {
  // Bootstrap card bias is 0 for PASS versus -1 for cards, with zero weights.
  const model = createEdgerV2BootstrapModel();
  const engine = createProductionEngine({ seed: 99 });
  let electivePasses = 0;
  for (let step = 0; step < 200; step += 1) {
    for (const actor of ACTORS) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      if (!classifyDiagnosticState({ engine, actor, legalActions }).includes("elective")) {
        continue;
      }
      for (const controller of CONTROLLERS) {
        const phases = [];
        const decision = decideEdgerV2Diagnostic({
          model, engine, actor, legalActions, controller, phaseHook: (phase) => phases.push(phase),
        });
        const reference = decideEdgerV2WithCadence({ model, engine, actor, legalActions, cadence: controller });
        assert.equal(decision.action.type, "PASS");
        assert.equal(decision.indices.placement_index, 0);
        assert.ok(phases.includes("selected_masks") && phases.includes("placement_head"));
        assert.equal(decisionKey(decision), decisionKey(reference));
        electivePasses += 1;
      }
    }
    stepLikeReference(engine, []);
  }
  assert.ok(electivePasses > 300, "cards must be affordable for this to test anything");
});

test("fixed controller never evaluates the delay head", () => {
  const baseline = randomModel(13, { playBias: 1.5 });
  const poisoned = randomModel(13, { playBias: 1.5 });
  // Validate and cache before poisoning, as the policy caches validated models.
  selectEdgerV2PolicyDecision({ model: poisoned, engine: createProductionEngine({ seed: 1 }), actor: "red", legalActions: [] });
  poisoned.weights.delay_head.weights.fill(Number.NaN);
  poisoned.weights.delay_encoder.weights.fill(Number.NaN);
  let plays = 0;
  for (const engine of walkStates(baseline, 120)) {
    for (const actor of ACTORS) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      const expected = decideEdgerV2Diagnostic({ model: baseline, engine, actor, legalActions, controller: FIXED_ONE_TICK });
      const phases = [];
      const actual = decideEdgerV2Diagnostic({
        model: poisoned, engine, actor, legalActions, controller: FIXED_ONE_TICK,
        phaseHook: (phase) => phases.push(phase),
      });
      assert.equal(decisionKey(actual), decisionKey(expected));
      assert.ok(!phases.includes("delay_head"));
      plays += actual.action.type === "PLAY_CARD" ? 1 : 0;
    }
  }
  assert.ok(plays > 0);
});

test("ties resolve to the lowest legal card and placement, as in the reference and production", () => {
  // Zero weights make every legal card and every legal placement tie.
  const model = createEdgerV2BootstrapModel();
  model.weights.card_head.bias.fill(0);
  model.weights.card_head.bias[0] = -1;
  validateEdgerV2PolicyModel(model);
  const engine = createProductionEngine({ seed: 5 });
  let tiedPlays = 0;
  for (let step = 0; step < 60; step += 1) {
    for (const actor of ACTORS) {
      const legalActions = enumerateLegalCardActions({ engine, actor });
      if (legalActions.length === 0) {
        continue;
      }
      const cardMask = buildEdgerV2LegalMasks({ actor, legalActions }).card;
      const firstCard = cardMask.findIndex((legal, index) => index > 0 && legal);
      const placementMask = buildEdgerV2LegalMasks({ actor, legalActions, selectedCardIndex: firstCard }).placement;
      assert.ok(placementMask.reduce((sum, legal) => sum + legal, 0) > 1);
      for (const controller of CONTROLLERS) {
        const decision = decideEdgerV2Diagnostic({ model, engine, actor, legalActions, controller });
        assert.equal(decision.indices.card_index, firstCard);
        assert.equal(decision.indices.placement_index, placementMask.indexOf(1));
        const reference = decideEdgerV2WithCadence({ model, engine, actor, legalActions, cadence: controller });
        assert.equal(decisionKey(decision), decisionKey(reference));
        if (controller === LEARNED) {
          const production = selectEdgerV2PolicyDecision({ model, engine, actor, legalActions });
          assert.equal(decisionKey(decision), decisionKey(production));
        }
        tiedPlays += 1;
      }
    }
    stepLikeReference(engine, []);
  }
  assert.ok(tiedPlays > 100);
});

test("phase accumulator is bounded and attributes each phase between consecutive boundaries", () => {
  let clock = 0;
  const accumulator = createEdgerV2PhaseAccumulator({ now: () => clock });
  const shape = (snapshot) => Object.entries(snapshot).map(([phase, entry]) => [phase, Object.keys(entry)]);
  const shapeBefore = shape(accumulator.snapshot());
  for (let decision = 0; decision < 50; decision += 1) {
    for (const phase of EDGER_V2_DIAGNOSTIC_PHASES) {
      clock += phase === "placement_head" ? 3 : 1;
      accumulator.hook(phase);
    }
  }
  const snapshot = accumulator.snapshot();
  assert.deepEqual(shape(snapshot), shapeBefore);
  assert.deepEqual(snapshot.placement_head, { count: 50, sum_ms: 150, max_ms: 3 });
  assert.equal(snapshot.decision_total.count, 50);
  // Phases after "begin": nine at 1 ms and placement at 3 ms.
  assert.equal(snapshot.decision_total.max_ms, 12);
  assert.throws(() => accumulator.hook("encode"), /outside a decision/);
});

test("state rules classify forced PASS, elective, spell targets, busy combat, pockets and overtime", () => {
  const rest = (hand) => DEFAULT_DECK.filter((card) => !hand.includes(card));
  const blueHand = ["arrows", "archers", "fireball", "knight"];
  const redHand = ["goblins", "archers", "knight", "giant"];
  const engine = createProductionEngine({
    seed: 3,
    initialCardState: {
      blue: { hand: blueHand, draw_pile: rest(blueHand) },
      red: { hand: redHand, draw_pile: rest(redHand) },
    },
  });
  const classify = (actor) => classifyDiagnosticState({
    engine, actor, legalActions: enumerateLegalCardActions({ engine, actor }),
  });

  assert.deepEqual(classify("blue"), ["elective"]);
  const savedElixir = engine.state.elixir.blue.elixir;
  engine.state.elixir.blue.elixir = 0;
  assert.deepEqual(classify("blue"), ["forced_pass"]);
  engine.state.elixir.blue.elixir = savedElixir;

  const play = (actor, cardId) => {
    const action = enumerateLegalCardActions({ engine, actor }).find((candidate) => candidate.cardId === cardId);
    assert.ok(action, `${actor} must be able to play ${cardId}`);
    return { tick: engine.state.tick + 1, type: "PLAY_CARD", actor, ...action };
  };
  // Troops deploy 20 ticks after the play.
  stepLikeReference(engine, [play("red", "goblins"), play("blue", "archers")]);
  for (let step = 0; step < 20; step += 1) {
    stepLikeReference(engine, []);
  }
  engine.state.elixir.blue.elixir = 10;
  const blue = classify("blue");
  assert.ok(blue.includes("spell_target"), `blue categories ${blue}`);
  assert.ok(blue.includes("busy_combat"), `blue categories ${blue}`);
  assert.ok(!blue.includes("pocket") && !blue.includes("overtime"));

  const redCrown = engine.state.entities.find((entity) =>
    entity.entity_type === "tower" && entity.team === "red" && entity.tower_role !== "king");
  redCrown.hp = 0;
  assert.ok(classify("blue").includes("pocket"));
  assert.ok(!classify("red").includes("pocket"));

  engine.setOvertime(true);
  assert.ok(classify("blue").includes("overtime") && classify("red").includes("overtime"));
});

test("full matches reproduce reference scheduling, counts and hashes with the timing hook off and on", () => {
  const model = randomModel(19, { playBias: 1.5 });
  const conditions = [
    [LEARNED, "blue"],
    [LEARNED, "red"],
    [FIXED_ONE_TICK, "red"],
  ];
  for (const [controller, candidateActor] of conditions) {
    const result = checkFullMatch({ seed: DEV_SEED, candidateActor, model, controller });
    assert.deepEqual(result.mismatches, [], `${controller}/${candidateActor}`);
    for (const run of ["hook_off", "hook_on"]) {
      assert.ok(Object.values(result.runs[run].checks).every(Boolean));
      assert.equal(result.runs[run].action_stream_hash, result.reference.action_stream_hash);
      assert.equal(result.runs[run].schedule_sha256, result.reference.schedule_sha256);
    }
    assert.equal(result.runs.hook_on.checks.hook_coverage, true);
    assert.ok(result.reference.counts.play_attempts > 0, "condition must include plays");
    if (controller === FIXED_ONE_TICK) {
      assert.equal(result.reference.counts.decisions, result.reference.result_tick);
    }
  }
});

test("full-match comparison detects a candidate that schedules differently", () => {
  const reference = runEdgerV2CadenceMatch({
    seed: DEV_SEED, candidateActor: "red", model: randomModel(17, { playBias: 1.5 }),
    cadence: LEARNED, opponentBotId: "edger", recordRows: true,
  });
  const other = runDiagnosticMatch({
    seed: DEV_SEED, candidateActor: "red", model: randomModel(19, { playBias: 1.5 }), controller: LEARNED,
  });
  const expected = reference.rows.map((row) => [row.tick, row.card_index, row.placement_index, row.delay_index]);
  const actual = other.schedule.map((row) => [row.tick, row.card_index, row.placement_index, row.delay_index]);
  assert.notDeepEqual(actual, expected);
  assert.notEqual(other.action_stream_hash, reference.action_stream_hash);
});

test("state bank is deterministic, replay-verified, outcome-free and fails on missing coverage", () => {
  const models = { t: randomModel(23, { playBias: 1.5 }) };
  const options = {
    label: "runtime-cost-test-bank",
    seeds: [DEV_SEED],
    models,
    controllers: [LEARNED],
    requiredCategories: ["forced_pass", "elective"],
    perCategory: 2,
    stride: 25,
  };
  const bank = buildStateBank(options);
  assert.deepEqual(buildStateBank(options), bank);
  assert.ok(bank.states.length >= 2);
  for (const actor of ACTORS) {
    assert.deepEqual(bank.coverage[`${actor}:forced_pass`].selected, 2);
  }
  assert.doesNotMatch(JSON.stringify(bank), /winner|crowns|tower_hp|candidate_point/);

  const result = checkBankEquivalence({ bank, models });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.decisions, bank.states.length * ACTORS.length * CONTROLLERS.length);

  const tampered = structuredClone(bank);
  tampered.states[0].state_hash = "0";
  assert.equal(checkBankEquivalence({ bank: tampered, models }).mismatches[0].check, "state_hash");

  assert.throws(
    () => buildStateBank({ ...options, requiredCategories: ["elective"], perCategory: 100_000 }),
    /coverage missing: blue:elective/,
  );
});

test("live-v1 baseline: the unchanged live path equals the independent reference and hooks only observe", () => {
  assert.deepEqual(assertLiveV1Baseline(), {
    model_id: EDGER_POLICY_MODEL.model_id,
    schema_version: "edger_policy_model_v1",
    delay_ticks: 1,
  });
  assert.throws(() => assertLiveV1Baseline("random"), /not one tick/);
  // Red is the side the live client's bot plays.
  const reference = runV1BaselineReference({ seed: DEV_SEED, candidateActor: "red" });
  const phases = [];
  const kindsSeen = [];
  const driven = runV1BaselineMatch({
    seed: DEV_SEED,
    candidateActor: "red",
    phaseHook: (phase, detail) => {
      phases.push(phase);
      if (phase === "schedule") {
        kindsSeen.push(detail.kind);
      }
    },
  });
  const plain = runV1BaselineMatch({ seed: DEV_SEED, candidateActor: "red" });
  for (const run of [driven, plain]) {
    assert.equal(run.action_stream_hash, reference.action_stream_hash);
    assert.equal(run.final_state_hash, reference.final_state_hash);
    assert.deepEqual(run.result, reference.result);
    assert.equal(run.overtime_start_tick, reference.overtime_start_tick);
    assert.equal(run.opponent_decisions, reference.opponent_decisions);
    assert.deepEqual(run.schedule, reference.schedule.map(({ kind, ...row }) => row));
  }
  // One-tick live v1: both sides decide on every tick, PASS rows have no card.
  assert.equal(driven.counts.decisions, reference.result.tick);
  assert.equal(driven.opponent_decisions, reference.result.tick);
  assert.ok(driven.schedule.every((row) => row.delay_ticks === 1));
  assert.ok(driven.schedule.every((row) => (row.card_id === null) === (row.x === null)));
  assert.equal(driven.counts.illegal_attempts, 0);
  assert.ok(driven.decision_kinds.play > 0 && driven.decision_kinds.forced_pass > 0);
  assert.equal(phases.length, driven.counts.decisions * EDGER_V1_BASELINE_PHASES.length);
  assert.deepEqual(phases.slice(0, 4), [...EDGER_V1_BASELINE_PHASES]);
  assert.deepEqual(kindsSeen, reference.schedule.map((row) => row.kind));
});
