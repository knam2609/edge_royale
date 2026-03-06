import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark } from "../src/ai/benchmark.js";
import { midBot } from "../src/ai/midBot.js";
import { noobBot } from "../src/ai/noobBot.js";
import { evaluateFireballValue } from "../src/ai/spellHeuristics.js";
import { topBot } from "../src/ai/topBot.js";

test("tier ordering holds after overtime 3x and knockback value update", () => {
  const topVsMid = runBenchmark({
    botA: topBot,
    botB: midBot,
    evaluateFireballValue,
    seed: 404,
    rounds: 700,
  });

  const midVsNoob = runBenchmark({
    botA: midBot,
    botB: noobBot,
    evaluateFireballValue,
    seed: 707,
    rounds: 700,
  });

  assert.ok(topVsMid.winRateA >= 0.65, `Top vs Mid win rate too low: ${topVsMid.winRateA}`);
  assert.ok(midVsNoob.winRateA >= 0.7, `Mid vs Noob win rate too low: ${midVsNoob.winRateA}`);
});
