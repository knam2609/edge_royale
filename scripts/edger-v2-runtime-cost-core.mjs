// Node-side validation for the Edger v2 runtime-cost harness.
//
// Builds a reproducible development state bank with fixed state-only category
// rules and checks the browser-safe adapter against the frozen cadence
// reference (scripts/edger-v2-cadence-core.mjs) and the production learned
// selector, on bank states and over full matches. Nothing here measures cost;
// it only establishes that the adapter decides and schedules exactly like the
// code it stands in for.

import { createHash } from "node:crypto";

import {
  EDGER_BOT_ID,
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../src/ai/botRuntime.js";
import { buildEdgerV2LegalMasks, buildEdgerV2Observation } from "../src/ai/v2/observation.js";
import {
  computeEdgerV2PlacementLogits,
  encodeEdgerV2PolicyState,
  selectEdgerV2PolicyDecision,
} from "../src/ai/v2/policy.js";
import { getCard } from "../src/sim/cards.js";
import { getTroopDeployRegions } from "../src/sim/placement.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { createRng } from "../src/sim/random.js";
import {
  EDGER_V2_CADENCE_MAX_TICKS,
  actionStreamHash,
  decideEdgerV2WithCadence,
  runEdgerV2CadenceMatch,
} from "./edger-v2-cadence-core.mjs";
import {
  EDGER_V1_BASELINE_CANDIDATE_SALT,
  EDGER_V1_BASELINE_PHASES,
  EDGER_V2_DIAGNOSTIC_CONTROLLERS,
  EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES,
  EDGER_V2_DIAGNOSTIC_OPPONENT_SALT,
  EDGER_V2_DIAGNOSTIC_PHASES,
  assertLiveV1Baseline,
  createEdgerV1BaselineDriver,
  createEdgerV2DiagnosticDriver,
  createEdgerV2PhaseAccumulator,
  decideEdgerV2Diagnostic,
} from "./edger-v2-runtime-cost-adapter.js";

export const EDGER_V2_STATE_BANK_SCHEMA = "edger_v2_runtime_cost_state_bank_v1";
export const EDGER_V2_STATE_RULES_VERSION = "edger_v2_runtime_cost_state_rules_v1";
export const EDGER_V2_NODE_EQUIVALENCE_SCHEMA = "edger_v2_runtime_cost_node_equivalence_v1";
export const EDGER_V2_CONTROLLER_LIST = Object.freeze([
  EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED,
  EDGER_V2_DIAGNOSTIC_CONTROLLERS.FIXED_ONE_TICK,
]);
export const EDGER_V2_ACTORS = Object.freeze(["blue", "red"]);

// Checkpoints of the September 29 confirmation; the cost plan uses them unchanged.
export const EDGER_V2_RUNTIME_COST_MODEL_PINS = Object.freeze({
  r0: "dfc76358ad46b3f8be411dd6ac876927f2fcb571c835ce9a14d4c97d05956d1b",
  r1: "07accf4073e142d951f3a6f2545854f945695978fc52d7dbc31afd38302432e9",
  r2: "2852f7c41974a472591b49871c962b3fb4978a1ef7903ffd1c7d2479082248fb",
});

// Fixed state-only rules, evaluated for one actor on the state before a tick is
// stepped. They read the board, elixir/hand-derived legal actions and the
// overtime flag only: never match outcomes, scores or any model's choice.
export const EDGER_V2_STATE_RULES = Object.freeze({
  forced_pass: "no legal PLAY_CARD action (PASS is the only card choice)",
  elective: "at least one legal PLAY_CARD action (PASS is elective)",
  spell_target: "a legal spell action and at least 2 living enemy troops",
  busy_combat: "at least 6 living troops in total and at least 2 per team",
  pocket: "a legal troop action inside an unlocked pocket region",
  overtime: "overtime is active",
});
export const EDGER_V2_STATE_CATEGORIES = Object.freeze(Object.keys(EDGER_V2_STATE_RULES));
const MASK_PHASES = EDGER_V2_DIAGNOSTIC_PHASES.filter((phase) =>
  !["begin", "enumerate", "schedule"].includes(phase));

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function livingTroops(state) {
  return state.entities.filter((entity) => entity.entity_type === "troop" && entity.hp > 0);
}

function insideRegion(region, action) {
  return action.x >= region.minX - 1e-9 && action.x <= region.maxX + 1e-9 &&
    action.y >= region.minY - 1e-9 && action.y <= region.maxY + 1e-9;
}

export function classifyDiagnosticState({ engine, actor, legalActions }) {
  const state = engine.state;
  const categories = [];
  const plays = legalActions.filter((action) => action.type === "PLAY_CARD");
  categories.push(plays.length === 0 ? "forced_pass" : "elective");

  const troops = livingTroops(state);
  const enemyTroops = troops.filter((entity) => entity.team !== actor).length;
  const ownTroops = troops.length - enemyTroops;
  if (enemyTroops >= 2 && plays.some((action) => getCard(action.cardId)?.type === "spell")) {
    categories.push("spell_target");
  }
  if (troops.length >= 6 && enemyTroops >= 2 && ownTroops >= 2) {
    categories.push("busy_combat");
  }
  const pockets = getTroopDeployRegions({ arena: state.arena, entities: state.entities, actor })
    .filter((region) => region.kind === "pocket");
  if (pockets.length > 0 && plays.some((action) =>
    getCard(action.cardId)?.type === "troop" &&
    pockets.some((region) => insideRegion(region, action)))) {
    categories.push("pocket");
  }
  if (state.isOvertime) {
    categories.push("overtime");
  }
  return categories;
}

function stepLikeReference(engine, actions) {
  engine.step(actions);
  if (engine.shouldStartOvertime()) {
    engine.setOvertime(true);
  }
}

function groupByTick(actions) {
  const byTick = new Map();
  for (const action of actions) {
    const list = byTick.get(action.tick) ?? [];
    list.push(action);
    byTick.set(action.tick, list);
  }
  return byTick;
}

// Rebuild the state a decision at `tick` sees (engine.state.tick === tick - 1)
// by replaying a source's applied actions with the reference's tick loop.
export function rebuildEngineAt({ seed, actions, tick }) {
  const engine = createProductionEngine({ seed });
  const byTick = groupByTick(actions);
  while (engine.state.tick < tick - 1) {
    if (engine.getMatchResult()) {
      throw new Error(`source seed ${seed} ended before tick ${tick}`);
    }
    stepLikeReference(engine, byTick.get(engine.state.tick + 1) ?? []);
  }
  return engine;
}

// Run the adapter driver with the reference's tick loop and termination.
export function runDiagnosticMatch({
  seed,
  candidateActor,
  model,
  controller,
  opponentBotId = "edger",
  phaseHook = null,
  opponentHook = null,
  maxTicks = EDGER_V2_CADENCE_MAX_TICKS,
}) {
  const driver = createEdgerV2DiagnosticDriver({
    seed, candidateActor, model, controller, opponentBotId, phaseHook, opponentHook,
  });
  return runDriverMatch({ seed, driver, maxTicks });
}

// Run the live-v1 baseline driver with the same tick loop and termination.
export function runV1BaselineMatch({
  seed,
  candidateActor,
  phaseHook = null,
  opponentHook = null,
  maxTicks = EDGER_V2_CADENCE_MAX_TICKS,
}) {
  const driver = createEdgerV1BaselineDriver({ seed, candidateActor, phaseHook, opponentHook });
  return runDriverMatch({ seed, driver, maxTicks });
}

function runDriverMatch({ seed, driver, maxTicks }) {
  const engine = createProductionEngine({ seed });
  const stream = [];
  let overtimeStartTick = null;
  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    const actions = driver.actionsForTick(engine, tick);
    stream.push(...actions);
    stepLikeReference(engine, actions);
    if (overtimeStartTick === null && engine.state.isOvertime) {
      overtimeStartTick = engine.state.tick;
    }
  }
  const result = engine.getMatchResult();
  if (!result) {
    throw new Error(`diagnostic match seed ${seed} did not finish within ${maxTicks} ticks`);
  }
  return {
    result,
    overtime_start_tick: overtimeStartTick,
    action_stream_hash: actionStreamHash(stream),
    final_state_hash: engine.getStateHash(),
    schedule: driver.schedule,
    counts: driver.counts,
    decision_kinds: driver.decisionKinds,
    opponent_decisions: driver.opponentDecisionTicks.length,
  };
}

function referenceSchedule(rows) {
  return rows.map((row) => ({
    tick: row.tick,
    card_index: row.card_index,
    placement_index: row.placement_index,
    delay_index: row.delay_index,
    delay_ticks: row.delay_ticks,
  }));
}

function firstScheduleDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      return { index, expected: expected[index] ?? null, actual: actual[index] ?? null };
    }
  }
  return null;
}

// Full-match equivalence for one condition: decision schedule, counts, stream
// and final-state hashes and the result must equal the frozen reference, with
// the timing hook disabled and enabled.
export function checkFullMatch({ seed, candidateActor, model, controller, opponentBotId = "edger" }) {
  const reference = runEdgerV2CadenceMatch({
    seed,
    candidateActor,
    model,
    cadence: controller,
    opponentBotId,
    recordRows: true,
  });
  const expectedSchedule = referenceSchedule(reference.rows);
  const expectedCounts = {
    decisions: reference.stats.decisions,
    pass_decisions: reference.stats.pass_decisions,
    play_attempts: reference.stats.play_attempts,
    illegal_attempts: reference.stats.illegal_attempts,
  };
  const runs = {};
  const mismatches = [];
  for (const [label, makeHook] of [
    ["hook_off", () => null],
    ["hook_on", () => createEdgerV2PhaseAccumulator()],
  ]) {
    const accumulator = makeHook();
    const diagnostic = runDiagnosticMatch({
      seed, candidateActor, model, controller, opponentBotId, phaseHook: accumulator?.hook ?? null,
    });
    const checks = {
      action_stream_hash: diagnostic.action_stream_hash === reference.action_stream_hash,
      final_state_hash: diagnostic.final_state_hash === reference.final_state_hash,
      schedule: firstScheduleDifference(expectedSchedule, diagnostic.schedule) === null,
      counts: JSON.stringify(diagnostic.counts) === JSON.stringify(expectedCounts),
      result:
        diagnostic.result.winner === reference.winner &&
        diagnostic.result.reason === reference.reason &&
        diagnostic.result.tick === reference.tick,
    };
    if (accumulator) {
      const phases = accumulator.snapshot();
      checks.hook_coverage =
        phases.decision_total.count === diagnostic.counts.decisions &&
        phases.delay_head.count ===
          (controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED ? diagnostic.counts.decisions : 0);
    }
    for (const [check, passed] of Object.entries(checks)) {
      if (!passed) {
        mismatches.push({
          run: label,
          check,
          detail: check === "schedule" ? firstScheduleDifference(expectedSchedule, diagnostic.schedule) : null,
        });
      }
    }
    runs[label] = {
      action_stream_hash: diagnostic.action_stream_hash,
      final_state_hash: diagnostic.final_state_hash,
      schedule_sha256: sha256Hex(JSON.stringify(diagnostic.schedule)),
      counts: diagnostic.counts,
      opponent_decisions: diagnostic.opponent_decisions,
      overtime_start_tick: diagnostic.overtime_start_tick,
      checks,
    };
  }
  return {
    seed,
    candidate_actor: candidateActor,
    controller,
    opponent: opponentBotId,
    reference: {
      action_stream_hash: reference.action_stream_hash,
      final_state_hash: reference.final_state_hash,
      schedule_sha256: sha256Hex(JSON.stringify(expectedSchedule)),
      counts: expectedCounts,
      result_tick: reference.tick,
    },
    overtime_reached: runs.hook_off.overtime_start_tick !== null,
    runs,
    mismatches,
  };
}

// Deterministic, model-independent order for candidate states.
function selectionKey(label, category, actor, sourceId, tick) {
  return sha256Hex(`${label}|${category}|${actor}|${sourceId}|${tick}`);
}

// Classify every stride-th pre-step state of one source match, verifying that
// replaying its applied actions reproduces the reference final state.
export function classifySourceStates({ source, stride }) {
  const engine = createProductionEngine({ seed: source.seed });
  const byTick = groupByTick(source.actions);
  const candidates = [];
  while (!engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    if (tick % stride === 0) {
      const categories = {};
      for (const actor of EDGER_V2_ACTORS) {
        const legalActions = enumerateLegalCardActions({ engine, actor });
        categories[actor] = classifyDiagnosticState({ engine, actor, legalActions });
      }
      candidates.push({ tick, state_hash: engine.getStateHash(), categories });
    }
    stepLikeReference(engine, byTick.get(tick) ?? []);
  }
  if (engine.getStateHash() !== source.final_state_hash) {
    throw new Error(`replay of source ${source.id} does not reproduce its final state`);
  }
  return candidates;
}

// Build the bank from reference matches of every model/controller/actor against
// the opponent on the given development seeds. Construction fails if any
// category lacks perCategory states for either actor.
export function buildStateBank({
  label,
  seeds,
  models,
  opponentBotId = "edger",
  stride = 10,
  perCategory = 5,
  controllers = EDGER_V2_CONTROLLER_LIST,
  requiredCategories = EDGER_V2_STATE_CATEGORIES,
  provenance = {},
}) {
  const sources = [];
  for (const seed of seeds) {
    for (const [run, model] of Object.entries(models)) {
      for (const controller of controllers) {
        for (const candidateActor of EDGER_V2_ACTORS) {
          const match = runEdgerV2CadenceMatch({
            seed, candidateActor, model, cadence: controller, opponentBotId, returnReplay: true,
          });
          sources.push({
            id: `${seed}-${run}-${controller}-${candidateActor}`,
            seed,
            model_run: run,
            controller,
            candidate_actor: candidateActor,
            final_tick: match.tick,
            action_stream_hash: match.action_stream_hash,
            final_state_hash: match.final_state_hash,
            actions: match.replay.actions,
          });
        }
      }
    }
  }

  const pool = [];
  for (const source of sources) {
    for (const candidate of classifySourceStates({ source, stride })) {
      pool.push({ source_id: source.id, ...candidate });
    }
  }

  const selected = new Map();
  const coverage = {};
  const missing = [];
  for (const actor of EDGER_V2_ACTORS) {
    for (const category of requiredCategories) {
      const eligible = pool
        .filter((entry) => entry.categories[actor].includes(category))
        .map((entry) => ({ entry, key: selectionKey(label, category, actor, entry.source_id, entry.tick) }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const chosen = eligible.slice(0, perCategory);
      coverage[`${actor}:${category}`] = { eligible: eligible.length, selected: chosen.length };
      if (chosen.length < perCategory) {
        missing.push(`${actor}:${category} has ${chosen.length}/${perCategory}`);
      }
      for (const { entry } of chosen) {
        const id = `${entry.source_id}@${entry.tick}`;
        const state = selected.get(id) ?? {
          id,
          source_id: entry.source_id,
          tick: entry.tick,
          state_hash: entry.state_hash,
          categories: entry.categories,
          selected_for: [],
        };
        state.selected_for.push(`${actor}:${category}`);
        selected.set(id, state);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`state bank coverage missing: ${missing.join("; ")}`);
  }

  const states = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  const usedSources = new Set(states.map((state) => state.source_id));
  return {
    schema_version: EDGER_V2_STATE_BANK_SCHEMA,
    label,
    rules_version: EDGER_V2_STATE_RULES_VERSION,
    rules: EDGER_V2_STATE_RULES,
    stride,
    per_category: perCategory,
    controllers,
    required_categories: requiredCategories,
    opponent: opponentBotId,
    seeds,
    ...provenance,
    pool_states: pool.length,
    coverage,
    // Only sources that supply a selected state are needed to rebuild it.
    sources: sources.filter((source) => usedSources.has(source.id)),
    source_summaries: sources.map(({ actions, ...summary }) => ({ ...summary, actions: actions.length })),
    states,
  };
}

function decisionKey(decision) {
  return JSON.stringify({
    action: decision.action,
    delayTicks: decision.delayTicks,
    indices: decision.indices,
  });
}

function expectedPhases(controller) {
  return MASK_PHASES.filter((phase) =>
    phase !== "delay_head" || controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED);
}

// Number of legal placements sharing the selected placement's logit, so the
// report shows that stable tie-breaking was actually exercised.
function placementTieCount({ model, engine, actor, legalActions, indices }) {
  const encodedState = encodeEdgerV2PolicyState({
    model,
    observation: buildEdgerV2Observation({ engine, actor }),
  });
  const mask = buildEdgerV2LegalMasks({
    actor, legalActions, selectedCardIndex: indices.card_index,
  }).placement;
  const logits = computeEdgerV2PlacementLogits({
    model, encodedState, cardIndex: indices.card_index, mask,
  });
  let ties = 0;
  for (let cell = 0; cell < logits.length; cell += 1) {
    if (mask[cell] && logits[cell] === logits[indices.placement_index]) {
      ties += 1;
    }
  }
  return ties;
}

// Compare adapter, frozen reference and (learned only) production selector on
// every bank state for every model, controller and actor.
export function checkBankEquivalence({ bank, models }) {
  const sources = new Map(bank.sources.map((source) => [source.id, source]));
  const mismatches = [];
  const tally = {};
  let decisions = 0;
  for (const state of bank.states) {
    const source = sources.get(state.source_id);
    if (!source) {
      throw new Error(`bank state ${state.id} has no source`);
    }
    const engine = rebuildEngineAt({ seed: source.seed, actions: source.actions, tick: state.tick });
    if (engine.getStateHash() !== state.state_hash) {
      mismatches.push({ state: state.id, check: "state_hash" });
      continue;
    }
    for (const actor of EDGER_V2_ACTORS) {
      for (const [run, model] of Object.entries(models)) {
        const legalActions = enumerateLegalCardActions({ engine, actor, model });
        for (const controller of EDGER_V2_CONTROLLER_LIST) {
          const reference = decideEdgerV2WithCadence({
            model, engine, actor, legalActions, cadence: controller,
          });
          const adapterOff = decideEdgerV2Diagnostic({ model, engine, actor, legalActions, controller });
          const phases = [];
          const adapterOn = decideEdgerV2Diagnostic({
            model, engine, actor, legalActions, controller, phaseHook: (phase) => phases.push(phase),
          });
          const where = { state: state.id, actor, model: run, controller };
          if (decisionKey(adapterOff) !== decisionKey(reference)) {
            mismatches.push({ ...where, check: "adapter_vs_reference" });
          }
          if (decisionKey(adapterOn) !== decisionKey(adapterOff)) {
            mismatches.push({ ...where, check: "hook_on_vs_off" });
          }
          if (JSON.stringify(phases) !== JSON.stringify(expectedPhases(controller))) {
            mismatches.push({ ...where, check: "phase_sequence", phases });
          }
          if (controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED) {
            const production = selectEdgerV2PolicyDecision({ model, engine, actor, legalActions });
            if (decisionKey(adapterOff) !== decisionKey(production)) {
              mismatches.push({ ...where, check: "adapter_vs_production" });
            }
          } else if (adapterOff.delayTicks !== 1 || adapterOff.indices.delay_index !== 0) {
            mismatches.push({ ...where, check: "fixed_delay" });
          }
          decisions += 1;
          const key = `${run}:${controller}:${actor}`;
          const entry = tally[key] ?? { decisions: 0, pass: 0, elective_pass: 0, play: 0, placement_ties: 0 };
          entry.decisions += 1;
          if (adapterOff.action.type === "PASS") {
            entry.pass += 1;
            entry.elective_pass += state.categories[actor].includes("elective") ? 1 : 0;
          } else {
            entry.play += 1;
            entry.placement_ties += placementTieCount({
              model, engine, actor, legalActions, indices: adapterOff.indices,
            }) > 1 ? 1 : 0;
          }
          tally[key] = entry;
        }
      }
      if (engine.getStateHash() !== state.state_hash) {
        mismatches.push({ state: state.id, actor, check: "engine_mutated" });
      }
    }
  }
  return { decisions, tally, mismatches };
}

// v2 adds the live-v1 baseline expectations (v1_baselines).
export const EDGER_V2_NODE_EXPECTATIONS_SCHEMA = "edger_v2_runtime_cost_node_expectations_v2";

// Reference decision kinds from frozen reference rows: the card mask's PASS
// entry is index 0, so a PASS with no other legal card is forced.
function referenceDecisionKinds(rows) {
  const kinds = { play: 0, elective_pass: 0, forced_pass: 0, illegal: 0 };
  for (const row of rows) {
    if (row.action.type !== "PASS") {
      continue;
    }
    kinds[row.card_mask.slice(1).some(Boolean) ? "elective_pass" : "forced_pass"] += 1;
  }
  return kinds;
}

// Expectations the staged browser must reproduce: the frozen reference's
// decision on every bank state/actor/model/controller, and every full-match
// condition's schedule, counts, hashes, result and overtime start. The adapter
// must already equal the reference in Node; any mismatch aborts emission.
export function buildNodeExpectations({
  bank,
  models,
  matchSeeds,
  opponentBotId = "edger",
  controllers = EDGER_V2_CONTROLLER_LIST,
  v1Baselines = true,
}) {
  const equivalence = checkBankEquivalence({ bank, models });
  if (equivalence.mismatches.length > 0) {
    throw new Error(`bank equivalence failed: ${JSON.stringify(equivalence.mismatches.slice(0, 5))}`);
  }
  const sources = new Map(bank.sources.map((source) => [source.id, source]));
  const bankDecisions = [];
  for (const state of bank.states) {
    const source = sources.get(state.source_id);
    const engine = rebuildEngineAt({ seed: source.seed, actions: source.actions, tick: state.tick });
    for (const actor of EDGER_V2_ACTORS) {
      for (const [run, model] of Object.entries(models)) {
        const legalActions = enumerateLegalCardActions({ engine, actor, model });
        for (const controller of EDGER_V2_CONTROLLER_LIST) {
          const reference = decideEdgerV2WithCadence({
            model, engine, actor, legalActions, cadence: controller,
          });
          bankDecisions.push({
            state: state.id,
            actor,
            model: run,
            controller,
            decision: JSON.parse(decisionKey(reference)),
          });
        }
      }
    }
  }

  const fullMatches = [];
  for (const seed of matchSeeds) {
    for (const [run, model] of Object.entries(models)) {
      for (const controller of controllers) {
        for (const candidateActor of EDGER_V2_ACTORS) {
          const reference = runEdgerV2CadenceMatch({
            seed, candidateActor, model, cadence: controller, opponentBotId, recordRows: true,
          });
          const schedule = referenceSchedule(reference.rows);
          const counts = {
            decisions: reference.stats.decisions,
            pass_decisions: reference.stats.pass_decisions,
            play_attempts: reference.stats.play_attempts,
            illegal_attempts: reference.stats.illegal_attempts,
          };
          const diagnostic = runDiagnosticMatch({ seed, candidateActor, model, controller, opponentBotId });
          const referenceKinds = referenceDecisionKinds(reference.rows);
          referenceKinds.play = counts.play_attempts;
          referenceKinds.illegal = counts.illegal_attempts;
          const agree =
            diagnostic.action_stream_hash === reference.action_stream_hash &&
            diagnostic.final_state_hash === reference.final_state_hash &&
            firstScheduleDifference(schedule, diagnostic.schedule) === null &&
            JSON.stringify(diagnostic.counts) === JSON.stringify(counts) &&
            JSON.stringify(diagnostic.decision_kinds) === JSON.stringify(referenceKinds) &&
            diagnostic.result.tick === reference.tick;
          if (!agree) {
            throw new Error(`adapter disagrees with the reference on ${seed} ${run} ${controller} ${candidateActor}`);
          }
          fullMatches.push({
            id: `${seed}-${run}-${controller}-${candidateActor}`,
            seed,
            model: run,
            controller,
            candidate_actor: candidateActor,
            opponent: opponentBotId,
            schedule_sha256: sha256Hex(JSON.stringify(schedule)),
            schedule,
            counts,
            decision_kinds: referenceKinds,
            opponent_decisions: diagnostic.opponent_decisions,
            action_stream_hash: reference.action_stream_hash,
            final_state_hash: reference.final_state_hash,
            result: { winner: reference.winner, reason: reference.reason, tick: reference.tick },
            overtime_start_tick: diagnostic.overtime_start_tick,
          });
        }
      }
    }
  }
  return {
    schema_version: EDGER_V2_NODE_EXPECTATIONS_SCHEMA,
    opponent: opponentBotId,
    bank_decisions: bankDecisions,
    full_matches: fullMatches,
    v1_baselines: v1Baselines ? buildV1BaselineExpectations({ matchSeeds, opponentBotId }) : [],
  };
}

// Independent Node reference for the live-v1 baseline, written in the style of
// the v2 evaluation worker's bot controllers (scripts/edger-v2-evaluation-worker.mjs):
// candidate RNG seed ^ 0xa5a5a5a5 and opponent RNG seed ^ 0x5f3759df, both
// deciding from tick 1 with select-then-roll, legality-checked, candidate first.
// The baseline driver instead calls the live selectBotDecision (roll, then
// select); live v1 selection consumes no RNG, so both orders must agree and the
// expectations require that they do.
export function runV1BaselineReference({ seed, candidateActor, opponentBotId = EDGER_BOT_ID,
  maxTicks = EDGER_V2_CADENCE_MAX_TICKS }) {
  const engine = createProductionEngine({ seed });
  const opponentActor = candidateActor === "blue" ? "red" : "blue";
  const controllers = [
    { actor: candidateActor, botId: EDGER_BOT_ID, rng: createRng(seed ^ EDGER_V1_BASELINE_CANDIDATE_SALT), next: 1 },
    { actor: opponentActor, botId: opponentBotId, rng: createRng(seed ^ EDGER_V2_DIAGNOSTIC_OPPONENT_SALT), next: 1 },
  ];
  const schedule = [];
  const stream = [];
  let opponentDecisions = 0;
  let overtimeStartTick = null;
  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    const actions = [];
    for (const [index, controller] of controllers.entries()) {
      if (tick < controller.next) {
        continue;
      }
      const legalActions = enumerateLegalCardActions({ engine, actor: controller.actor });
      const selected = selectBotAction({
        botId: controller.botId, engine, actor: controller.actor, legalActions, rng: controller.rng,
      });
      const delayTicks = rollDecisionDelayTicks({ botId: controller.botId, rng: controller.rng });
      controller.next = tick + delayTicks;
      const play = selected?.type === "PLAY_CARD";
      const legal = play && legalActions.some((candidate) =>
        candidate.cardId === selected.cardId && candidate.x === selected.x && candidate.y === selected.y);
      if (index === 0) {
        schedule.push({
          tick,
          card_id: play ? selected.cardId : null,
          x: play ? selected.x : null,
          y: play ? selected.y : null,
          delay_ticks: delayTicks,
          kind: play ? (legal ? "play" : "illegal")
            : legalActions.some((candidate) => candidate.type === "PLAY_CARD") ? "elective_pass" : "forced_pass",
        });
      } else {
        opponentDecisions += 1;
      }
      if (legal) {
        actions.push({ tick, type: "PLAY_CARD", actor: controller.actor, cardId: selected.cardId, x: selected.x, y: selected.y });
      }
    }
    stream.push(...actions);
    stepLikeReference(engine, actions);
    if (overtimeStartTick === null && engine.state.isOvertime) {
      overtimeStartTick = engine.state.tick;
    }
  }
  const result = engine.getMatchResult();
  if (!result) {
    throw new Error(`v1 baseline reference seed ${seed} did not finish within ${maxTicks} ticks`);
  }
  return {
    result,
    overtime_start_tick: overtimeStartTick,
    action_stream_hash: actionStreamHash(stream),
    final_state_hash: engine.getStateHash(),
    schedule,
    opponent_decisions: opponentDecisions,
  };
}

// Live-v1 baseline expectations, on the same development match seeds and both
// candidate sides. The driver (hooks off and on) must equal the independent
// reference in schedule, counts, kinds, opponent decisions, stream/state hashes,
// result and overtime start, or emission aborts.
export function buildV1BaselineExpectations({ matchSeeds, opponentBotId = EDGER_BOT_ID }) {
  const liveV1 = assertLiveV1Baseline();
  const entries = [];
  for (const seed of matchSeeds) {
    for (const candidateActor of EDGER_V2_ACTORS) {
      const reference = runV1BaselineReference({ seed, candidateActor, opponentBotId });
      const schedule = reference.schedule.map(({ kind, ...row }) => row);
      const kinds = { play: 0, elective_pass: 0, forced_pass: 0, illegal: 0 };
      for (const row of reference.schedule) {
        kinds[row.kind] += 1;
      }
      const counts = {
        decisions: schedule.length,
        pass_decisions: kinds.elective_pass + kinds.forced_pass,
        play_attempts: kinds.play,
        illegal_attempts: kinds.illegal,
      };
      const phases = [];
      const opponentPhases = [];
      for (const [label, hooks] of [
        ["hook_off", {}],
        ["hook_on", { phaseHook: (phase) => phases.push(phase), opponentHook: (phase) => opponentPhases.push(phase) }],
      ]) {
        const driven = runV1BaselineMatch({ seed, candidateActor, ...hooks });
        const agree =
          driven.action_stream_hash === reference.action_stream_hash &&
          driven.final_state_hash === reference.final_state_hash &&
          firstScheduleDifference(schedule, driven.schedule) === null &&
          JSON.stringify(driven.counts) === JSON.stringify(counts) &&
          JSON.stringify(driven.decision_kinds) === JSON.stringify(kinds) &&
          driven.opponent_decisions === reference.opponent_decisions &&
          driven.overtime_start_tick === reference.overtime_start_tick &&
          driven.result.tick === reference.result.tick &&
          driven.result.winner === reference.result.winner;
        if (!agree) {
          throw new Error(`live-v1 baseline driver (${label}) disagrees with the reference on ${seed} ${candidateActor}`);
        }
      }
      const expectedPhases = counts.decisions * EDGER_V1_BASELINE_PHASES.length;
      const expectedOpponent = reference.opponent_decisions * EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES.length;
      if (phases.length !== expectedPhases || opponentPhases.length !== expectedOpponent ||
        schedule.some((row) => row.delay_ticks !== liveV1.delay_ticks)) {
        throw new Error(`live-v1 baseline hooks or delays are inconsistent on ${seed} ${candidateActor}`);
      }
      entries.push({
        id: `${seed}-v1-${candidateActor}`,
        kind: "v1_baseline",
        seed,
        model: "v1",
        controller: "live_v1",
        candidate_actor: candidateActor,
        opponent: opponentBotId,
        live_v1: liveV1,
        schedule_sha256: sha256Hex(JSON.stringify(schedule)),
        schedule,
        counts,
        decision_kinds: kinds,
        opponent_decisions: reference.opponent_decisions,
        action_stream_hash: reference.action_stream_hash,
        final_state_hash: reference.final_state_hash,
        result: { winner: reference.result.winner, reason: reference.result.reason, tick: reference.result.tick },
        overtime_start_tick: reference.overtime_start_tick,
      });
    }
  }
  return entries;
}
