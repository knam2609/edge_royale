// Playstyle diagnostics for cadence matches (descriptive only).
//
// Schema edger_v2_playstyle_diagnostics_v1, defined on November 11, 2026,
// before the fifth comparison (reward v2 against v1; docs/EDGER_REWARD.md).
// They describe how the candidate plays. They are not exclusion, stopping or
// promotion thresholds, and computing them never changes a game: the tracker
// only reads engine state and the replay events. Population: the candidate
// side of each game.
//
// - Wasted elixir: on every tick the candidate starts at the elixir cap, that
//   tick's regeneration is lost (the engine resets the regen accumulator at
//   the cap): 1/56 elixir in normal time, 1/28 in double elixir, 1/20 in
//   overtime. These are the ticks counted by full_elixir_ticks.
// - Counter responses: a threat is an opponent card_played event of a troop
//   in the frozen counter table (EDGER_REWARD_V2_COUNTERS). Its response is
//   the best class among the candidate's card_played events at the following
//   100 ticks (5 s), later ticks only: strong counter, partial counter, other
//   card, or none. Cards only; the lane is not checked. A threat whose window
//   ends after the game's last tick is censored and left out of the counts.
//   "Strong counter in hand": the candidate's hand at the end of the threat's
//   tick holds a strong counter, at any elixir. The response delay runs from
//   the threat to the first strong or partial counter.
// - Giant plays into an answer: for each candidate Giant card_played event,
//   the opponent's hand and elixir at the decision, the state before the
//   step. An affordable strong answer is a strong Giant counter in hand with
//   elixir >= its cost; an affordable answer also counts partial counters.
//   The counter credit is R's rule (counterCredit).
// - Checkpoints: the candidate's v2 potential parts (potentialForActor: ours
//   - theirs, material before the phase factor, R at weight 0 but reported)
//   after the step that ends tick 1200 (60 s) or 2400 (120 s), if the game is
//   still in progress. This is the checkpoint convention of the reward data
//   checks RC and RC2.

import { ELIXIR_REGEN_TICKS, TICK_RATE, getMatchPhase } from "../src/sim/config.js";
import { CARD_STATS } from "../src/sim/stats.js";
import {
  EDGER_REWARD_V2_COUNTERS,
  EDGER_REWARD_VERSIONS,
  counterCredit,
  potentialForActor,
} from "./edger-reward-core.mjs";

export const EDGER_V2_PLAYSTYLE_DIAGNOSTICS_SCHEMA = "edger_v2_playstyle_diagnostics_v1";
export const PLAYSTYLE_RESPONSE_WINDOW_TICKS = 5 * TICK_RATE;
export const PLAYSTYLE_CHECKPOINT_TICKS = Object.freeze({ "60s": 60 * TICK_RATE, "120s": 120 * TICK_RATE });
export const PLAYSTYLE_CHECKPOINT_TERMS = Object.freeze([
  "v1", "phase_factor", "material", "threat", "readiness", "support", "position", "total",
]);
export const PLAYSTYLE_RESPONSE_CLASSES = Object.freeze(["strong", "partial", "other", "none"]);

const RESPONSE_RANK = Object.freeze({ none: 0, other: 1, partial: 2, strong: 3 });
const PHASES = Object.freeze(["normal", "double", "overtime"]);

export function responseClass(threatCardId, cardId) {
  const counters = EDGER_REWARD_V2_COUNTERS[threatCardId];
  if (counters.strong.includes(cardId)) {
    return "strong";
  }
  return counters.partial.includes(cardId) ? "partial" : "other";
}

export function emptyResponseCounts() {
  return { threats: 0, strong: 0, partial: 0, other: 0, none: 0 };
}

export function emptyPlaystyleStats() {
  return {
    capped_ticks: { normal: 0, double: 0, overtime: 0 },
    wasted_elixir: 0,
    counter_responses: {
      ...emptyResponseCounts(),
      censored: 0,
      counter_delay_ticks_sum: 0,
      strong_counter_in_hand: emptyResponseCounts(),
      by_threat_card: {},
    },
    giant_plays: {
      plays: 0,
      into_affordable_strong_answer: 0,
      into_affordable_answer: 0,
      opponent_counter_credit_sum: 0,
    },
    checkpoints: { "60s": null, "120s": null },
  };
}

export function wastedElixir(cappedTicks) {
  return PHASES.reduce((total, phase) => total + cappedTicks[phase] / ELIXIR_REGEN_TICKS[phase], 0);
}

export function createPlaystyleTracker(candidateActor) {
  return {
    candidate: candidateActor,
    opponent: candidateActor === "blue" ? "red" : "blue",
    stats: emptyPlaystyleStats(),
    eventCursor: 0,
    open: [],
    giantContext: null,
  };
}

function hasAffordable(context, cardIds) {
  return cardIds.some((cardId) => context.hand.includes(cardId) && context.elixir >= CARD_STATS[cardId].cost);
}

function recordGiantPlay(stats, context) {
  const counters = EDGER_REWARD_V2_COUNTERS.giant;
  const strong = hasAffordable(context, counters.strong);
  stats.plays += 1;
  if (strong) {
    stats.into_affordable_strong_answer += 1;
  }
  if (strong || hasAffordable(context, counters.partial)) {
    stats.into_affordable_answer += 1;
  }
  stats.opponent_counter_credit_sum += counterCredit(context, "giant");
}

function addResponse(counts, best) {
  counts.threats += 1;
  counts[best] += 1;
}

function closeThreat(counts, threat) {
  addResponse(counts, threat.best);
  if (threat.strongInHand) {
    addResponse(counts.strong_counter_in_hand, threat.best);
  }
  counts.by_threat_card[threat.card] ??= emptyResponseCounts();
  addResponse(counts.by_threat_card[threat.card], threat.best);
  if (threat.best === "strong" || threat.best === "partial") {
    counts.counter_delay_ticks_sum += threat.counterDelay;
  }
}

// Call with the tick's actions immediately before engine.step(actions).
export function playstyleBeforeStep(tracker, engine, actions) {
  const state = engine.state;
  const elixir = state.elixir[tracker.candidate];
  if (elixir.elixir >= elixir.max) {
    // The phase engine.step uses for this tick's regeneration.
    tracker.stats.capped_ticks[getMatchPhase({ tick: state.tick + 1, isOvertime: state.isOvertime })] += 1;
  }
  const playsGiant = actions.some((action) =>
    action.type === "PLAY_CARD" && action.actor === tracker.candidate && action.cardId === "giant");
  tracker.giantContext = playsGiant
    ? {
        tick: state.tick + 1,
        hand: engine.getHand(tracker.opponent),
        nextInQueue: engine.getDeckQueue(tracker.opponent)[0] ?? null,
        elixir: state.elixir[tracker.opponent].elixir,
      }
    : null;
}

// Call after engine.step and the overtime check of the same tick.
export function playstyleAfterStep(tracker, engine) {
  const state = engine.state;
  const events = state.replay.events;
  const counts = tracker.stats.counter_responses;
  let candidateHand = null;
  for (; tracker.eventCursor < events.length; tracker.eventCursor += 1) {
    const event = events[tracker.eventCursor];
    if (event.type !== "card_played") {
      continue;
    }
    if (event.actor === tracker.candidate) {
      for (const threat of tracker.open) {
        if (event.tick <= threat.tick) {
          continue;
        }
        const kind = responseClass(threat.card, event.card_id);
        if (RESPONSE_RANK[kind] > RESPONSE_RANK[threat.best]) {
          threat.best = kind;
        }
        if (kind !== "other" && threat.counterDelay === null) {
          threat.counterDelay = event.tick - threat.tick;
        }
      }
      if (event.card_id === "giant") {
        if (tracker.giantContext?.tick !== event.tick) {
          throw new Error(`playstyle diagnostics missed the decision state of the Giant played at tick ${event.tick}`);
        }
        recordGiantPlay(tracker.stats.giant_plays, tracker.giantContext);
      }
    } else if (EDGER_REWARD_V2_COUNTERS[event.card_id]) {
      candidateHand ??= engine.getHand(tracker.candidate);
      tracker.open.push({
        tick: event.tick,
        card: event.card_id,
        strongInHand: EDGER_REWARD_V2_COUNTERS[event.card_id].strong.some((cardId) => candidateHand.includes(cardId)),
        best: "none",
        counterDelay: null,
      });
    }
  }
  tracker.giantContext = null;
  tracker.open = tracker.open.filter((threat) => {
    if (state.tick < threat.tick + PLAYSTYLE_RESPONSE_WINDOW_TICKS) {
      return true;
    }
    closeThreat(counts, threat);
    return false;
  });
  if (!engine.getMatchResult()) {
    for (const [label, tick] of Object.entries(PLAYSTYLE_CHECKPOINT_TICKS)) {
      if (state.tick === tick) {
        const parts = potentialForActor(engine, tracker.candidate, EDGER_REWARD_VERSIONS.V2);
        tracker.stats.checkpoints[label] = Object.fromEntries(PLAYSTYLE_CHECKPOINT_TERMS.map((key) => [key, parts[key]]));
      }
    }
  }
}

// The per-game statistics, once the match has ended. Threats whose window
// was still open are censored.
export function finishPlaystyle(tracker) {
  const stats = tracker.stats;
  stats.counter_responses.censored += tracker.open.length;
  tracker.open = [];
  stats.wasted_elixir = wastedElixir(stats.capped_ticks);
  stats.counter_responses.by_threat_card = Object.fromEntries(
    Object.entries(stats.counter_responses.by_threat_card).sort(([left], [right]) => left.localeCompare(right)),
  );
  return stats;
}
