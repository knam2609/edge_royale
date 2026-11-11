import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import {
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2CardLogits,
  computeEdgerV2DelayLogits,
  computeEdgerV2PlacementLogits,
  createEdgerV2BootstrapModel,
  encodeEdgerV2PolicyState,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  createTrainingEpisode,
  deriveDecisionSequence,
  loadTrainingEpisode,
  readDatasetManifest,
  splitForEpisodeId,
} from "../scripts/edger-corpus-core.mjs";
import {
  EDGER_V2_CADENCES,
  EDGER_V2_POLICY_DIAGNOSTICS_SCHEMA,
  decideEdgerV2WithCadence,
  edgerV2DecisionDiagnostics,
  encodeCadenceEpisode,
  maskedEntropy,
  maskedLogSoftmax,
  maxAbsLegalLogit,
  runEdgerV2CadenceMatch,
} from "../scripts/edger-v2-cadence-core.mjs";
import {
  CADENCE_CONVERSION_COLLECTOR,
  buildCadenceSeedPlan,
  buildReplicationSeedPlans,
  cadenceRowMismatches,
  cadenceTrainingEpisode,
  exactSignTest,
  frozenSuiteSeeds,
  heldoutCaptureRecord,
  pairedContrast,
  policyDiagnosticsReport,
  pruneEpisodeBodies,
  selectEvaluationSeeds,
  summarizePolicyDiagnostics,
  trainIterationArguments,
  trainingOpponentSchedule,
} from "../scripts/edger-v2-cadence-experiment.mjs";
import { spawnNativePython } from "../scripts/python-runtime.mjs";

const { LEARNED, FIXED_ONE_TICK } = EDGER_V2_CADENCES;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Deterministic non-trivial actor: seeded weights make card, placement and
// delay choices vary across states without relying on ignored artifacts.
// The v4 observation's spell globals shift the seeded weight draw, so the
// default seed moved from 7 (only PASS in the first 400 states) to 8.
function randomModel(seed = 8, scale = 0.35) {
  const model = createEdgerV2BootstrapModel({ modelId: `cadence-test-${seed}` });
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
  // A short-delay ramp plus larger state-dependent weights keeps the learned
  // delay varied and small enough that sampled matches make many decisions.
  const delayHead = model.weights.delay_head;
  for (let index = 0; index < delayHead.weights.length; index += 1) {
    delayHead.weights[index] *= 6;
  }
  delayHead.bias.forEach((_, bin) => {
    delayHead.bias[bin] = -0.08 * bin;
  });
  return validateEdgerV2PolicyModel(model);
}

function stepWithBot(engine, actions) {
  engine.step(actions);
  if (engine.shouldStartOvertime()) {
    engine.setOvertime(true);
  }
}

// Walk a match where the model plays red at every tick and blue never acts,
// yielding states that cover opening, elixir build-up and live troops.
function* candidateStates(model, ticks) {
  const engine = createProductionEngine({ seed: 424242 });
  for (let step = 0; step < ticks && !engine.getMatchResult(); step += 1) {
    const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
    yield { engine, legalActions };
    const decision = selectEdgerV2PolicyDecision({ model, engine, actor: "red", legalActions });
    const tick = engine.state.tick + 1;
    const { action } = decision;
    stepWithBot(engine, action.type === "PLAY_CARD"
      ? [{ tick, type: "PLAY_CARD", actor: "red", cardId: action.cardId, x: action.x, y: action.y }]
      : []);
  }
}

test("learned cadence reproduces selectEdgerV2PolicyDecision exactly", () => {
  const model = randomModel();
  let compared = 0;
  let plays = 0;
  for (const { engine, legalActions } of candidateStates(model, 400)) {
    const reference = selectEdgerV2PolicyDecision({ model, engine, actor: "red", legalActions });
    const learned = decideEdgerV2WithCadence({ model, engine, actor: "red", legalActions, cadence: LEARNED });
    assert.deepEqual(learned.action, reference.action);
    assert.equal(learned.delayTicks, reference.delayTicks);
    assert.deepEqual(learned.indices, reference.indices);
    compared += 1;
    plays += reference.action.type === "PLAY_CARD" ? 1 : 0;
  }
  assert.ok(compared >= 400);
  assert.ok(plays > 0, "fixture must exercise card plays, not only PASS");
});

test("fixed cadence keeps card and placement, waits one tick and never uses the delay head", () => {
  const model = randomModel();
  const delays = new Set();
  let plays = 0;
  for (const { engine, legalActions } of candidateStates(model, 300)) {
    const learned = decideEdgerV2WithCadence({ model, engine, actor: "red", legalActions, cadence: LEARNED });
    const fixed = decideEdgerV2WithCadence({ model, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK });
    assert.deepEqual(fixed.action, learned.action);
    assert.equal(fixed.indices.card_index, learned.indices.card_index);
    assert.equal(fixed.indices.placement_index, learned.indices.placement_index);
    assert.equal(fixed.delayTicks, 1);
    assert.equal(fixed.indices.delay_index, 0);
    delays.add(learned.delayTicks);
    plays += fixed.action.type === "PLAY_CARD" ? 1 : 0;
  }
  // The learned delay must differ from one tick, or the comparison is vacuous.
  assert.ok([...delays].some((delay) => delay > 1));
  assert.ok(plays > 0);

  // Poison the delay head after validation: fixed cadence must be unaffected
  // in both deterministic and sampling modes, proving it is never evaluated.
  const poisoned = randomModel();
  const baseline = randomModel();
  validateEdgerV2PolicyModel(poisoned);
  selectEdgerV2PolicyDecision({
    model: poisoned,
    engine: createProductionEngine({ seed: 1 }),
    actor: "red",
    legalActions: [],
  });
  poisoned.weights.delay_head.weights.fill(Number.NaN);
  poisoned.weights.delay_encoder.weights.fill(Number.NaN);
  for (const { engine, legalActions } of candidateStates(baseline, 120)) {
    const expected = decideEdgerV2WithCadence({ model: baseline, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK });
    const actual = decideEdgerV2WithCadence({ model: poisoned, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK });
    assert.deepEqual(actual.action, expected.action);
    const sampled = decideEdgerV2WithCadence({
      model: poisoned, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK,
      sampler: { rng: createRng(engine.state.tick + 1) },
    });
    assert.equal(sampled.logProbabilities.delay, 0);
    assert.ok(Number.isFinite(sampled.logProbabilities.joint));
    assert.equal(
      sampled.logProbabilities.joint,
      sampled.logProbabilities.card + sampled.logProbabilities.placement,
    );
  }
});

test("fixed cadence never forces deployment: PASS stays selectable every tick", () => {
  // The bootstrap actor prefers PASS (card bias 0 versus -1 for cards).
  const model = createEdgerV2BootstrapModel();
  const engine = createProductionEngine({ seed: 99 });
  let ticksWithLegalCards = 0;
  for (let step = 0; step < 240; step += 1) {
    const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
    ticksWithLegalCards += legalActions.length > 0 ? 1 : 0;
    const fixed = decideEdgerV2WithCadence({ model, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK });
    assert.equal(fixed.action.type, "PASS");
    assert.equal(fixed.delayTicks, 1);
    stepWithBot(engine, []);
  }
  assert.ok(ticksWithLegalCards > 100, "cards must be affordable for this to test anything");
});

test("sampled behaviour log-probabilities are the actual per-head sampling probabilities", () => {
  const model = randomModel(11, 0.25);
  let checked = 0;
  for (const { engine, legalActions } of candidateStates(model, 200)) {
    if (engine.state.tick % 7 !== 0) {
      continue;
    }
    const observation = buildEdgerV2Observation({ engine, actor: "red" });
    const encodedState = encodeEdgerV2PolicyState({ model, observation });
    const cardMask = buildEdgerV2LegalMasks({ actor: "red", legalActions }).card;
    const cardLogProbabilities = maskedLogSoftmax(
      computeEdgerV2CardLogits({ model, encodedState, mask: cardMask }),
      cardMask,
    );
    for (const cadence of [LEARNED, FIXED_ONE_TICK]) {
      const decision = decideEdgerV2WithCadence({
        model, engine, actor: "red", legalActions, cadence,
        sampler: { rng: createRng(1000 + engine.state.tick) },
      });
      const { card_index: card, placement_index: placement, delay_index: delay } = decision.indices;
      assert.equal(decision.logProbabilities.card, cardLogProbabilities[card]);
      const masks = buildEdgerV2LegalMasks({ actor: "red", legalActions, selectedCardIndex: card });
      if (card === 0) {
        assert.equal(decision.logProbabilities.placement, 0);
      } else {
        const placementLogProbabilities = maskedLogSoftmax(
          computeEdgerV2PlacementLogits({ model, encodedState, cardIndex: card, mask: masks.placement }),
          masks.placement,
        );
        assert.equal(decision.logProbabilities.placement, placementLogProbabilities[placement]);
      }
      if (cadence === LEARNED) {
        const delayLogProbabilities = maskedLogSoftmax(
          computeEdgerV2DelayLogits({ model, encodedState, cardIndex: card, placementIndex: placement, mask: masks.delay }),
          masks.delay,
        );
        assert.equal(decision.logProbabilities.delay, delayLogProbabilities[delay]);
        assert.equal(decision.delayTicks, delay + 1);
      } else {
        assert.equal(decision.logProbabilities.delay, 0);
        assert.equal(decision.delayTicks, 1);
      }
      assert.equal(
        decision.logProbabilities.joint,
        decision.logProbabilities.card + decision.logProbabilities.placement + decision.logProbabilities.delay,
      );
    }
    checked += 1;
  }
  assert.ok(checked > 10);

  // Empirical card frequencies follow the reported probabilities.
  const engine = createProductionEngine({ seed: 5 });
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const observation = buildEdgerV2Observation({ engine, actor: "red" });
  const cardMask = buildEdgerV2LegalMasks({ actor: "red", legalActions }).card;
  const probabilities = Array.from(maskedLogSoftmax(
    computeEdgerV2CardLogits({ model, encodedState: encodeEdgerV2PolicyState({ model, observation }), mask: cardMask }),
    cardMask,
  ), Math.exp);
  const counts = new Array(probabilities.length).fill(0);
  const rng = createRng(31337);
  const draws = 4000;
  for (let draw = 0; draw < draws; draw += 1) {
    const decision = decideEdgerV2WithCadence({
      model, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK, sampler: { rng }, observation,
    });
    counts[decision.indices.card_index] += 1;
  }
  for (let index = 0; index < probabilities.length; index += 1) {
    const expected = probabilities[index] * draws;
    const tolerance = 5 * Math.sqrt(Math.max(1, expected));
    assert.ok(Math.abs(counts[index] - expected) <= tolerance, `card ${index}: ${counts[index]} vs ${expected}`);
  }
});

function denseBoard(row) {
  const board = new Float32Array(EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS);
  row.board_indices.forEach((index, position) => {
    board[index] = row.board_values[position];
  });
  return board;
}

test("learned-cadence trajectory rows match the canonical deriveDecisionSequence path", () => {
  const model = randomModel(19, 0.3);
  const match = runEdgerV2CadenceMatch({
    seed: 777,
    candidateActor: "blue",
    model,
    cadence: LEARNED,
    opponentBotId: "aggressive",
    mode: "sample",
    recordRows: true,
    returnReplay: true,
  });
  assert.ok(match.rows.length > 10);
  const episode = createTrainingEpisode({
    seed: 777,
    initialCardState: match.replay.initial_card_state,
    actions: match.replay.actions,
    events: match.replay.events,
    result: match.replay.result,
    finalStateHash: match.final_state_hash,
    policies: {
      blue: { policy_id: "cadence-test", behavior_probabilities: "known" },
      red: { policy_id: "aggressive", behavior_probabilities: "unknown" },
    },
    source: { kind: "simulator", collector: "edger_v2_cadence_test" },
    decisions: match.rows.map((row) => ({
      tick: row.tick,
      actor: "blue",
      action: row.action,
      delay_ticks: row.delay_ticks,
      behavior_log_probability: row.behavior_log_probability,
      opponent_stratum: "aggressive",
    })),
  });
  const canonical = deriveDecisionSequence(episode).samples;
  assert.equal(canonical.length, match.rows.length);
  canonical.forEach((sample, index) => {
    const row = match.rows[index];
    assert.equal(row.tick, sample.tick);
    assert.equal(row.delay_ticks, sample.delay_ticks);
    assert.equal(row.card_index, sample.selected.card_index);
    assert.equal(row.placement_index, sample.selected.placement_index);
    assert.equal(row.delay_index, sample.selected.delay_index);
    assert.equal(row.behavior_log_probability, sample.behavior_log_probability);
    assert.ok(Math.abs(row.reward - sample.reward) < 1e-12, `reward row ${index}`);
    assert.ok(Math.abs(row.discounted_return - sample.discounted_return) < 1e-12, `return row ${index}`);
    assert.deepEqual(Array.from(denseBoard(row)), sample.board);
    assert.deepEqual(row.global, sample.global);
    assert.deepEqual(row.card_mask, sample.legal_masks.card);
    assert.deepEqual(
      row.placement_legal,
      sample.legal_masks.placement.flatMap((value, cell) => (value ? [cell] : [])),
    );
    if (index + 1 < match.rows.length) {
      // Discount and reward use the actual interval, which is the chosen delay.
      assert.equal(match.rows[index + 1].tick - row.tick, row.delay_ticks);
      assert.equal(row.interval_ticks, row.delay_ticks);
    }
  });
  assert.equal(match.rows.at(-1).interval_ticks, match.tick + 1 - match.rows.at(-1).tick);
});

test("fixed-cadence trajectories decide every tick with one-tick intervals and delay probability one", () => {
  const model = randomModel(23, 0.3);
  const match = runEdgerV2CadenceMatch({
    seed: 4242,
    candidateActor: "red",
    model,
    cadence: FIXED_ONE_TICK,
    opponentBotId: "aggressive",
    mode: "sample",
    recordRows: true,
  });
  assert.equal(match.rows.length, match.tick, "one decision per simulated tick");
  const gamma = 0.9997;
  match.rows.forEach((row, index) => {
    assert.equal(row.tick, index + 1);
    assert.equal(row.delay_ticks, 1);
    assert.equal(row.delay_index, 0);
    assert.equal(row.interval_ticks, 1);
    assert.equal(row.behavior_delay_log_probability, 0);
    assert.equal(row.behavior_log_probability, row.behavior_card_log_probability + row.behavior_placement_log_probability);
    if (index + 1 < match.rows.length) {
      const next = match.rows[index + 1];
      assert.ok(Math.abs(row.reward - (gamma * next.potential - row.potential)) < 1e-12);
      assert.ok(Math.abs(row.discounted_return - (row.reward + gamma * next.discounted_return)) < 1e-12);
    }
  });
  assert.ok(match.stats.pass_decisions > 0);
  assert.ok(match.stats.successful_deployments > 0);
});

test("compact trajectories round-trip into the Python learner unchanged", () => {
  const model = randomModel(29, 0.3);
  const match = runEdgerV2CadenceMatch({
    seed: 8080,
    candidateActor: "blue",
    model,
    cadence: LEARNED,
    opponentBotId: "aggressive",
    mode: "sample",
    recordRows: true,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-cadence-"));
  try {
    const { header, body } = encodeCadenceEpisode({
      rows: match.rows,
      meta: { episode_id: "roundtrip", cadence: LEARNED, opponent: "aggressive", result: { tick: match.tick } },
    });
    fs.writeFileSync(path.join(directory, "roundtrip.bin"), body);
    fs.writeFileSync(path.join(directory, "roundtrip.json"), JSON.stringify(header));
    const script = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('cadence', ${JSON.stringify(path.join(ROOT, "scripts", "edger-v2-cadence-experiment.py"))})`,
      "m = importlib.util.module_from_spec(spec); sys.modules['cadence'] = m; spec.loader.exec_module(m)",
      `e = m.load_cadence_episode(${JSON.stringify(path.join(directory, "roundtrip.json"))})`,
      "b = m.episode_batch(e, 0, e['rows'], 0)",
      "print(json.dumps({'rows': e['rows'], 'board': b.board.reshape(e['rows'], -1).tolist(),",
      "  'placement': [row.nonzero().flatten().tolist() for row in b.placement_mask],",
      "  'card_mask': b.card_mask.int().tolist(), 'reward': e['reward'].tolist(),",
      "  'behavior': e['behavior_log_probability'].tolist(), 'delay_ticks': e['delay_ticks'].tolist(),",
      "  'global': b.global_features.tolist()}))",
    ].join("\n");
    const result = spawnNativePython(["-c", script], { encoding: "utf8", maxBuffer: 1 << 30 });
    assert.equal(result.status, 0, result.stderr);
    const loaded = JSON.parse(result.stdout);
    assert.equal(loaded.rows, match.rows.length);
    match.rows.forEach((row, index) => {
      assert.deepEqual(loaded.board[index], Array.from(denseBoard(row)));
      assert.deepEqual(loaded.placement[index], row.placement_legal);
      assert.deepEqual(loaded.card_mask[index], row.card_mask);
      assert.deepEqual(loaded.global[index], row.global);
      assert.equal(loaded.reward[index], row.reward);
      assert.equal(loaded.behavior[index], row.behavior_log_probability);
      assert.equal(loaded.delay_ticks[index], row.delay_ticks);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cadence seed sets are disjoint from each other and from the frozen suites", () => {
  const plan = buildCadenceSeedPlan({ development: 40, probe: 4, training: 24 });
  const frozen = frozenSuiteSeeds();
  const all = [...plan.development, ...plan.probe, ...plan.training];
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every((seed) => !frozen.has(seed)));
  assert.deepEqual(buildCadenceSeedPlan({ development: 40, probe: 4, training: 24 }), plan);
  const schedule = trainingOpponentSchedule({ pairs: 2000 });
  const heuristicShare = schedule.filter((opponent) => opponent === "edger_heuristic").length / schedule.length;
  assert.ok(Math.abs(heuristicShare - 0.2) < 0.03);
  assert.deepEqual(new Set(schedule), new Set(["edger", "edger_heuristic"]));
});

test("replication seed plans keep development seeds and draw disjoint training and confirmation seeds", () => {
  const base = buildCadenceSeedPlan({ development: 30, probe: 4, training: 20 });
  const replication = buildReplicationSeedPlans(base, { replicates: ["r1", "r2"], training: 20, confirmation: 25 });
  assert.deepEqual(buildReplicationSeedPlans(base, { replicates: ["r1", "r2"], training: 20, confirmation: 25 }), replication);
  const { r1, r2 } = replication.replicates;
  for (const plan of [r1, r2]) {
    assert.deepEqual(plan.development, base.development);
    assert.deepEqual(plan.probe, base.probe);
    assert.equal(plan.training.length, 20);
    assert.equal(plan.training_opponents.length, 20);
  }
  assert.notDeepEqual(r1.training_opponents, r2.training_opponents);
  const frozen = frozenSuiteSeeds();
  const used = [
    ...base.development, ...base.probe, ...base.training,
    ...r1.training, ...r2.training, ...replication.confirmation,
  ];
  assert.equal(new Set(used).size, used.length);
  assert.ok(used.every((seed) => !frozen.has(seed)));
  assert.throws(
    () => buildReplicationSeedPlans({ ...base, development: [...base.development].reverse() }),
    /does not match its labelled derivation/,
  );
});

test("evaluation seeds come only from the explicitly named set of the matching plan", () => {
  const base = buildCadenceSeedPlan({ development: 30, probe: 4, training: 20 });
  const replication = buildReplicationSeedPlans(base, { replicates: ["r1", "r2"], training: 20, confirmation: 25 });
  const { r1 } = replication.replicates;

  assert.deepEqual(selectEvaluationSeeds(base, { set: "development", pairs: 12 }), base.development.slice(0, 12));
  assert.deepEqual(selectEvaluationSeeds(r1, { set: "development", pairs: 30 }), base.development);
  assert.deepEqual(
    selectEvaluationSeeds(replication, { set: "confirmation", pairs: 25, excludePlans: [base] }),
    replication.confirmation,
  );

  // Wrong file for the set: neither silently replays development seeds.
  assert.throws(() => selectEvaluationSeeds(replication, { set: "development", pairs: 5 }), /come from a edger_v2_cadence_seed_plan_v1 plan/);
  assert.throws(() => selectEvaluationSeeds(r1, { set: "confirmation", pairs: 5 }), /come from a edger_v2_cadence_replication_seed_plan_v1 plan/);
  assert.throws(() => selectEvaluationSeeds(replication, { set: "probe", pairs: 1 }), /seed set must be one of development, confirmation/);
  assert.throws(() => selectEvaluationSeeds(replication, { set: undefined, pairs: 1 }), /seed set must be one of/);

  // Missing sets and insufficient or malformed counts.
  const { confirmation, ...withoutConfirmation } = replication;
  assert.throws(() => selectEvaluationSeeds(withoutConfirmation, { set: "confirmation", pairs: 1 }), /has no confirmation seed set/);
  assert.throws(() => selectEvaluationSeeds({ ...replication, confirmation: [] }, { set: "confirmation", pairs: 1 }), /has no confirmation seed set/);
  assert.throws(() => selectEvaluationSeeds(replication, { set: "confirmation", pairs: 26 }), /requested 26 confirmation pairs but the plan holds 25/);
  for (const pairs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => selectEvaluationSeeds(replication, { set: "confirmation", pairs }), /positive integer/);
  }

  // Separation from every other set in the plan, extra plans and frozen suites.
  const tamper = (seed) => ({ ...replication, confirmation: [...confirmation.slice(0, 24), seed] });
  assert.throws(() => selectEvaluationSeeds(tamper(base.development[3]), { set: "confirmation", pairs: 5 }), /also appears in replicates\.r1\.development/);
  assert.throws(() => selectEvaluationSeeds(tamper(r1.training[0]), { set: "confirmation", pairs: 5 }), /also appears in replicates\.r1\.training/);
  // r0 trained on base training seeds, which only the base plan carries.
  assert.deepEqual(selectEvaluationSeeds(tamper(base.training[0]), { set: "confirmation", pairs: 5 }), confirmation.slice(0, 5));
  assert.throws(
    () => selectEvaluationSeeds(tamper(base.training[0]), { set: "confirmation", pairs: 5, excludePlans: [base] }),
    /also appears in excluded plan 0 training/,
  );
  assert.throws(() => selectEvaluationSeeds(tamper(confirmation[0]), { set: "confirmation", pairs: 5 }), /distinct integer seeds/);
  assert.throws(() => selectEvaluationSeeds(tamper(606), { set: "confirmation", pairs: 5 }), /606 belongs to a frozen evaluation suite/);
  assert.throws(
    () => selectEvaluationSeeds({ ...base, probe: [base.development[0]] }, { set: "development", pairs: 1 }),
    /also appears in probe/,
  );
});

test("evaluate requires a seed set and records the exact seeds it played", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-cadence-evaluate-"));
  try {
    const base = buildCadenceSeedPlan({ development: 3, probe: 1, training: 2 });
    const replication = buildReplicationSeedPlans(base, { replicates: ["r1"], training: 2, confirmation: 2 });
    const files = { base: path.join(directory, "base.json"), replication: path.join(directory, "replication.json") };
    fs.writeFileSync(files.base, JSON.stringify(base));
    fs.writeFileSync(files.replication, JSON.stringify(replication));
    const modelPath = path.join(directory, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(randomModel(11)));
    const out = path.join(directory, "report.json");
    const evaluate = (extra) => spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "edger-v2-cadence-experiment.mjs"), "evaluate",
      "--model", modelPath, "--cadence", LEARNED, "--opponent", "aggressive",
      "--pairs", "1", "--workers", "2", "--out", out, ...extra,
    ], { cwd: ROOT, encoding: "utf8" });

    const missing = evaluate(["--seeds", files.replication]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--seed-set is required/);
    const wrongFile = evaluate(["--seeds", files.replication, "--seed-set", "development"]);
    assert.notEqual(wrongFile.status, 0);
    assert.match(wrongFile.stderr, /development seeds come from a edger_v2_cadence_seed_plan_v1 plan/);
    assert.equal(fs.existsSync(out), false);

    const played = evaluate(["--seeds", files.replication, "--seed-set", "confirmation", "--exclude-seed-plans", files.base]);
    assert.equal(played.status, 0, played.stderr);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(report.seed_selection.set, "confirmation");
    assert.equal(report.seed_selection.plan_schema_version, "edger_v2_cadence_replication_seed_plan_v1");
    assert.deepEqual(report.seed_selection.seeds, [replication.confirmation[0]]);
    assert.equal(report.seed_selection.excluded_seed_plans.length, 1);
    assert.deepEqual(
      report.results.map((result) => [result.seed, result.candidate_actor]),
      [[replication.confirmation[0], "blue"], [replication.confirmation[0], "red"]],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("episode pruning keeps headers and deletes bodies", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-cadence-prune-"));
  try {
    const episodes = path.join(directory, "episodes");
    fs.mkdirSync(episodes);
    fs.writeFileSync(path.join(episodes, "a.json"), "{\"body_sha256\":\"x\"}\n");
    fs.writeFileSync(path.join(episodes, "a.bin"), Buffer.alloc(40));
    fs.writeFileSync(path.join(episodes, "b.json"), "{}\n");
    fs.writeFileSync(path.join(episodes, "b.bin"), Buffer.alloc(2));
    const headers = path.join(directory, "headers");
    assert.deepEqual(pruneEpisodeBodies(episodes, headers), { headers: 2, body_bytes_deleted: 42, headers_dir: headers });
    assert.equal(fs.existsSync(episodes), false);
    assert.deepEqual(fs.readdirSync(headers).sort(), ["a.json", "b.json"]);
    assert.equal(fs.readFileSync(path.join(headers, "a.json"), "utf8"), "{\"body_sha256\":\"x\"}\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("train-arm records pooled held-out Fireball capture against the parent", () => {
  const entry = (rows, argmax, p) => ({ rows, fireball_argmax: argmax, capture_rate: argmax / rows, mean_p_fireball: p });
  const record = heldoutCaptureRecord({
    opportunity_capture: {
      model: { lethal: entry(2, 0, 0.1), cluster: entry(3, 1, 0.2), opportunity: entry(5, 1, 0.16) },
      parent: { lethal: entry(2, 1, 0.3), cluster: entry(3, 1, 0.2), opportunity: entry(5, 2, 0.24) },
      capture_rate_below_parent: true,
      mean_p_fireball_below_parent: true,
    },
  });
  assert.deepEqual(record, {
    rows: 5,
    capture_rate: 0.2,
    mean_p_fireball: 0.16,
    parent_capture_rate: 0.4,
    parent_mean_p_fireball: 0.24,
    capture_rate_below_parent: true,
    mean_p_fireball_below_parent: true,
  });
});

test("train-arm warm starts only its first iteration from an initial checkpoint", () => {
  const options = {
    checkpoint: "warm.pt", parentCheckpoint: "parent.pt", collection: "c.json", cadence: LEARNED,
    arm: "A2-r6", iteration: 0, out: "out.pt", metricsOut: "m.json", learningRate: "0.001",
    lossMode: "full", cardKlCoefficient: "0", cardKlRows: "all", decomposeEvery: "0",
    torchSeed: "20260926", rewardVersion: "edger_potential_reward_v2",
  };
  const cold = trainIterationArguments(options);
  assert.deepEqual(cold, [
    "train-iteration", "--checkpoint", "warm.pt", "--parent", "parent.pt", "--collection", "c.json",
    "--delay-mode", LEARNED, "--arm", "A2-r6", "--iteration", "0", "--out", "out.pt",
    "--metrics-out", "m.json", "--learning-rate", "0.001", "--loss-mode", "full",
    "--card-kl-coefficient", "0", "--card-kl-rows", "all", "--decompose-every", "0",
    "--seed", "20260926", "--reward-version", "edger_potential_reward_v2",
  ]);
  assert.deepEqual(trainIterationArguments({ ...options, warmStart: true }), [...cold, "--start-from-warmup"]);
});

test("paired contrasts compare identical seed pairs", () => {
  const make = (points) => points.map((point, index) => ({ pair_id: `pair-${Math.floor(index / 2)}`, candidate_point: point }));
  const control = make([1, 0, 0.5, 0.5, 0, 0, 1, 1]);
  const same = pairedContrast(control, control, { resamples: 200 });
  assert.equal(same.mean, 0);
  assert.equal(same.sign_test_p, 1);
  const better = pairedContrast(make([1, 1, 1, 1, 1, 0, 1, 1]), control, { resamples: 200 });
  assert.equal(better.mean, (0.5 + 0.5 + 0.5 + 0) / 4);
  assert.equal(better.pairs_better, 3);
  assert.equal(better.pairs_tied, 1);
  assert.equal(exactSignTest(10, 0), 2 / 1024);
  assert.throws(() => pairedContrast(make([1, 1]), control), /identical seed pairs/);
});

// Independent two-pass entropy: probabilities first, then -sum p ln p.
function referenceEntropy(logits, mask) {
  const legal = Array.from(logits).filter((_, index) => mask[index]);
  const maximum = Math.max(...legal);
  const weights = legal.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.reduce((sum, weight) => {
    const p = weight / total;
    return p > 0 ? sum - p * Math.log(p) : sum;
  }, 0);
}

test("policy diagnostics use nats over legal entries only", () => {
  const mask = [1, 0, 1, 1, 1, 0, 0, 0, 0];
  const uniform = [0.5, 900, 0.5, 0.5, 0.5, -900, 0, 0, 0];
  assert.ok(Math.abs(maskedEntropy(uniform, mask) - Math.log(4)) < 1e-12);
  assert.equal(maxAbsLegalLogit(uniform, mask), 0.5);
  const peaked = [-120, 0, 3, 1, 2, 0, 0, 0, 0];
  assert.equal(maxAbsLegalLogit(peaked, mask), 120);
  assert.ok(Math.abs(maskedEntropy(peaked, mask) - referenceEntropy(peaked, mask)) < 1e-12);
  // A single legal entry, or one dominating by far more than float64 range, has entropy 0.
  assert.equal(maskedEntropy([5, 1], [1, 0]), 0);
  assert.equal(maskedEntropy([1000, 0], [1, 1]), 0);
  assert.equal(maxAbsLegalLogit([1, 2], [0, 0]), null);
});

test("decision diagnostics recompute the runtime's own distributions and never change choices", () => {
  const model = randomModel();
  let choices = 0;
  let forced = 0;
  let plays = 0;
  for (const { engine, legalActions } of candidateStates(model, 300)) {
    const reference = selectEdgerV2PolicyDecision({ model, engine, actor: "red", legalActions });
    const learned = decideEdgerV2WithCadence({ model, engine, actor: "red", legalActions, cadence: LEARNED });
    assert.deepEqual(learned.indices, reference.indices);
    const diagnostics = edgerV2DecisionDiagnostics(learned);
    const encodedState = encodeEdgerV2PolicyState({
      model,
      observation: buildEdgerV2Observation({ engine, actor: "red" }),
    });
    const masks = buildEdgerV2LegalMasks({ actor: "red", legalActions, selectedCardIndex: reference.indices.card_index });
    const cardLogits = computeEdgerV2CardLogits({ model, encodedState, mask: masks.card });
    const delayLogits = computeEdgerV2DelayLogits({
      model,
      encodedState,
      cardIndex: reference.indices.card_index,
      placementIndex: reference.indices.placement_index,
      mask: masks.delay,
    });
    const choice = masks.card.slice(1).some(Boolean);
    assert.equal(diagnostics.choice, choice);
    assert.equal(diagnostics.pass, reference.indices.card_index === 0);
    if (choice) {
      choices += 1;
      assert.ok(Math.abs(diagnostics.card_entropy - referenceEntropy(cardLogits, masks.card)) < 1e-12);
      assert.ok(diagnostics.card_entropy <= Math.log(masks.card.filter(Boolean).length) + 1e-12);
    } else {
      forced += 1;
      assert.equal(diagnostics.card_entropy, null);
    }
    assert.ok(Math.abs(diagnostics.delay_entropy - referenceEntropy(delayLogits, masks.delay)) < 1e-12);
    assert.ok(diagnostics.delay_entropy <= Math.log(200) + 1e-12);
    assert.equal(diagnostics.max_abs_legal_logit.card, maxAbsLegalLogit(cardLogits, masks.card));
    assert.equal(diagnostics.max_abs_legal_logit.delay, maxAbsLegalLogit(delayLogits, masks.delay));
    if (reference.indices.card_index === 0) {
      assert.equal(diagnostics.max_abs_legal_logit.placement, null);
    } else {
      plays += 1;
      const placementLogits = computeEdgerV2PlacementLogits({
        model,
        encodedState,
        cardIndex: reference.indices.card_index,
        mask: masks.placement,
      });
      assert.equal(diagnostics.max_abs_legal_logit.placement, maxAbsLegalLogit(placementLogits, masks.placement));
    }
    const fixed = edgerV2DecisionDiagnostics(decideEdgerV2WithCadence({
      model, engine, actor: "red", legalActions, cadence: FIXED_ONE_TICK,
    }));
    assert.equal(fixed.delay_entropy, null);
    assert.equal(fixed.max_abs_legal_logit.delay, null);
    assert.equal(fixed.card_entropy, diagnostics.card_entropy);
  }
  assert.ok(choices > 0 && forced > 0 && plays > 0, "fixture must cover choice, forced PASS and play decisions");
});

test("match statistics count every decision once in the policy diagnostics", () => {
  const model = randomModel(19, 0.3);
  for (const [cadence, mode] of [[LEARNED, "deterministic"], [LEARNED, "sample"], [FIXED_ONE_TICK, "sample"]]) {
    const match = runEdgerV2CadenceMatch({
      seed: 777, candidateActor: "blue", model, cadence, opponentBotId: "aggressive", mode,
    });
    const diagnostics = match.stats.policy_diagnostics;
    assert.equal(diagnostics.decisions, match.stats.decisions);
    assert.equal(diagnostics.pass_decisions, match.stats.pass_decisions);
    assert.equal(diagnostics.minimum_delay_decisions, match.stats.chosen_delay_histogram[1] ?? 0);
    assert.ok(diagnostics.choice_decisions <= diagnostics.decisions);
    assert.ok(diagnostics.pass_choice_decisions <= diagnostics.choice_decisions);
    assert.ok(diagnostics.card_entropy_sum_given_choice >= 0);
    if (cadence === LEARNED) {
      assert.equal(diagnostics.delay_entropy_decisions, diagnostics.decisions);
      assert.ok(diagnostics.max_abs_legal_logit.delay > 0);
    } else {
      assert.equal(diagnostics.delay_entropy_decisions, 0);
      assert.equal(diagnostics.max_abs_legal_logit.delay, null);
      assert.equal(diagnostics.minimum_delay_decisions, diagnostics.decisions);
    }
  }
});

test("pooled policy diagnostics weight every decision once and keep the largest logit", () => {
  const game = (overrides, histogram) => ({
    stats: {
      chosen_delay_histogram: histogram,
      policy_diagnostics: {
        decisions: 0, pass_decisions: 0, choice_decisions: 0, pass_choice_decisions: 0,
        card_entropy_sum_given_choice: 0, delay_entropy_decisions: 0, delay_entropy_sum: 0,
        minimum_delay_decisions: 0, max_abs_legal_logit: { card: null, placement: null, delay: null },
        ...overrides,
      },
    },
  });
  const results = [
    game({
      decisions: 10, pass_decisions: 6, choice_decisions: 4, pass_choice_decisions: 1,
      card_entropy_sum_given_choice: 4, delay_entropy_decisions: 10, delay_entropy_sum: 30,
      minimum_delay_decisions: 2, max_abs_legal_logit: { card: 3, placement: 7, delay: 5 },
    }, { 1: 2, 10: 8 }),
    game({
      decisions: 30, pass_decisions: 30, choice_decisions: 0, pass_choice_decisions: 0,
      delay_entropy_decisions: 30, delay_entropy_sum: 30, minimum_delay_decisions: 30,
      max_abs_legal_logit: { card: 40, placement: null, delay: 2 },
    }, { 1: 30 }),
  ];
  const summary = summarizePolicyDiagnostics(results);
  assert.equal(summary.schema_version, EDGER_V2_POLICY_DIAGNOSTICS_SCHEMA);
  assert.equal(summary.entropy_units, "nats");
  assert.equal(summary.decisions, 40);
  assert.equal(summary.decisions_per_game, 20);
  assert.equal(summary.forced_pass_decisions, 36);
  assert.equal(summary.pass_fraction_of_decisions, 36 / 40);
  assert.equal(summary.pass_fraction_of_choice_decisions, 1 / 4);
  assert.equal(summary.card_entropy_given_choice.mean, 1);
  assert.equal(summary.card_entropy_given_choice.per_game_mean.games, 1, "games without a choice are left out");
  assert.equal(summary.delay_entropy.mean, 60 / 40, "decision-weighted, not the mean of game means");
  assert.deepEqual(summary.delay_entropy.per_game_mean, { games: 2, p05: 1, p50: 1, p95: 1 });
  assert.equal(summary.chosen_delay_ticks_mean, (2 + 80 + 30) / 40);
  assert.equal(summary.minimum_delay_fraction, 32 / 40);
  assert.deepEqual(summary.max_abs_legal_logit, { card: 40, placement: 7, delay: 5, any_head: 40 });
  assert.throws(() => summarizePolicyDiagnostics([{ stats: {} }]), /no policy diagnostics/);
});

test("the diagnostics command pools one model's opponent evaluations and rejects mixtures", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-cadence-diagnostics-"));
  try {
    const base = buildCadenceSeedPlan({ development: 2, probe: 1, training: 2 });
    const plan = path.join(directory, "plan.json");
    fs.writeFileSync(plan, JSON.stringify(base));
    const models = { a: path.join(directory, "a.json"), b: path.join(directory, "b.json") };
    fs.writeFileSync(models.a, JSON.stringify(randomModel(11)));
    fs.writeFileSync(models.b, JSON.stringify(randomModel(12)));
    const script = path.join(ROOT, "scripts", "edger-v2-cadence-experiment.mjs");
    const run = (argv) => spawnSync(process.execPath, [script, ...argv], { cwd: ROOT, encoding: "utf8" });
    const evaluate = (model, opponent, out) => {
      const result = run([
        "evaluate", "--seeds", plan, "--seed-set", "development", "--pairs", "1", "--cadence", LEARNED,
        "--opponent", opponent, "--model", model, "--workers", "2", "--out", out,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return out;
    };
    const aggressive = evaluate(models.a, "aggressive", path.join(directory, "a-aggressive.json"));
    const heuristic = evaluate(models.a, "edger_heuristic", path.join(directory, "a-heuristic.json"));
    const other = evaluate(models.b, "aggressive", path.join(directory, "b-aggressive.json"));
    const out = path.join(directory, "diagnostics.json");
    const pooled = run(["diagnostics", "--evaluations", aggressive, heuristic, "--label", "a", "--out", out]);
    assert.equal(pooled.status, 0, pooled.stderr);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    const reports = [aggressive, heuristic].map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(report.label, "a");
    assert.deepEqual(report.inputs.map((input) => [input.opponent, input.games]), [["aggressive", 2], ["edger_heuristic", 2]]);
    assert.equal(report.pooled.games, 4);
    assert.equal(report.pooled.decisions, reports[0].summary.policy_diagnostics.decisions + reports[1].summary.policy_diagnostics.decisions);
    assert.deepEqual(report.by_opponent.aggressive, reports[0].summary.policy_diagnostics);
    assert.equal(
      report.pooled.max_abs_legal_logit.any_head,
      Math.max(...reports.map((item) => item.summary.policy_diagnostics.max_abs_legal_logit.any_head)),
    );
    assert.equal(report.playstyle.pooled.games, 4);
    assert.deepEqual(report.playstyle.by_opponent.aggressive, reports[0].summary.playstyle_diagnostics);
    assert.equal(
      report.playstyle.pooled.counter_responses.threats,
      reports[0].summary.playstyle_diagnostics.counter_responses.threats +
        reports[1].summary.playstyle_diagnostics.counter_responses.threats,
    );
    const read = (file) => ({ file, sha256: "x", report: JSON.parse(fs.readFileSync(file, "utf8")) });
    assert.throws(() => policyDiagnosticsReport([read(aggressive), read(other)]), /different model or cadence/);
    assert.throws(() => policyDiagnosticsReport([read(aggressive), read(aggressive)]), /repeats opponent/);
    // Evaluations from before the playstyle diagnostics still pool their
    // policy diagnostics; a mixture of older and newer files is refused.
    const older = (file) => {
      const input = read(file);
      for (const result of input.report.results) {
        delete result.stats.playstyle_diagnostics;
      }
      return input;
    };
    const legacy = policyDiagnosticsReport([older(aggressive), older(heuristic)]);
    assert.equal(legacy.playstyle, null);
    assert.deepEqual(legacy.pooled, report.pooled);
    assert.throws(() => policyDiagnosticsReport([read(aggressive), older(heuristic)]), /predate the playstyle diagnostics/);
    const mixed = run(["diagnostics", "--evaluations", aggressive, other, "--out", path.join(directory, "mixed.json")]);
    assert.notEqual(mixed.status, 0);
    assert.equal(fs.existsSync(path.join(directory, "mixed.json")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("converted episodes reproduce every cadence row and name any field that differs", () => {
  const model = randomModel(19, 0.3);
  const item = { seed: 777, candidate_actor: "red", opponent: "aggressive" };
  const match = runEdgerV2CadenceMatch({
    seed: item.seed,
    candidateActor: item.candidate_actor,
    model,
    cadence: LEARNED,
    opponentBotId: item.opponent,
    mode: "sample",
    recordRows: true,
    returnReplay: true,
  });
  const episode = cadenceTrainingEpisode({ item, match, model });
  assert.equal(episode.source.collector, CADENCE_CONVERSION_COLLECTOR);
  assert.deepEqual(
    [episode.policies.red.policy_id, episode.policies.red.behavior_probabilities],
    [model.model_id, "known"],
  );
  assert.deepEqual(
    [episode.policies.blue.policy_id, episode.policies.blue.behavior_probabilities],
    ["aggressive", "unknown"],
  );
  // The labels are fixed, so the episode ID (and with it the split and the
  // production order) depends only on the regenerated game.
  assert.equal(cadenceTrainingEpisode({ item, match, model }).episode_id, episode.episode_id);
  const samples = deriveDecisionSequence(episode).samples;
  assert.equal(samples.length, match.rows.length);
  const context = { actor: "red", opponent: "aggressive" };
  samples.forEach((sample, index) => {
    assert.deepEqual(cadenceRowMismatches(sample, match.rows[index], context), [], `row ${index}`);
  });
  const index = match.rows.findIndex((row) => row.card_index !== 0);
  assert.ok(index >= 0, "fixture must include a card play");
  const [sample, row] = [samples[index], match.rows[index]];
  // Exact equality, no tolerance.
  assert.deepEqual(cadenceRowMismatches(sample, { ...row, reward: row.reward + 1e-13 }, context), ["reward"]);
  assert.deepEqual(
    cadenceRowMismatches(sample, { ...row, global: row.global.map((value, k) => (k === 0 ? value + 1 : value)) }, context),
    ["global"],
  );
  assert.deepEqual(
    cadenceRowMismatches(sample, { ...row, behavior_log_probability: row.behavior_log_probability - 1e-9 }, context),
    ["behavior_log_probability"],
  );
  assert.deepEqual(
    cadenceRowMismatches(sample, { ...row, placement_legal: row.placement_legal.slice(1) }, context),
    ["placement_mask"],
  );
  assert.deepEqual(cadenceRowMismatches(sample, row, { ...context, opponent: "edger" }), ["opponent_stratum"]);
});

test("convert-collection regenerates pruned games into production episodes and fails closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-cadence-convert-"));
  try {
    const plan = path.join(directory, "plan.json");
    fs.writeFileSync(plan, JSON.stringify(buildCadenceSeedPlan({ development: 1, probe: 1, training: 1 })));
    const modelPath = path.join(directory, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(randomModel(11)));
    const script = path.join(ROOT, "scripts", "edger-v2-cadence-experiment.mjs");
    const run = (argv) => spawnSync(process.execPath, [script, ...argv], { cwd: ROOT, encoding: "utf8" });
    const collectionPath = path.join(directory, "collection.json");
    const collected = run([
      "collect", "--seeds", plan, "--iteration", "0", "--pairs-per-iteration", "1", "--model", modelPath,
      "--cadence", LEARNED, "--out-dir", path.join(directory, "episodes"), "--out", collectionPath, "--workers", "2",
    ]);
    assert.equal(collected.status, 0, collected.stderr);
    const headers = path.join(directory, "headers");
    pruneEpisodeBodies(path.join(directory, "episodes"), headers);
    const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));

    const convert = (name, extra = []) => run([
      "convert-collection", "--collection", collectionPath, "--headers", headers,
      "--store", path.join(directory, `store-${name}`), "--manifest-out", path.join(directory, `${name}.json`), ...extra,
    ]);
    const converted = convert("a");
    assert.equal(converted.status, 0, converted.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, "a.json.conversion.json"), "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.model_sha256, collection.model_sha256);
    assert.equal(report.episodes.length, 2);
    assert.equal(report.rows, collection.rows);
    assert.equal(report.row_mismatches, 0);
    const manifest = readDatasetManifest(path.join(directory, "a.json"));
    assert.equal(report.manifest_hash, manifest.manifest_hash);
    assert.deepEqual(
      manifest.shards.map((shard) => shard.episode_id),
      report.episodes.map((episode) => episode.episode_id).sort(),
      "manifest order is episode-ID (hash) order",
    );
    for (const shard of manifest.shards) {
      const episode = loadTrainingEpisode(shard.uri, { verifyReplay: true });
      const entry = report.episodes.find((item) => item.episode_id === episode.episode_id);
      assert.equal(episode.source.collector, CADENCE_CONVERSION_COLLECTOR);
      assert.equal(shard.split, splitForEpisodeId(episode.episode_id));
      assert.equal(entry.split, shard.split);
      assert.equal(deriveDecisionSequence(episode).samples.length, entry.rows);
    }
    // The collection identifies each game apart from its reward fields; the
    // independently regenerated game ends in the recorded final state.
    for (const item of collection.episodes) {
      assert.match(item.action_stream_hash, /^\S+$/);
      const entry = report.episodes.find((episode) => episode.cadence_episode === item.episode_id);
      const shard = manifest.shards.find((candidate) => candidate.episode_id === entry.episode_id);
      assert.equal(loadTrainingEpisode(shard.uri, { verifyReplay: true }).final_state_hash, item.final_state_hash);
    }
    // The same games collected under reward v2: identical games, other rewards.
    const v2Path = path.join(directory, "collection-v2.json");
    const collectedV2 = run([
      "collect", "--seeds", plan, "--iteration", "0", "--pairs-per-iteration", "1", "--model", modelPath,
      "--cadence", LEARNED, "--out-dir", path.join(directory, "episodes-v2"), "--out", v2Path, "--workers", "2",
      "--reward", "edger_potential_reward_v2",
    ]);
    assert.equal(collectedV2.status, 0, collectedV2.stderr);
    const v2Collection = JSON.parse(fs.readFileSync(v2Path, "utf8"));
    assert.equal(v2Collection.reward_version, "edger_potential_reward_v2");
    const gameKeys = ({ episode_id, seed, opponent, rows, tick, candidate_point, action_stream_hash, final_state_hash }) =>
      ({ episode_id, seed, opponent, rows, tick, candidate_point, action_stream_hash, final_state_hash });
    assert.deepEqual(v2Collection.episodes.map(gameKeys), collection.episodes.map(gameKeys));
    const again = convert("b");
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(
      readDatasetManifest(path.join(directory, "b.json")).shards.map((shard) => shard.episode_id),
      manifest.shards.map((shard) => shard.episode_id),
      "conversion is deterministic",
    );
    const overwrite = convert("a");
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /already exists/);

    // A body that differs from its recorded header stops the conversion: no
    // manifest, only a failure report.
    const headerPath = path.join(headers, `${collection.episodes[1].episode_id}.json`);
    const header = JSON.parse(fs.readFileSync(headerPath, "utf8"));
    fs.writeFileSync(headerPath, JSON.stringify({ ...header, body_sha256: "0".repeat(64) }));
    const changedBody = convert("c");
    assert.notEqual(changedBody.status, 0);
    assert.match(changedBody.stderr, /regenerated body differs from the recorded header/);
    assert.equal(fs.existsSync(path.join(directory, "c.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "c.json.conversion.json.failed"), "utf8")).passed, false);
    fs.writeFileSync(headerPath, JSON.stringify(header));

    // So does a collecting model whose bytes differ from the recorded SHA-256.
    fs.writeFileSync(modelPath, JSON.stringify(randomModel(12)));
    const changedModel = convert("d");
    assert.notEqual(changedModel.status, 0);
    assert.match(changedModel.stderr, /differs from the collection's recorded SHA-256/);
    assert.equal(fs.existsSync(path.join(directory, "d.json")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Python cadence learner semantics", () => {
  const result = spawnNativePython(
    ["-m", "unittest", "tests/test_edger_v2_cadence.py"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
