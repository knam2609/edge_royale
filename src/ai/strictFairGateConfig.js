export const STRICT_FAIR_GATE_VERSION = 1;
export const STRICT_FAIR_GATE_DEFAULT_SEED_BASE = 1909;
export const STRICT_FAIR_GATE_DEFAULT_BATCHES = 5;
export const STRICT_FAIR_GATE_DEFAULT_ROUNDS = 100;
export const STRICT_FAIR_GATE_DEFAULT_MAX_TICKS = 6040;

export const STRICT_FAIR_ADJACENT_PAIRS = Object.freeze([
  Object.freeze({ higher_tier: "mid", lower_tier: "noob" }),
  Object.freeze({ higher_tier: "top", lower_tier: "mid" }),
  Object.freeze({ higher_tier: "pro", lower_tier: "top" }),
  Object.freeze({ higher_tier: "goat", lower_tier: "pro" }),
]);

export function strictFairPairKey({ higher_tier, lower_tier }) {
  return `${higher_tier}>${lower_tier}`;
}

const PAIR_THRESHOLDS = Object.freeze({
  "mid>noob": Object.freeze({ min_win_rate: 0.72 }),
  "top>mid": Object.freeze({ min_win_rate: 0.67 }),
  "pro>top": Object.freeze({ min_win_rate: 0.52 }),
  "goat>pro": Object.freeze({ min_win_rate: 0.52 }),
});

export const STRICT_FAIR_GATE_THRESHOLDS = Object.freeze({
  version: STRICT_FAIR_GATE_VERSION,
  calibrated_at: "2026-05-09",
  calibration: Object.freeze({
    labels: Object.freeze(["checked_in_promoted_fair_models", "daily_run_25516896901_candidate"]),
    source_run_ids: Object.freeze(["25516896901"]),
    win_rate_headroom: 0.05,
    resolved_rate_headroom: 0.03,
    min_win_rate_floor: 0.52,
    min_resolved_rate_floor: 0.75,
  }),
  min_resolved_rate: 0.75,
  max_win_rate_stddev: 0.08,
  max_pair_regression: 0.05,
  max_resolved_rate_regression: 0.05,
  pair_thresholds: PAIR_THRESHOLDS,
});

export function getStrictFairPairThreshold(pair) {
  return STRICT_FAIR_GATE_THRESHOLDS.pair_thresholds[strictFairPairKey(pair)] ?? null;
}
