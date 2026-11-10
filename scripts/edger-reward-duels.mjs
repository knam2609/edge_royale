#!/usr/bin/env node
// Counter duels for the reward v2 answer-readiness table (training-only
// tooling; docs/EDGER_REWARD.md). Each duel plays real PLAY_CARD actions on the
// production engine: red pushes one lane with a threat card and blue answers
// with one card. Towers fight as usual. The output is advisory: the owner
// reviews it before the counter table in edger-reward-core.mjs is frozen.
//
// Rules, fixed before the first run (November 10, 2026):
// - Scenarios: `lone` (the threat alone, for all six troops) and
//   `giant_support` (Musketeer or Archers two tiles behind a red Giant).
// - Variants: 2 lanes x 2 response times (when the first red unit crosses the
//   river, and 1.5 s later). Each variant tries every placement the bots can
//   use (for troops, every legal candidate from enumerateLegalCardActions:
//   today the three bridge-front cells and the back-center cell; spells aim
//   at the threat with 0, 0.5 or 1 times the predicted lead) and keeps the one
//   with the highest net.
// - net = elixir of red troops destroyed - elixir blue lost (a spell's full
//   cost, a troop's lost HP share) - blue tower HP lost / 400. A duel ends when
//   every red troop is dead, or 40 s after the later response time.
// - value = net - net with no answer, in the same scenario and lane.
// - stopped = every unit of the threat card is dead when the duel ends.
// - strong: stopped in 4/4 variants and median value >= +1 elixir;
//   partial: stopped in >= 3/4 and median value >= 0; otherwise none.

import fs from "node:fs";
import path from "node:path";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import { TICK_RATE } from "../src/sim/config.js";
import { ROYALE_LANE_X, ROYALE_TOWER_X, ROYALE_TOWER_Y } from "../src/sim/map.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { CARD_STATS } from "../src/sim/stats.js";

export const DUEL_SCHEMA = "edger_reward_duels_v1";
// The owner's draft table the duels were run against (November 10, 2026).
// The frozen table lives in edger-reward-core.mjs.
const DRAFT_COUNTERS = Object.freeze({
  giant: { strong: ["mini_pekka"], partial: ["musketeer", "goblins"] },
  musketeer: { strong: ["fireball"], partial: ["mini_pekka", "knight"] },
  mini_pekka: { strong: ["goblins", "knight"], partial: ["archers"] },
  archers: { strong: ["arrows"], partial: ["fireball", "knight"] },
  goblins: { strong: ["arrows"], partial: ["musketeer", "knight"] },
  knight: { strong: ["mini_pekka"], partial: ["goblins"] },
});
export const DUEL_SEED = 20261110;
const RIVER_Y = 16;
const LATE_RESPONSE_TICKS = 30;
const HORIZON_TICKS = 40 * TICK_RATE;
const TOWER_HP_PER_ELIXIR = 400;
const SPELL_LEADS = Object.freeze([0, 0.5, 1]);
export const DUEL_THREATS = Object.freeze(["giant", "musketeer", "mini_pekka", "archers", "goblins", "knight"]);
export const DUEL_RESPONDERS = Object.freeze([...DEFAULT_DECK]);
export const DUEL_SCENARIOS = Object.freeze({
  lone: DUEL_THREATS,
  giant_support: Object.freeze(["musketeer", "archers"]),
});
const LANES = Object.freeze(["left", "right"]);
const TIMINGS = Object.freeze({ river: 0, late: LATE_RESPONSE_TICKS });

function unitCost(cardId) {
  return CARD_STATS[cardId].cost / (CARD_STATS[cardId].spawn_count ?? 1);
}

function alive(engine, team, cardId = null) {
  return engine.state.entities.filter((entity) =>
    entity.entity_type === "troop" && entity.team === team && entity.hp > 0 &&
    (cardId === null || entity.cardId === cardId));
}

function boardElixir(engine, team) {
  return alive(engine, team).reduce((sum, troop) => sum + unitCost(troop.cardId) * troop.hp / troop.maxHp, 0);
}

function cardState(handCard, extra = []) {
  const first = [handCard, ...extra];
  const rest = DEFAULT_DECK.filter((cardId) => !first.includes(cardId));
  const hand = [...first, ...rest].slice(0, 4);
  return { hand, draw_pile: DEFAULT_DECK.filter((cardId) => !hand.includes(cardId)) };
}

function nearestLegal(engine, actor, cardId, x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const action of enumerateLegalCardActions({ engine, actor })) {
    if (action.cardId !== cardId) {
      continue;
    }
    const distance = (action.x - x) ** 2 + (action.y - y) ** 2;
    if (distance < bestDistance) {
      best = action;
      bestDistance = distance;
    }
  }
  if (!best) {
    throw new Error(`no legal ${actor} placement for ${cardId}`);
  }
  return best;
}

function play(engine, actor, action) {
  const before = engine.state.elixir[actor].elixir;
  engine.step([{ tick: engine.state.tick + 1, type: "PLAY_CARD", actor, cardId: action.cardId, x: action.x, y: action.y }]);
  if (engine.state.elixir[actor].elixir >= before) {
    throw new Error(`${actor} ${action.cardId} at (${action.x}, ${action.y}) was not played`);
  }
}

// Where to aim a spell: the threat's centroid, led along its velocity.
function spellAim(engine, cardId, threatCardId, lead) {
  const units = alive(engine, "red", threatCardId);
  const centroid = units.reduce((sum, unit) => ({
    x: sum.x + unit.x / units.length,
    y: sum.y + unit.y / units.length,
    vx: sum.vx + (unit.velocity?.x ?? 0) / units.length,
    vy: sum.vy + (unit.velocity?.y ?? 0) / units.length,
  }), { x: 0, y: 0, vx: 0, vy: 0 });
  const spell = CARD_STATS[cardId];
  let flightTicks = spell.cast_delay_ticks ?? 0;
  if (spell.travel_speed_tiles_per_second) {
    const distance = Math.hypot(centroid.x - ROYALE_TOWER_X.center, centroid.y - ROYALE_TOWER_Y.blue.king);
    flightTicks += (distance / spell.travel_speed_tiles_per_second) * TICK_RATE;
  }
  return { x: centroid.x + centroid.vx * flightTicks * lead, y: centroid.y + centroid.vy * flightTicks * lead };
}

function legalActionsFor(engine, actor, cardId) {
  return enumerateLegalCardActions({ engine, actor }).filter((action) => action.cardId === cardId);
}

// Returns null when `placement` is past the last legal troop placement.
export function runDuel({ scenario, threat, responder = null, lane, timing = "river", placement = 0 }) {
  const redCards = scenario === "giant_support" ? ["giant", threat] : [threat];
  const engine = createProductionEngine({
    seed: DUEL_SEED,
    initialCardState: {
      blue: cardState(responder ?? "arrows"),
      red: cardState(threat, redCards.filter((cardId) => cardId !== threat)),
    },
  });
  engine.state.elixir.blue.elixir = 10;
  engine.state.elixir.red.elixir = 10;
  const laneX = ROYALE_LANE_X[lane];
  const startTowerHp = engine.getScore().blue_tower_hp;
  if (scenario === "giant_support") {
    // Scenario setup, not a bot choice: any legal cell on red's side.
    play(engine, "red", { cardId: "giant", x: laneX, y: 14 });
    play(engine, "red", { cardId: threat, x: laneX, y: 10 });
  } else {
    play(engine, "red", { cardId: threat, x: laneX, y: 14 });
  }
  const redPlayed = redCards.reduce((sum, cardId) => sum + CARD_STATS[cardId].cost, 0);

  // Wait for the first red unit to cross the river.
  while (!alive(engine, "red").some((unit) => unit.y >= RIVER_Y)) {
    if (engine.state.tick > 40 * TICK_RATE) {
      throw new Error(`${threat} never crossed the river`);
    }
    engine.step([]);
  }
  const crossedTick = engine.state.tick;
  const responseTick = crossedTick + TIMINGS[timing];
  while (engine.state.tick < responseTick) {
    engine.step([]);
  }
  let blueSpent = 0;
  let aim = null;
  if (responder) {
    const card = CARD_STATS[responder];
    let action;
    if (card.type === "spell") {
      if (placement >= SPELL_LEADS.length) {
        return null;
      }
      const target = spellAim(engine, responder, threat, SPELL_LEADS[placement]);
      action = nearestLegal(engine, "blue", responder, target.x, target.y);
    } else {
      action = legalActionsFor(engine, "blue", responder)[placement];
      if (!action) {
        return null;
      }
    }
    aim = { x: action.x, y: action.y };
    play(engine, "blue", action);
    blueSpent = card.cost;
  }
  const endTick = crossedTick + LATE_RESPONSE_TICKS + HORIZON_TICKS;
  while (
    engine.state.tick < endTick &&
    !engine.getMatchResult() &&
    (alive(engine, "red").length > 0 || engine.state.pending_effects.length > 0)
  ) {
    engine.step([]);
  }
  const destroyed = redPlayed - boardElixir(engine, "red");
  const blueLoss = blueSpent - boardElixir(engine, "blue");
  const towerLost = startTowerHp - engine.getScore().blue_tower_hp;
  return {
    scenario,
    threat,
    responder,
    lane,
    timing: responder ? timing : null,
    placement: responder ? placement : null,
    aim,
    crossed_tick: crossedTick,
    end_tick: engine.state.tick,
    stopped: alive(engine, "red", threat).length === 0,
    red_elixir_destroyed: destroyed,
    blue_elixir_lost: blueLoss,
    blue_tower_hp_lost: towerLost,
    net: destroyed - blueLoss - towerLost / TOWER_HP_PER_ELIXIR,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function labelFor({ stoppedCount, variants, medianValue }) {
  if (stoppedCount === variants && medianValue >= 1) {
    return "strong";
  }
  if (stoppedCount >= variants - 1 && medianValue >= 0) {
    return "partial";
  }
  return "none";
}

function draftLabel(threat, responder) {
  const counters = DRAFT_COUNTERS[threat];
  if (counters?.strong.includes(responder)) {
    return "strong";
  }
  return counters?.partial.includes(responder) ? "partial" : "none";
}

export function runCounterDuels() {
  const pairs = [];
  const baselines = [];
  for (const [scenario, threats] of Object.entries(DUEL_SCENARIOS)) {
    for (const threat of threats) {
      const none = Object.fromEntries(LANES.map((lane) => [lane, runDuel({ scenario, threat, lane })]));
      baselines.push({ scenario, threat, lanes: none, median_net: median(LANES.map((lane) => none[lane].net)) });
      for (const responder of DUEL_RESPONDERS) {
        const variants = [];
        for (const lane of LANES) {
          for (const timing of Object.keys(TIMINGS)) {
            const tries = [];
            for (let placement = 0; ; placement += 1) {
              const result = runDuel({ scenario, threat, responder, lane, timing, placement });
              if (!result) {
                break;
              }
              tries.push(result);
            }
            const best = tries.reduce((left, right) => (right.net > left.net ? right : left));
            variants.push({ ...best, value: best.net - none[lane].net });
          }
        }
        const stoppedCount = variants.filter((variant) => variant.stopped).length;
        const medianValue = median(variants.map((variant) => variant.value));
        const measured = labelFor({ stoppedCount, variants: variants.length, medianValue });
        pairs.push({
          scenario,
          threat,
          responder,
          stopped: `${stoppedCount}/${variants.length}`,
          median_value: medianValue,
          median_net: median(variants.map((variant) => variant.net)),
          median_tower_hp_lost: median(variants.map((variant) => variant.blue_tower_hp_lost)),
          measured_label: measured,
          draft_label: draftLabel(threat, responder),
          variants,
        });
      }
    }
  }
  return { schema_version: DUEL_SCHEMA, seed: DUEL_SEED, baselines, pairs };
}

const fmt = (value) => (value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1));

export function duelMarkdown(report) {
  const lines = ["# Counter duels (reward v2)", ""];
  lines.push("Value = median net elixir gained versus not answering (towers fight; tower HP at 400 per elixir).");
  lines.push("Label: S strong, P partial, - none. `draft→measured` where they differ.", "");
  for (const scenario of Object.keys(DUEL_SCENARIOS)) {
    lines.push(`## ${scenario}`, "");
    lines.push(`| Threat | no answer net | ${DUEL_RESPONDERS.join(" | ")} |`);
    lines.push(`|---|---|${DUEL_RESPONDERS.map(() => "---").join("|")}|`);
    const short = { strong: "S", partial: "P", none: "-" };
    for (const baseline of report.baselines.filter((item) => item.scenario === scenario)) {
      const cells = DUEL_RESPONDERS.map((responder) => {
        const pair = report.pairs.find((item) =>
          item.scenario === scenario && item.threat === baseline.threat && item.responder === responder);
        const label = pair.draft_label === pair.measured_label
          ? short[pair.measured_label]
          : `${short[pair.draft_label]}→${short[pair.measured_label]}`;
        return `${label} ${fmt(pair.median_value)} (${pair.stopped})`;
      });
      lines.push(`| ${baseline.threat} | ${fmt(baseline.median_net)} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : null;
  if (!outDir) {
    throw new Error("--out <directory> is required");
  }
  const report = runCounterDuels();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "duels.json"), `${JSON.stringify(report, null, 1)}\n`);
  const markdown = duelMarkdown(report);
  fs.writeFileSync(path.join(outDir, "duels.md"), markdown);
  process.stdout.write(markdown);
}
