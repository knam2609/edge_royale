import { EDGER_BOT_ID, HEURISTIC_BOT_ID } from "../src/ai/botRuntime.js";
import { createRng } from "../src/sim/random.js";

// Critic stratum recorded for a league opponent.
//
// Model opponents (the champion, historical snapshots and contenders) are all
// Edger policies, so they share the base corpus's `edger` stratum. Their
// policy and checkpoint ids stay in the episode's `policies` provenance. Bot
// opponents keep their bot id, as in the base corpus. Before November 20,
// 2026 model opponents recorded their model id here, which is missing from
// every parent vocabulary and fell back to stratum index 0 (`aggressive`).
export const LEAGUE_MODEL_OPPONENT_STRATUM = EDGER_BOT_ID;

export function leagueOpponentStratum(opponent) {
  if (opponent?.kind === "model") {
    return LEAGUE_MODEL_OPPONENT_STRATUM;
  }
  if (opponent?.kind === "bot" && typeof opponent.policy_id === "string" && opponent.policy_id) {
    return opponent.policy_id;
  }
  throw new Error(`league opponent needs kind "model" or "bot" with a policy_id: ${JSON.stringify(opponent)}`);
}

function weightedChoice(items, weights, rng) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      return items[index];
    }
  }
  return items.at(-1);
}

function selectOpponent(league, rng) {
  const allocation = rng();
  if (allocation < 0.4) {
    return { bucket: "champion", opponent: league.champion };
  }
  if (allocation < 0.6) {
    return {
      bucket: "heuristic",
      opponent: {
        kind: "bot",
        policy_id: HEURISTIC_BOT_ID,
        checkpoint_id: null,
        league_rating: null,
      },
    };
  }
  if (allocation < 0.8) {
    const pool = league.historical.length > 0 ? league.historical : [league.champion];
    return {
      bucket: "historical_uniform",
      opponent: pool[Math.floor(rng() * pool.length)],
    };
  }
  const pool = [...league.historical, ...league.contenders];
  const candidates = pool.length > 0 ? pool : [league.champion];
  const weights = candidates.map(
    (snapshot) => (1 - snapshot.score) ** 2 + 0.05,
  );
  return {
    bucket: "pfsp",
    opponent: weightedChoice(candidates, weights, rng),
  };
}

export function makeMatchSpecs({ matches, seed, league }) {
  const rng = createRng(seed);
  const specs = [];
  for (let pairIndex = 0; pairIndex < matches / 2; pairIndex += 1) {
    const matchSeed = 1 + Math.floor(rng() * 2_000_000_000);
    const selection = selectOpponent(league, rng);
    for (const mainActor of ["blue", "red"]) {
      specs.push({
        match_index: specs.length,
        pair_index: pairIndex,
        seed: matchSeed,
        main_actor: mainActor,
        allocation_bucket: selection.bucket,
        opponent: selection.opponent,
      });
    }
  }
  return specs;
}
