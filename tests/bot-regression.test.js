import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark, runBenchmarkMatrix, runLadderMatch } from "../src/ai/benchmark.js";

const SMOKE_MAX_TICKS = 600;

test("ladder match smoke run returns structured score payload", () => {
  const match = runLadderMatch({
    blueTier: "mid",
    redTier: "noob",
    seed: 404,
    maxTicks: SMOKE_MAX_TICKS,
  });

  assert.ok(["blue", "red", null].includes(match.result?.winner ?? null));
  assert.ok(typeof match.tick === "number" && match.tick > 0);
  assert.ok(typeof match.score.blue_tower_hp === "number");
  assert.ok(typeof match.score.red_tower_hp === "number");
  assert.ok(match.tick <= SMOKE_MAX_TICKS);
});

test("benchmark output is deterministic for same seed and config", () => {
  const config = {
    botA: "top",
    botB: "mid",
    seed: 707,
    rounds: 2,
    maxTicks: SMOKE_MAX_TICKS,
  };

  const first = runBenchmark(config);
  const second = runBenchmark(config);

  assert.deepEqual(first, second);
  assert.equal(first.rounds, config.rounds);
  assert.equal(first.winsA + first.winsB + first.draws, config.rounds);
  assert.ok(first.resolved >= 0);
});

test("benchmark matrix is deterministic and enumerates pairwise tiers", () => {
  const config = {
    tiers: ["noob", "mid", "top"],
    seed: 202,
    roundsPerPair: 1,
    maxTicks: SMOKE_MAX_TICKS,
  };

  const first = runBenchmarkMatrix(config);
  const second = runBenchmarkMatrix(config);

  assert.deepEqual(first, second);
  assert.equal(first.pairs.length, 3);
  assert.ok(first.pairs.every((pair) => pair.rounds === config.roundsPerPair));
});

test("short benchmark smoke run preserves accounting invariants", () => {
  const result = runBenchmark({
    botA: "mid",
    botB: "noob",
    rounds: 2,
    seed: 202,
    maxTicks: SMOKE_MAX_TICKS,
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.winsA + result.winsB + result.draws, 2);
  assert.ok(result.resolved >= 0);
  assert.ok(result.winRateA >= 0 && result.winRateA <= 1);
});
