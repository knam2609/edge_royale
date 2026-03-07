import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark, runBenchmarkMatrix, runLadderMatch } from "../src/ai/benchmark.js";

test("ladder match resolves with match result payload", () => {
  const match = runLadderMatch({
    blueTier: "mid",
    redTier: "noob",
    seed: 404,
  });

  assert.ok(match.result);
  assert.ok(["blue", "red", null].includes(match.result.winner));
  assert.ok(typeof match.tick === "number" && match.tick > 0);
  assert.ok(typeof match.score.blue_tower_hp === "number");
  assert.ok(typeof match.score.red_tower_hp === "number");
});

test("benchmark output is deterministic for same seed and config", () => {
  const config = {
    botA: "top",
    botB: "mid",
    seed: 707,
    rounds: 24,
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
    tiers: ["noob", "mid", "top", "goat"],
    seed: 202,
    roundsPerPair: 12,
  };

  const first = runBenchmarkMatrix(config);
  const second = runBenchmarkMatrix(config);

  assert.deepEqual(first, second);
  assert.equal(first.pairs.length, 6);
  assert.ok(first.pairs.every((pair) => pair.rounds === config.roundsPerPair));
});

test("tier baseline keeps stronger presets ahead of low tiers", () => {
  const rounds = 80;
  const seed = 202;

  const midVsNoob = runBenchmark({ botA: "mid", botB: "noob", rounds, seed });
  const topVsNoob = runBenchmark({ botA: "top", botB: "noob", rounds, seed });
  const goatVsTop = runBenchmark({ botA: "goat", botB: "top", rounds, seed });

  assert.ok(midVsNoob.winRateA >= 0.6, `expected mid>noob baseline, got ${midVsNoob.winRateA.toFixed(3)}`);
  assert.ok(topVsNoob.winRateA >= 0.58, `expected top>noob baseline, got ${topVsNoob.winRateA.toFixed(3)}`);
  assert.ok(goatVsTop.winRateA >= 0.52, `expected goat>top baseline, got ${goatVsTop.winRateA.toFixed(3)}`);
});
