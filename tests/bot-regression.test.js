import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark, runLadderMatch } from "../src/ai/benchmark.js";

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
