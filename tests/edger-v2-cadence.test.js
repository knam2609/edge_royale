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
} from "../scripts/edger-corpus-core.mjs";
import {
  EDGER_V2_CADENCES,
  decideEdgerV2WithCadence,
  encodeCadenceEpisode,
  maskedLogSoftmax,
  runEdgerV2CadenceMatch,
} from "../scripts/edger-v2-cadence-core.mjs";
import {
  buildCadenceSeedPlan,
  buildReplicationSeedPlans,
  exactSignTest,
  frozenSuiteSeeds,
  pairedContrast,
  pruneEpisodeBodies,
  selectEvaluationSeeds,
  trainingOpponentSchedule,
} from "../scripts/edger-v2-cadence-experiment.mjs";
import { spawnNativePython } from "../scripts/python-runtime.mjs";

const { LEARNED, FIXED_ONE_TICK } = EDGER_V2_CADENCES;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Deterministic non-trivial actor: seeded weights make card, placement and
// delay choices vary across states without relying on ignored artifacts.
function randomModel(seed = 7, scale = 0.35) {
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

test("Python cadence learner semantics", () => {
  const result = spawnNativePython(
    ["-m", "unittest", "tests/test_edger_v2_cadence.py"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
