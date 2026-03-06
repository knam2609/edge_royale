import { getElixirRegenTicks } from "./config.js";

export class ElixirTracker {
  constructor({ initial = 5, max = 10 } = {}) {
    this.elixir = initial;
    this.max = max;
    this.regenAccumulatorTicks = 0;
  }

  spend(amount) {
    if (amount <= 0) {
      return true;
    }
    if (this.elixir < amount) {
      return false;
    }

    this.elixir -= amount;
    return true;
  }

  tick(phase) {
    if (this.elixir >= this.max) {
      this.regenAccumulatorTicks = 0;
      return this.elixir;
    }

    this.regenAccumulatorTicks += 1;
    const regenTicks = getElixirRegenTicks(phase);

    while (this.regenAccumulatorTicks >= regenTicks && this.elixir < this.max) {
      this.regenAccumulatorTicks -= regenTicks;
      this.elixir += 1;
    }

    return this.elixir;
  }
}

export function runElixirTimeline({
  totalTicks,
  phaseForTick,
  spendByTick = new Map(),
  initialElixir = 5,
  maxElixir = 10,
}) {
  const tracker = new ElixirTracker({ initial: initialElixir, max: maxElixir });
  const snapshots = [];

  for (let tick = 1; tick <= totalTicks; tick += 1) {
    const spendAmount = spendByTick.get(tick) ?? 0;
    if (spendAmount > 0) {
      tracker.spend(spendAmount);
    }

    tracker.tick(phaseForTick(tick));
    snapshots.push({ tick, elixir: tracker.elixir });
  }

  return snapshots;
}
