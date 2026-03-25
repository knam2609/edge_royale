export function getSpellDamageAgainstTarget(target, { troopDamage, towerDamage }) {
  return target.entity_type === "tower" ? towerDamage : troopDamage;
}

export function computeDamageScore(targets, { troopDamage, towerDamage }) {
  return targets.reduce((sum, target) => {
    const damage = getSpellDamageAgainstTarget(target, { troopDamage, towerDamage });
    return sum + Math.min(target.hp, damage);
  }, 0);
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

export function evaluateFireballValue({ targets, troopDamage, towerDamage, knockbackDistanceTiles, impactY }) {
  const damageScore = computeDamageScore(targets, { troopDamage, towerDamage });
  const knockbackScore = computeKnockbackScore({ targets, knockbackDistanceTiles, impactY });
  return damageScore + knockbackScore;
}
