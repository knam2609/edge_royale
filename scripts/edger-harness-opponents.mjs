// What the bare `edger` bot id plays in the training-data harnesses (owner
// decision, November 28, 2026; docs/EDGER_HARNESS_REVIEW.md).
//
// The cadence tooling (train-arm, evaluate, probe, convert-collection and the
// Fireball branch sets) and corpus collection play the retired v1 bootstrap,
// which was live Edger when every recorded seed plan, comparison, the
// candidate campaign and the base corpus were produced. It plays through
// selectBotAction with the legacy shortlist and BOT_CONFIG's one-tick delay,
// exactly as it did while live, so those records reproduce at later commits.
//
// The shipped bot (src/ai/generated/edgerPolicyCurrent.js) is deliberately not
// used here: a recipe that trains or selects against it passes it as a model
// opponent (`--opponent-model`, or the snapshot-league mix), which plays it on
// its own learned cadence. The AGENTS.md benchmark gate plays the shipped bot
// on its live path instead (src/ai/benchmark.js).
import { EDGER_POLICY_MODEL } from "../artifacts/edger-training/retired/edger_policy_bootstrap_20260701/edgerPolicyCurrent.js";

export const EDGER_RETIRED_V1_MODEL = EDGER_POLICY_MODEL;
