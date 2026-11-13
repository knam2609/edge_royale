// Diagnostic-only decision-cadence controller for the shadow v2 policy.
//
// The shipped v2 contract chooses card, placement, then a 1-200 tick delay
// before its next decision. This module adds an experimental fixed one-tick
// cadence that reuses the same card and placement heads, keeps PASS available,
// and never evaluates the delay head. Nothing here is used by the live bot,
// the promotion evaluator or production campaigns.

import { createHash } from "node:crypto";

import {
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../src/ai/botRuntime.js";
import {
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  EDGER_V2_CARD_ACTIONS,
  EDGER_V2_DELAY_BINS,
  EDGER_V2_GLOBAL_FEATURES,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2CardLogits,
  computeEdgerV2DelayLogits,
  computeEdgerV2PlacementLogits,
  encodeEdgerV2PolicyState,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import {
  cloneProductionInitialCardState,
  createProductionEngine,
} from "../src/sim/productionMatch.js";
import {
  EDGER_REWARD_VERSIONS,
  assertRewardVersion,
  potentialForActor,
  terminalPotentialForActor,
  v1PotentialForActor,
} from "./edger-reward-core.mjs";
import {
  createPlaystyleTracker,
  finishPlaystyle,
  playstyleAfterStep,
  playstyleBeforeStep,
} from "./edger-playstyle-core.mjs";

export const EDGER_V2_CADENCE_EPISODE_SCHEMA = "edger_v2_cadence_episode_v1";
export const EDGER_V2_CADENCES = Object.freeze({
  LEARNED: "learned",
  FIXED_ONE_TICK: "fixed_one_tick",
});
export const EDGER_V2_CADENCE_MAX_TICKS = 6040;
// Must match scripts/edger-corpus-core.mjs; the tests compare the two paths.
export const EDGER_V2_CADENCE_PER_TICK_GAMMA = 0.9997;
// The default reward. Version v2 is opt-in (scripts/edger-reward-core.mjs).
export const EDGER_V2_CADENCE_REWARD_VERSION = EDGER_REWARD_VERSIONS.V1;
export const EDGER_V2_BOARD_SIZE =
  EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS;

const PLACEMENTS = EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH;

function assertCadence(cadence) {
  if (!Object.values(EDGER_V2_CADENCES).includes(cadence)) {
    throw new Error(`unknown v2 cadence ${cadence}`);
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

// Exact masked log-softmax in float64 over the legal entries.
export function maskedLogSoftmax(logits, mask) {
  let maximum = -Infinity;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index]) {
      maximum = Math.max(maximum, logits[index]);
    }
  }
  let total = 0;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index]) {
      total += Math.exp(logits[index] - maximum);
    }
  }
  const logTotal = Math.log(total) + maximum;
  const result = new Float64Array(logits.length).fill(-Infinity);
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index]) {
      result[index] = logits[index] - logTotal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Routine policy diagnostics (descriptive only)
//
// Frozen on November 6, 2026, before the production-learner comparison
// (docs/EDGER_TACTICAL_REVIEW.md, "Routine policy diagnostics"). They describe
// the choices a policy makes; they are not exclusion, stopping or promotion
// thresholds, and computing them never changes a decision.
// - Population: every decision the candidate makes in the summarized games.
// - Choice decision: at least one non-PASS card is legal. A forced PASS has
//   card entropy 0 by construction, so card entropy covers choice decisions.
// - PASS decision: the card head selected PASS (card index 0).
// - Entropy: Shannon entropy in nats of the temperature-1 masked softmax over
//   the legal entries, computed in float64 from the runtime's float32 logits.
//   Card: legal card actions, PASS included. Delay: the 200 legal delay bins
//   given the selected card and placement, learned cadence only.
// - Maximum legal logit: the largest |logit| over legal entries of a head.
//   Card: every decision. Placement: the selected card's legal cells, on
//   decisions that select a card. Delay: learned cadence only.
// - Minimum delay: the chosen delay is one tick.
export const EDGER_V2_POLICY_DIAGNOSTICS_SCHEMA = "edger_v2_policy_diagnostics_v1";

export function maskedEntropy(logits, mask) {
  const logProbabilities = maskedLogSoftmax(logits, mask);
  let entropy = 0;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index]) {
      entropy -= Math.exp(logProbabilities[index]) * logProbabilities[index];
    }
  }
  return entropy;
}

export function maxAbsLegalLogit(logits, mask) {
  let maximum = null;
  for (let index = 0; index < logits.length; index += 1) {
    if (mask[index]) {
      const magnitude = Math.abs(logits[index]);
      maximum = maximum === null ? magnitude : Math.max(maximum, magnitude);
    }
  }
  return maximum;
}

function hasLegalCard(cardMask) {
  for (let index = 1; index < cardMask.length; index += 1) {
    if (cardMask[index]) {
      return true;
    }
  }
  return false;
}

// Diagnostics of one decision returned by decideEdgerV2WithCadence.
export function edgerV2DecisionDiagnostics(decision) {
  const choice = hasLegalCard(decision.cardMask);
  const selectsCard = decision.indices.card_index !== 0;
  const learned = decision.logits.delay !== null;
  return {
    choice,
    pass: !selectsCard,
    card_entropy: choice ? maskedEntropy(decision.logits.card, decision.cardMask) : null,
    delay_entropy: learned ? maskedEntropy(decision.logits.delay, decision.delayMask) : null,
    max_abs_legal_logit: {
      card: maxAbsLegalLogit(decision.logits.card, decision.cardMask),
      placement: selectsCard
        ? maxAbsLegalLogit(decision.logits.placement, decision.placementMask)
        : null,
      delay: learned ? maxAbsLegalLogit(decision.logits.delay, decision.delayMask) : null,
    },
  };
}

// Per-game accumulator; summarizePolicyDiagnostics pools these across games.
export function emptyPolicyDiagnosticsStats() {
  return {
    decisions: 0,
    pass_decisions: 0,
    choice_decisions: 0,
    pass_choice_decisions: 0,
    card_entropy_sum_given_choice: 0,
    delay_entropy_decisions: 0,
    delay_entropy_sum: 0,
    minimum_delay_decisions: 0,
    max_abs_legal_logit: { card: null, placement: null, delay: null },
  };
}

function maxOrNull(left, right) {
  if (left === null) {
    return right;
  }
  return right === null ? left : Math.max(left, right);
}

export function addDecisionDiagnostics(stats, diagnostics, delayTicks) {
  stats.decisions += 1;
  if (diagnostics.pass) {
    stats.pass_decisions += 1;
  }
  if (diagnostics.choice) {
    stats.choice_decisions += 1;
    stats.card_entropy_sum_given_choice += diagnostics.card_entropy;
    if (diagnostics.pass) {
      stats.pass_choice_decisions += 1;
    }
  }
  if (diagnostics.delay_entropy !== null) {
    stats.delay_entropy_decisions += 1;
    stats.delay_entropy_sum += diagnostics.delay_entropy;
  }
  if (delayTicks === 1) {
    stats.minimum_delay_decisions += 1;
  }
  for (const head of ["card", "placement", "delay"]) {
    stats.max_abs_legal_logit[head] = maxOrNull(
      stats.max_abs_legal_logit[head],
      diagnostics.max_abs_legal_logit[head],
    );
  }
  return stats;
}

function sampleFromLogProbabilities(logProbabilities, mask, rng) {
  const roll = rng();
  let cumulative = 0;
  let last = -1;
  for (let index = 0; index < logProbabilities.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    last = index;
    cumulative += Math.exp(logProbabilities[index]);
    if (roll < cumulative) {
      return index;
    }
  }
  return last >= 0 ? last : 0;
}

// One v2 decision under a chosen cadence.
//
// Deterministic mode (sampler === null) takes the masked argmax of each head,
// exactly like selectEdgerV2PolicyDecision. Sampling mode draws card, then
// placement for that card, then (learned cadence only) delay, from the
// temperature-1 masked softmax, and reports the log-probability of each draw.
//
// Under the fixed one-tick cadence the delay is not a policy output: it is
// always one tick with probability one, so its log-probability is exactly 0 and
// the delay head is never evaluated. PASS stays a legal card choice.
export function decideEdgerV2WithCadence({
  model,
  engine,
  actor,
  legalActions,
  cadence,
  sampler = null,
  observation = null,
}) {
  assertCadence(cadence);
  const resolvedObservation = observation ?? buildEdgerV2Observation({ engine, actor });
  const encodedState = encodeEdgerV2PolicyState({ model, observation: resolvedObservation });
  const cardMask = buildEdgerV2LegalMasks({ actor, legalActions }).card;
  const cardLogits = computeEdgerV2CardLogits({ model, encodedState, mask: cardMask });

  let cardIndex;
  let cardLogProbability = 0;
  if (sampler) {
    const logProbabilities = maskedLogSoftmax(cardLogits, cardMask);
    cardIndex = sampleFromLogProbabilities(logProbabilities, cardMask, sampler.rng);
    cardLogProbability = logProbabilities[cardIndex];
  } else {
    cardIndex = maskedArgmax(cardLogits, cardMask);
  }

  const selectedMasks = buildEdgerV2LegalMasks({
    actor,
    legalActions,
    selectedCardIndex: cardIndex,
  });
  const placementLogits = computeEdgerV2PlacementLogits({
    model,
    encodedState,
    cardIndex,
    mask: selectedMasks.placement,
  });
  let placementIndex;
  let placementLogProbability = 0;
  if (sampler && cardIndex !== 0) {
    const logProbabilities = maskedLogSoftmax(placementLogits, selectedMasks.placement);
    placementIndex = sampleFromLogProbabilities(
      logProbabilities,
      selectedMasks.placement,
      sampler.rng,
    );
    placementLogProbability = logProbabilities[placementIndex];
  } else {
    // PASS has a single legal placement cell (index 0) and, like the learner's
    // selected_joint_log_probability, contributes no placement term.
    placementIndex = maskedArgmax(placementLogits, selectedMasks.placement);
  }

  let delayIndex = 0;
  let delayLogProbability = 0;
  let delayLogits = null;
  if (cadence === EDGER_V2_CADENCES.LEARNED) {
    delayLogits = computeEdgerV2DelayLogits({
      model,
      encodedState,
      cardIndex,
      placementIndex,
      mask: selectedMasks.delay,
    });
    if (sampler) {
      const logProbabilities = maskedLogSoftmax(delayLogits, selectedMasks.delay);
      delayIndex = sampleFromLogProbabilities(logProbabilities, selectedMasks.delay, sampler.rng);
      delayLogProbability = logProbabilities[delayIndex];
    } else {
      delayIndex = maskedArgmax(delayLogits, selectedMasks.delay);
    }
  }

  const decoded = decodeEdgerV2Action({ actor, cardIndex, placementIndex, delayIndex });
  const delayTicks = cadence === EDGER_V2_CADENCES.FIXED_ONE_TICK ? 1 : decoded.delayTicks;
  return {
    action: decoded.action,
    delayTicks,
    indices: {
      card_index: cardIndex,
      placement_index: placementIndex,
      delay_index: delayIndex,
    },
    observation: resolvedObservation,
    cardMask,
    placementMask: selectedMasks.placement,
    delayMask: selectedMasks.delay,
    // The runtime's own masked logits, for descriptive diagnostics only. The
    // delay head is not evaluated under the fixed one-tick cadence.
    logits: {
      card: cardLogits,
      placement: placementLogits,
      delay: delayLogits,
    },
    logProbabilities: sampler
      ? {
          card: cardLogProbability,
          placement: placementLogProbability,
          delay: delayLogProbability,
          joint: cardLogProbability + placementLogProbability + delayLogProbability,
        }
      : null,
  };
}

// Same potential and terminal reward as deriveDecisionSequence (reward v1).
export function scorePotentialForActor(engine, actor) {
  return v1PotentialForActor(engine, actor);
}

export function terminalRewardForActor(result, actor) {
  if (!result?.winner) {
    return 0;
  }
  return result.winner === actor ? 1 : -1;
}

// Assign rewards and discounted returns over the actual decision intervals.
// This is the reward loop of deriveDecisionSequence applied to one actor: each
// row's interval runs to the next recorded decision, and the last row's runs
// to result.tick + 1, where the terminal reward is discounted and added.
export function assignDecisionRewards({
  rows,
  finalPotential,
  result,
  actor,
  perTickGamma = EDGER_V2_CADENCE_PER_TICK_GAMMA,
}) {
  let nextPotential = finalPotential;
  let nextTick = result.tick + 1;
  const terminal = terminalRewardForActor(result, actor);
  let nextReturn = terminal;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const deltaTicks = Math.max(1, nextTick - row.tick);
    const discount = perTickGamma ** deltaTicks;
    const shaped = discount * nextPotential - row.potential;
    row.reward = shaped + (index === rows.length - 1 ? discount * terminal : 0);
    row.discounted_return = shaped + discount * nextReturn;
    row.interval_ticks = deltaTicks;
    nextReturn = row.discounted_return;
    nextPotential = row.potential;
    nextTick = row.tick;
  }
  return rows;
}

function sparseBoard(board) {
  const indices = [];
  const values = [];
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== 0) {
      indices.push(index);
      values.push(board[index]);
    }
  }
  return { indices, values };
}

function legalIndices(mask) {
  const indices = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      indices.push(index);
    }
  }
  return indices;
}

function botController(seed) {
  return { rng: createRng(seed), nextDecisionTick: 1 };
}

function histogramAdd(histogram, key, amount = 1) {
  histogram[key] = (histogram[key] ?? 0) + amount;
}

export function actionStreamHash(actions) {
  return createHash("sha256").update(JSON.stringify(actions)).digest("hex");
}

// Run one production-arena match of a v2 candidate under a cadence against a
// bot-runtime opponent. Seeds, controller RNG salts and tick loop match
// scripts/edger-v2-evaluation-worker.mjs.
export function runEdgerV2CadenceMatch({
  seed,
  candidateActor,
  model,
  cadence,
  opponentBotId,
  mode = "deterministic",
  recordRows = false,
  probeStride = 0,
  returnReplay = false,
  maxTicks = EDGER_V2_CADENCE_MAX_TICKS,
  rewardVersion = EDGER_V2_CADENCE_REWARD_VERSION,
}) {
  assertCadence(cadence);
  assertRewardVersion(rewardVersion);
  if (mode !== "deterministic" && mode !== "sample") {
    throw new Error(`unknown cadence match mode ${mode}`);
  }
  const engine = createProductionEngine({ seed });
  const initialCardState = returnReplay ? cloneProductionInitialCardState(engine) : null;
  const opponentActor = candidateActor === "blue" ? "red" : "blue";
  const sampler = mode === "sample" ? { rng: createRng(seed ^ 0xa5a5a5a5) } : null;
  const opponent = botController(seed ^ 0x5f3759df);
  let candidateNextTick = 1;
  const rows = [];
  const probes = [];
  const actionStream = [];
  const stats = {
    decisions: 0,
    pass_decisions: 0,
    play_attempts: 0,
    illegal_attempts: 0,
    chosen_delay_histogram: {},
    chosen_delay_after_play_histogram: {},
    decision_ticks_first: null,
    full_elixir_ticks: 0,
    inference_ms: 0,
    policy_diagnostics: emptyPolicyDiagnosticsStats(),
  };
  const decisionTicks = [];
  // Descriptive playstyle diagnostics; the tracker only reads engine state.
  const playstyle = createPlaystyleTracker(candidateActor);

  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    const actions = [];
    if ((engine.state.elixir?.[candidateActor]?.elixir ?? 0) >= 10) {
      stats.full_elixir_ticks += 1;
    }
    if (tick >= candidateNextTick) {
      const legalActions = enumerateLegalCardActions({ engine, actor: candidateActor, model });
      const started = performance.now();
      const decision = decideEdgerV2WithCadence({
        model,
        engine,
        actor: candidateActor,
        legalActions,
        cadence,
        sampler,
      });
      stats.inference_ms += performance.now() - started;
      // Outside the timed region, so inference timings stay comparable.
      addDecisionDiagnostics(
        stats.policy_diagnostics,
        edgerV2DecisionDiagnostics(decision),
        decision.delayTicks,
      );
      stats.decisions += 1;
      decisionTicks.push(tick);
      histogramAdd(stats.chosen_delay_histogram, decision.delayTicks);
      candidateNextTick = tick + decision.delayTicks;
      if (recordRows) {
        const board = sparseBoard(decision.observation.board);
        rows.push({
          tick,
          action: decision.action,
          board_indices: board.indices,
          board_values: board.values,
          global: Array.from(decision.observation.global),
          card_mask: Array.from(decision.cardMask),
          placement_legal: legalIndices(decision.placementMask),
          card_index: decision.indices.card_index,
          placement_index: decision.indices.placement_index,
          delay_index: decision.indices.delay_index,
          delay_ticks: decision.delayTicks,
          behavior_log_probability: decision.logProbabilities?.joint ?? null,
          behavior_card_log_probability: decision.logProbabilities?.card ?? null,
          behavior_placement_log_probability: decision.logProbabilities?.placement ?? null,
          behavior_delay_log_probability: decision.logProbabilities?.delay ?? null,
          potential: potentialForActor(engine, candidateActor, rewardVersion).total,
        });
      }
      if (probeStride > 0 && (stats.decisions - 1) % probeStride === 0) {
        const board = sparseBoard(decision.observation.board);
        // Selected-card placement masks for every card let the drift probe
        // compare placement heads under the parent's own card choice.
        const placementByCard = EDGER_V2_CARD_ACTIONS.map((_, cardIndex) =>
          legalIndices(buildEdgerV2LegalMasks({
            actor: candidateActor,
            legalActions,
            selectedCardIndex: cardIndex,
          }).placement));
        probes.push({
          tick,
          board_indices: board.indices,
          board_values: board.values,
          global: Array.from(decision.observation.global),
          card_mask: Array.from(decision.cardMask),
          placement_by_card: placementByCard,
          card_index: decision.indices.card_index,
          placement_index: decision.indices.placement_index,
        });
      }
      if (decision.action.type === "PLAY_CARD") {
        const legal = legalActions.some((candidate) =>
          candidate.cardId === decision.action.cardId &&
          candidate.x === decision.action.x &&
          candidate.y === decision.action.y);
        if (legal) {
          stats.play_attempts += 1;
          histogramAdd(stats.chosen_delay_after_play_histogram, decision.delayTicks);
          actions.push({
            tick,
            type: "PLAY_CARD",
            actor: candidateActor,
            cardId: decision.action.cardId,
            x: decision.action.x,
            y: decision.action.y,
          });
        } else {
          stats.illegal_attempts += 1;
        }
      } else {
        stats.pass_decisions += 1;
      }
    }
    if (tick >= opponent.nextDecisionTick) {
      const legalActions = enumerateLegalCardActions({ engine, actor: opponentActor });
      const selected = selectBotAction({
        botId: opponentBotId,
        engine,
        actor: opponentActor,
        legalActions,
        rng: opponent.rng,
      });
      opponent.nextDecisionTick = tick + rollDecisionDelayTicks({
        botId: opponentBotId,
        rng: opponent.rng,
      });
      if (selected?.type === "PLAY_CARD") {
        actions.push({
          tick,
          type: "PLAY_CARD",
          actor: opponentActor,
          cardId: selected.cardId,
          x: selected.x,
          y: selected.y,
        });
      }
    }
    actionStream.push(...actions);
    playstyleBeforeStep(playstyle, engine, actions);
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
    playstyleAfterStep(playstyle, engine);
  }
  const result = engine.getMatchResult();
  if (!result) {
    throw new Error(`cadence match seed ${seed} did not finish within ${maxTicks} ticks`);
  }
  if (recordRows) {
    assignDecisionRewards({
      rows,
      finalPotential: terminalPotentialForActor(engine, candidateActor, rewardVersion),
      result,
      actor: candidateActor,
    });
  }

  const played = engine.state.replay.events.filter(
    (event) => event.type === "card_played" && event.actor === candidateActor,
  );
  const opponentPlayed = engine.state.replay.events.filter(
    (event) => event.type === "card_played" && event.actor === opponentActor,
  );
  const realizedIntervals = {};
  for (let index = 0; index + 1 < decisionTicks.length; index += 1) {
    histogramAdd(realizedIntervals, decisionTicks[index + 1] - decisionTicks[index]);
  }
  const deploymentIntervals = {};
  for (let index = 0; index + 1 < played.length; index += 1) {
    histogramAdd(deploymentIntervals, played[index + 1].tick - played[index].tick);
  }
  const deploymentsByCard = {};
  for (const event of played) {
    histogramAdd(deploymentsByCard, event.card_id);
  }
  const candidatePoint = result.winner === null
    ? 0.5
    : result.winner === candidateActor ? 1 : 0;
  return {
    seed,
    candidate_actor: candidateActor,
    cadence,
    opponent: opponentBotId,
    mode,
    winner: result.winner,
    reason: result.reason,
    candidate_point: candidatePoint,
    tick: result.tick,
    score: result.score,
    stats: {
      ...stats,
      inference_ms: Math.round(stats.inference_ms * 1000) / 1000,
      decision_ticks_first: decisionTicks[0] ?? null,
      successful_deployments: played.length,
      opponent_deployments: opponentPlayed.length,
      first_deployment_tick: played[0]?.tick ?? null,
      realized_interval_histogram: realizedIntervals,
      deployment_interval_histogram: deploymentIntervals,
      deployments_by_card: deploymentsByCard,
      playstyle_diagnostics: finishPlaystyle(playstyle),
    },
    action_stream_hash: actionStreamHash(actionStream),
    final_state_hash: engine.getStateHash(),
    rows: recordRows ? rows : null,
    probes: probeStride > 0 ? probes : null,
    replay: returnReplay
      ? {
          initial_card_state: initialCardState,
          actions: engine.state.replay.actions,
          events: engine.state.replay.events,
          result,
        }
      : null,
  };
}

// Compact little-endian binary trajectory: a JSON header describing typed
// arrays in one .bin file. Boards are stored sparse (index, float32 value);
// observations are Float32Array in the runtime, so float32 is lossless.
const ARRAY_SPECS = Object.freeze([
  ["tick", Int32Array, (row) => [row.tick]],
  ["card_index", Int16Array, (row) => [row.card_index]],
  ["placement_index", Int16Array, (row) => [row.placement_index]],
  ["delay_index", Int16Array, (row) => [row.delay_index]],
  ["delay_ticks", Int16Array, (row) => [row.delay_ticks]],
  ["reward", Float64Array, (row) => [row.reward]],
  ["discounted_return", Float64Array, (row) => [row.discounted_return]],
  ["behavior_log_probability", Float64Array, (row) => [row.behavior_log_probability ?? NaN]],
  ["behavior_card_log_probability", Float64Array, (row) => [row.behavior_card_log_probability ?? NaN]],
  ["behavior_placement_log_probability", Float64Array, (row) => [row.behavior_placement_log_probability ?? NaN]],
  ["behavior_delay_log_probability", Float64Array, (row) => [row.behavior_delay_log_probability ?? NaN]],
  ["global", Float32Array, (row) => row.global],
  ["card_mask", Uint8Array, (row) => row.card_mask],
]);

function concatTyped(ArrayType, chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new ArrayType(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function offsetsFor(rows, key) {
  const offsets = new Int32Array(rows.length + 1);
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index] + rows[index][key].length;
  }
  return offsets;
}

export function encodeCadenceEpisode({ rows, meta, rewardVersion = EDGER_V2_CADENCE_REWARD_VERSION }) {
  assertRewardVersion(rewardVersion);
  for (const row of rows) {
    if (row.global.length !== EDGER_V2_GLOBAL_FEATURES || row.card_mask.length !== EDGER_V2_CARD_ACTIONS.length) {
      throw new Error("cadence row has the wrong global/card-mask width");
    }
    if (row.delay_ticks < 1 || row.delay_ticks > EDGER_V2_DELAY_BINS) {
      throw new Error("cadence row delay_ticks out of range");
    }
  }
  const arrays = ARRAY_SPECS.map(([name, ArrayType, pick]) => [
    name,
    concatTyped(ArrayType, rows.map((row) => pick(row))),
  ]);
  arrays.push(["board_offsets", offsetsFor(rows, "board_indices")]);
  arrays.push(["board_indices", Uint16Array.from(rows.flatMap((row) => row.board_indices))]);
  arrays.push(["board_values", Float32Array.from(rows.flatMap((row) => row.board_values))]);
  arrays.push(["placement_offsets", offsetsFor(rows, "placement_legal")]);
  arrays.push(["placement_indices", Uint16Array.from(rows.flatMap((row) => row.placement_legal))]);

  const layout = {};
  let offset = 0;
  const parts = [];
  for (const [name, typed] of arrays) {
    const padding = (8 - (offset % 8)) % 8;
    if (padding) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    layout[name] = {
      dtype: typed.constructor.name,
      offset,
      length: typed.length,
    };
    parts.push(bytes);
    offset += bytes.length;
  }
  const body = Buffer.concat(parts);
  const header = {
    schema_version: EDGER_V2_CADENCE_EPISODE_SCHEMA,
    rows: rows.length,
    board_size: EDGER_V2_BOARD_SIZE,
    placements: PLACEMENTS,
    global_features: EDGER_V2_GLOBAL_FEATURES,
    card_actions: EDGER_V2_CARD_ACTIONS.length,
    delay_bins: EDGER_V2_DELAY_BINS,
    per_tick_gamma: EDGER_V2_CADENCE_PER_TICK_GAMMA,
    reward_version: rewardVersion,
    little_endian: true,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    arrays: layout,
    ...meta,
  };
  return { header, body };
}

// Deterministic seed list from a label, independent of the LCG streams used by
// the frozen suites, with explicit exclusions.
export function deriveLabelledSeeds({ label, count, exclude = new Set() }) {
  const seeds = [];
  for (let index = 0; seeds.length < count; index += 1) {
    const digest = createHash("sha256").update(`${label}|${index}`).digest();
    const seed = 1 + (digest.readUInt32BE(0) % 2_000_000_000);
    if (!exclude.has(seed) && !seeds.includes(seed)) {
      seeds.push(seed);
    }
  }
  return seeds;
}

export function lcgSeedPrefix(seed, count) {
  const rng = createRng(seed);
  const seeds = new Set();
  for (let index = 0; index < count; index += 1) {
    seeds.add(1 + Math.floor(rng() * 2_000_000_000));
  }
  return seeds;
}
