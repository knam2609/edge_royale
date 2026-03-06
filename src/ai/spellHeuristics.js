export function computeDamageScore(targets, damage) {
  return targets.reduce((sum, target) => sum + Math.min(target.hp, damage), 0);
}

export function computeKnockbackScore({ targets, knockbackDistanceTiles, impactY }) {
  return targets.reduce((sum, target) => {
    if (target.entity_type !== "troop") {
      return sum;
    }

    // Troops closer to defender side (lower y) gain higher defensive pushback value.
    const lanePressureWeight = Math.max(0.5, 1.5 - (target.y - impactY) * 0.1);
    return sum + knockbackDistanceTiles * 100 * lanePressureWeight;
  }, 0);
}

export function evaluateFireballValue({ targets, damage, knockbackDistanceTiles, impactY }) {
  const damageScore = computeDamageScore(targets, damage);
  const knockbackScore = computeKnockbackScore({ targets, knockbackDistanceTiles, impactY });
  return damageScore + knockbackScore;
}
