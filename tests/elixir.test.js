import test from "node:test";
import assert from "node:assert/strict";

import { ELIXIR_REGEN_TICKS } from "../src/sim/config.js";
import { ElixirTracker, runElixirTimeline } from "../src/sim/elixir.js";

test("elixir regen ticks are locked to 56/28/20", () => {
  assert.deepEqual(ELIXIR_REGEN_TICKS, {
    normal: 56,
    double: 28,
    overtime: 20,
  });
});

test("normal, double, and overtime grant exactly one elixir at configured intervals", () => {
  const normal = new ElixirTracker({ initial: 0, max: 99 });
  for (let i = 0; i < 55; i += 1) {
    normal.tick("normal");
  }
  assert.equal(normal.elixir, 0);
  normal.tick("normal");
  assert.equal(normal.elixir, 1);

  const doubled = new ElixirTracker({ initial: 0, max: 99 });
  for (let i = 0; i < 27; i += 1) {
    doubled.tick("double");
  }
  assert.equal(doubled.elixir, 0);
  doubled.tick("double");
  assert.equal(doubled.elixir, 1);

  const overtime = new ElixirTracker({ initial: 0, max: 99 });
  for (let i = 0; i < 19; i += 1) {
    overtime.tick("overtime");
  }
  assert.equal(overtime.elixir, 0);
  overtime.tick("overtime");
  assert.equal(overtime.elixir, 1);
});

test("overtime timeline respects cap and spend interactions over full 120 seconds", () => {
  const spendByTick = new Map([
    [200, 4],
    [800, 4],
    [1600, 4],
  ]);

  const snapshots = runElixirTimeline({
    totalTicks: 120 * 20,
    phaseForTick: () => "overtime",
    spendByTick,
    initialElixir: 5,
    maxElixir: 10,
  });

  const byTick = new Map(snapshots.map((entry) => [entry.tick, entry.elixir]));

  assert.equal(byTick.get(220), 7);
  assert.equal(byTick.get(240), 8);
  assert.equal(byTick.get(260), 9);
  assert.equal(byTick.get(280), 10);

  assert.equal(byTick.get(820), 7);
  assert.equal(byTick.get(1600), 6);
  assert.equal(byTick.get(2400), 10);

  for (const { elixir } of snapshots) {
    assert.ok(elixir >= 0 && elixir <= 10);
  }
});
