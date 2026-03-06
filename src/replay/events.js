export function createKnockbackReplayEvent({ tick, source_spell, target_entity, vector, ticks }) {
  return {
    type: "knockback_applied",
    tick,
    source_spell,
    target_entity,
    vector: {
      x: Math.round(vector.x * 10000) / 10000,
      y: Math.round(vector.y * 10000) / 10000,
    },
    ticks,
  };
}
