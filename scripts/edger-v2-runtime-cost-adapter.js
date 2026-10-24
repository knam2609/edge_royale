// Browser-safe diagnostic adapter for the Edger v2 runtime-cost study.
//
// Deterministic counterpart of decideEdgerV2WithCadence in
// scripts/edger-v2-cadence-core.mjs, which stays the frozen Node reference but
// imports node:crypto and cannot load in a browser. This file imports only
// engine, bot-runtime, live-v1 and v2 policy modules that the client already
// serves, and uses the plain .js extension because the static dev server does
// not serve .mjs as JavaScript. Nothing here is imported by src/client, the
// live bot, the promotion evaluator or production campaigns. It also drives the
// live-v1 cost baseline (createEdgerV1BaselineDriver).
//
// Cost-relevant structure is kept exactly: two mask builds per decision, the
// placement head also runs on PASS, ties resolve to the first strictly greater
// legal logit, and the fixed one-tick controller never evaluates the delay head.
// The optional phaseHook only observes; it must not change any output.

import {
  EDGER_BOT_ID,
  enumerateLegalCardActions,
  getBotConfig,
  rollDecisionDelayTicks,
  selectBotAction,
  selectBotDecision,
} from "../src/ai/botRuntime.js";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  EDGER_V2_POLICY_MODEL_SCHEMA_VERSION,
  computeEdgerV2CardLogits,
  computeEdgerV2DelayLogits,
  computeEdgerV2PlacementLogits,
  encodeEdgerV2PolicyState,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";

// Same names as EDGER_V2_CADENCES in the cadence core; a test keeps them equal.
export const EDGER_V2_DIAGNOSTIC_CONTROLLERS = Object.freeze({
  LEARNED: "learned",
  FIXED_ONE_TICK: "fixed_one_tick",
});

// Phase boundaries reported to phaseHook, in call order. "begin" opens a
// decision; every later name closes the phase it labels. The delay phase only
// occurs under the learned controller.
export const EDGER_V2_DIAGNOSTIC_PHASES = Object.freeze([
  "begin",
  "enumerate",
  "observation",
  "encode",
  "card_mask",
  "card_head",
  "selected_masks",
  "placement_head",
  "delay_head",
  "decode",
  "schedule",
]);

// Opponent boundaries reported to opponentHook, in call order. "begin" opens an
// opponent decision; "select" precedes the delay roll, as in the reference.
export const EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES = Object.freeze([
  "begin",
  "enumerate",
  "select",
  "delay",
  "construct",
]);

// Candidate decision kinds, classified from the already-enumerated legal list.
export const EDGER_V2_DIAGNOSTIC_DECISION_KINDS = Object.freeze([
  "play",
  "elective_pass",
  "forced_pass",
  "illegal",
]);

// Same salt as the cadence core, the v2 evaluation worker and the browser.
export const EDGER_V2_DIAGNOSTIC_OPPONENT_SALT = 0x5f3759df;
// Candidate salt of the evaluation workers; used only by the live-v1 baseline.
export const EDGER_V1_BASELINE_CANDIDATE_SALT = 0xa5a5a5a5;

// Live-v1 baseline candidate boundaries, in call order. "decide" closes the
// unchanged live selectBotDecision call (delay roll, then selection);
// "schedule" includes the legality check, bookkeeping and action construction.
export const EDGER_V1_BASELINE_PHASES = Object.freeze(["begin", "enumerate", "decide", "schedule"]);

function assertController(controller) {
  if (!Object.values(EDGER_V2_DIAGNOSTIC_CONTROLLERS).includes(controller)) {
    throw new Error(`unknown v2 diagnostic controller ${controller}`);
  }
}

function maskedArgmax(logits, mask) {
  // Same tie behavior as src/ai/v2/policy.js: first strictly greater legal logit.
  let bestIndex = -1;
  let bestValue = -Infinity;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index] && logits[index] > bestValue) {
      bestIndex = index;
      bestValue = logits[index];
    }
  }
  return bestIndex >= 0 ? bestIndex : 0;
}

// One deterministic v2 decision. Legal actions are enumerated by the caller,
// as in the reference, so enumeration is timed by the match driver.
export function decideEdgerV2Diagnostic({
  model,
  engine,
  actor,
  legalActions,
  controller,
  phaseHook = null,
}) {
  assertController(controller);
  const observation = buildEdgerV2Observation({ engine, actor });
  phaseHook?.("observation");
  const encodedState = encodeEdgerV2PolicyState({ model, observation });
  phaseHook?.("encode");
  const cardMask = buildEdgerV2LegalMasks({ actor, legalActions }).card;
  phaseHook?.("card_mask");
  const cardLogits = computeEdgerV2CardLogits({ model, encodedState, mask: cardMask });
  const cardIndex = maskedArgmax(cardLogits, cardMask);
  phaseHook?.("card_head");

  const selectedMasks = buildEdgerV2LegalMasks({
    actor,
    legalActions,
    selectedCardIndex: cardIndex,
  });
  phaseHook?.("selected_masks");
  const placementLogits = computeEdgerV2PlacementLogits({
    model,
    encodedState,
    cardIndex,
    mask: selectedMasks.placement,
  });
  const placementIndex = maskedArgmax(placementLogits, selectedMasks.placement);
  phaseHook?.("placement_head");

  let delayIndex = 0;
  if (controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED) {
    const delayLogits = computeEdgerV2DelayLogits({
      model,
      encodedState,
      cardIndex,
      placementIndex,
      mask: selectedMasks.delay,
    });
    delayIndex = maskedArgmax(delayLogits, selectedMasks.delay);
    phaseHook?.("delay_head");
  }

  const decoded = decodeEdgerV2Action({ actor, cardIndex, placementIndex, delayIndex });
  phaseHook?.("decode");
  return {
    action: decoded.action,
    delayTicks:
      controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.FIXED_ONE_TICK ? 1 : decoded.delayTicks,
    indices: {
      card_index: cardIndex,
      placement_index: placementIndex,
      delay_index: delayIndex,
    },
  };
}

// Bounded per-phase accumulator for phaseHook: sum/count/max of the time
// between consecutive boundaries, plus whole-decision totals from "begin" to
// "schedule". It keeps no per-call samples, so its size never grows.
export function createEdgerV2PhaseAccumulator({ now = () => performance.now() } = {}) {
  const phases = Object.fromEntries(
    EDGER_V2_DIAGNOSTIC_PHASES.filter((phase) => phase !== "begin")
      .concat(["decision_total"])
      .map((phase) => [phase, { count: 0, sum_ms: 0, max_ms: 0 }]),
  );
  let decisionStart = null;
  let last = null;

  function add(phase, elapsed) {
    const entry = phases[phase];
    entry.count += 1;
    entry.sum_ms += elapsed;
    entry.max_ms = Math.max(entry.max_ms, elapsed);
  }

  function hook(phase) {
    const time = now();
    if (phase === "begin") {
      decisionStart = time;
      last = time;
      return;
    }
    if (last === null || !(phase in phases)) {
      throw new Error(`phase ${phase} outside a decision`);
    }
    add(phase, time - last);
    last = time;
    if (phase === "schedule") {
      add("decision_total", time - decisionStart);
      decisionStart = null;
      last = null;
    }
  }

  return {
    hook,
    snapshot: () => JSON.parse(JSON.stringify(phases)),
  };
}

function assertCandidateActor(candidateActor) {
  if (candidateActor !== "blue" && candidateActor !== "red") {
    throw new Error(`unknown candidate actor ${candidateActor}`);
  }
}

// The bot-runtime opponent shared by both drivers, exactly as in the frozen
// reference: its RNG uses the shared salt, it starts deciding at tick 1, and it
// selects its action and then rolls its delay. opponentHook receives
// EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES; its "construct" call also gets
// { tick, play }.
function createBotOpponent({ seed, opponentActor, opponentBotId, opponentHook }) {
  const rng = createRng(seed ^ EDGER_V2_DIAGNOSTIC_OPPONENT_SALT);
  let nextTick = 1;
  const decisionTicks = [];
  function step(engine, tick, actions) {
    if (tick < nextTick) {
      return;
    }
    opponentHook?.("begin");
    const legalActions = enumerateLegalCardActions({ engine, actor: opponentActor });
    opponentHook?.("enumerate");
    const selected = selectBotAction({
      botId: opponentBotId,
      engine,
      actor: opponentActor,
      legalActions,
      rng,
    });
    opponentHook?.("select");
    nextTick = tick + rollDecisionDelayTicks({ botId: opponentBotId, rng });
    opponentHook?.("delay");
    decisionTicks.push(tick);
    const play = selected?.type === "PLAY_CARD";
    if (play) {
      actions.push({
        tick,
        type: "PLAY_CARD",
        actor: opponentActor,
        cardId: selected.cardId,
        x: selected.x,
        y: selected.y,
      });
    }
    opponentHook?.("construct", { tick, play });
  }
  return { step, decisionTicks };
}

// Classify a candidate decision from the already-enumerated legal list, update
// the reference-shaped counts and append the action when it is a legal play.
function recordCandidateDecision({ action, legalActions, tick, actor, counts, actions }) {
  if (action?.type === "PLAY_CARD") {
    const legal = legalActions.some((candidate) =>
      candidate.cardId === action.cardId &&
      candidate.x === action.x &&
      candidate.y === action.y);
    if (!legal) {
      counts.illegal_attempts += 1;
      return "illegal";
    }
    counts.play_attempts += 1;
    actions.push({ tick, type: "PLAY_CARD", actor, cardId: action.cardId, x: action.x, y: action.y });
    return "play";
  }
  counts.pass_decisions += 1;
  return legalActions.some((candidate) => candidate.type === "PLAY_CARD") ? "elective_pass" : "forced_pass";
}

function emptyCounts() {
  return { decisions: 0, pass_decisions: 0, play_attempts: 0, illegal_attempts: 0 };
}

function emptyKinds() {
  return Object.fromEntries(EDGER_V2_DIAGNOSTIC_DECISION_KINDS.map((kind) => [kind, 0]));
}

// Per-tick action builder for one candidate against a bot-runtime opponent.
//
// Mirrors one iteration of runEdgerV2CadenceMatch in deterministic mode:
// candidate first, then opponent; candidate and opponent both start deciding at
// tick 1; the opponent's RNG uses the shared salt, selects its action and then
// rolls its delay. The returned list is in that order, which is the order the
// reference hashes; engine.step sorts actions itself, so state is unaffected.
// The caller steps the engine and applies overtime exactly as the reference.
//
// phaseHook receives the candidate boundaries; its "schedule" call also gets
// { tick, kind }. opponentHook receives EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES; its
// "construct" call also gets { tick, play }. The "schedule" phase includes the
// legality check and diagnostic schedule/count bookkeeping. Hooks only observe.
export function createEdgerV2DiagnosticDriver({
  seed,
  candidateActor,
  model,
  controller,
  opponentBotId = "edger",
  phaseHook = null,
  opponentHook = null,
}) {
  assertController(controller);
  assertCandidateActor(candidateActor);
  const opponentActor = candidateActor === "blue" ? "red" : "blue";
  const opponent = createBotOpponent({ seed, opponentActor, opponentBotId, opponentHook });
  let candidateNextTick = 1;
  // Bounded: one entry per candidate decision, at most one per tick.
  const schedule = [];
  const counts = emptyCounts();
  // Kept apart from counts, whose shape equals the reference's statistics.
  const decisionKinds = emptyKinds();

  function actionsForTick(engine, tick) {
    if (tick !== engine.state.tick + 1) {
      throw new Error(`driver asked for tick ${tick} at engine tick ${engine.state.tick}`);
    }
    const actions = [];
    if (tick >= candidateNextTick) {
      phaseHook?.("begin");
      const legalActions = enumerateLegalCardActions({ engine, actor: candidateActor });
      phaseHook?.("enumerate");
      const decision = decideEdgerV2Diagnostic({
        model,
        engine,
        actor: candidateActor,
        legalActions,
        controller,
        phaseHook,
      });
      candidateNextTick = tick + decision.delayTicks;
      counts.decisions += 1;
      schedule.push({
        tick,
        card_index: decision.indices.card_index,
        placement_index: decision.indices.placement_index,
        delay_index: decision.indices.delay_index,
        delay_ticks: decision.delayTicks,
      });
      const kind = recordCandidateDecision({
        action: decision.action, legalActions, tick, actor: candidateActor, counts, actions,
      });
      decisionKinds[kind] += 1;
      phaseHook?.("schedule", { tick, kind });
    }
    opponent.step(engine, tick, actions);
    return actions;
  }

  return {
    candidateActor,
    opponentActor,
    actionsForTick,
    schedule,
    counts,
    decisionKinds,
    opponentDecisionTicks: opponent.decisionTicks,
  };
}

// The live v1 the baseline drives: the generated runtime module, which must
// still be a v1 model with the one-tick Edger delay. Otherwise selectBotDecision
// would take a different path and the baseline would not be live v1.
export function assertLiveV1Baseline(botId = EDGER_BOT_ID) {
  if (EDGER_POLICY_MODEL?.schema_version === EDGER_V2_POLICY_MODEL_SCHEMA_VERSION) {
    throw new Error("the live Edger module is a v2 model; the live-v1 baseline is undefined");
  }
  const config = getBotConfig(botId);
  if (config.id !== EDGER_BOT_ID || config.min_delay_ticks !== 1 || config.max_delay_ticks !== 1) {
    throw new Error(`live v1 ${config.id} delay is ${config.min_delay_ticks}-${config.max_delay_ticks} ticks, not one tick`);
  }
  return { model_id: EDGER_POLICY_MODEL.model_id, schema_version: EDGER_POLICY_MODEL.schema_version, delay_ticks: 1 };
}

// Per-tick action builder for the live-v1 cost baseline (an automated
// v1-vs-v1 cost reference, not human-match behavior). The candidate runs the
// unchanged live path after legal enumeration: selectBotDecision (delay roll,
// then selection) with candidate RNG seed ^ EDGER_V1_BASELINE_CANDIDATE_SALT,
// then scheduling and action construction. The opponent, the candidate-first
// raw action order and both first decision ticks (1) are as in the v2 driver.
// phaseHook receives EDGER_V1_BASELINE_PHASES; "schedule" also gets
// { tick, kind }. Schedule rows record the selected action and delay.
export function createEdgerV1BaselineDriver({
  seed,
  candidateActor,
  opponentBotId = EDGER_BOT_ID,
  phaseHook = null,
  opponentHook = null,
}) {
  assertCandidateActor(candidateActor);
  assertLiveV1Baseline();
  const opponentActor = candidateActor === "blue" ? "red" : "blue";
  const opponent = createBotOpponent({ seed, opponentActor, opponentBotId, opponentHook });
  const candidateRng = createRng(seed ^ EDGER_V1_BASELINE_CANDIDATE_SALT);
  let candidateNextTick = 1;
  const schedule = [];
  const counts = emptyCounts();
  const decisionKinds = emptyKinds();

  function actionsForTick(engine, tick) {
    if (tick !== engine.state.tick + 1) {
      throw new Error(`driver asked for tick ${tick} at engine tick ${engine.state.tick}`);
    }
    const actions = [];
    if (tick >= candidateNextTick) {
      phaseHook?.("begin");
      const legalActions = enumerateLegalCardActions({ engine, actor: candidateActor });
      phaseHook?.("enumerate");
      const decision = selectBotDecision({
        botId: EDGER_BOT_ID,
        engine,
        actor: candidateActor,
        legalActions,
        rng: candidateRng,
      });
      phaseHook?.("decide");
      candidateNextTick = tick + decision.delayTicks;
      counts.decisions += 1;
      const action = decision.action;
      const play = action?.type === "PLAY_CARD";
      schedule.push({
        tick,
        card_id: play ? action.cardId : null,
        x: play ? action.x : null,
        y: play ? action.y : null,
        delay_ticks: decision.delayTicks,
      });
      const kind = recordCandidateDecision({ action, legalActions, tick, actor: candidateActor, counts, actions });
      decisionKinds[kind] += 1;
      phaseHook?.("schedule", { tick, kind });
    }
    opponent.step(engine, tick, actions);
    return actions;
  }

  return {
    candidateActor,
    opponentActor,
    actionsForTick,
    schedule,
    counts,
    decisionKinds,
    opponentDecisionTicks: opponent.decisionTicks,
  };
}
