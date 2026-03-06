import { createKnockbackReplayEvent } from "../replay/events.js";
import { clampPositionToArenaAndPathable } from "./map.js";

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isInImpactRadius(entity, center, radiusTiles) {
  return squaredDistance(entity, center) <= radiusTiles * radiusTiles;
}

function isEligibleForFireballKnockback(entity, immuneIds) {
  if (entity.entity_type !== "troop") {
    return false;
  }
  if (entity.hp <= 0) {
    return false;
  }
  return !immuneIds.includes(entity.cardId);
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length === 0) {
    return { x: 0, y: 1 };
  }

  return { x: x / length, y: y / length };
}

export function resolveFireballImpact({
  tick,
  impactX,
  impactY,
  entities,
  arena,
  sourceSpell,
  fireballConfig,
}) {
  const center = { x: impactX, y: impactY };
  const impacted = [];

  // 1) Impact detection
  for (const entity of entities) {
    if (isInImpactRadius(entity, center, fireballConfig.radius_tiles)) {
      impacted.push(entity);
    }
  }

  // 2) Damage
  for (const entity of impacted) {
    entity.hp = Math.max(0, entity.hp - fireballConfig.damage);
  }

  // 3) Knockback eligibility filter + 4) Displacement assignment
  const knockbackEvents = [];

  for (const entity of impacted) {
    if (!isEligibleForFireballKnockback(entity, fireballConfig.knockback_immune_card_ids)) {
      continue;
    }

    const direction = normalizeVector(entity.x - impactX, entity.y - impactY);
    const desiredPosition = {
      x: entity.x + direction.x * fireballConfig.knockback_distance_tiles,
      y: entity.y + direction.y * fireballConfig.knockback_distance_tiles,
    };

    const clampedFinalPosition = clampPositionToArenaAndPathable(desiredPosition, arena);
    const durationTicks = fireballConfig.knockback_duration_ticks;

    const vectorPerTick = {
      x: roundCoord((clampedFinalPosition.x - entity.x) / durationTicks),
      y: roundCoord((clampedFinalPosition.y - entity.y) / durationTicks),
    };

    entity.forced_motion_vector = vectorPerTick;
    entity.forced_motion_ticks_remaining = durationTicks;

    knockbackEvents.push(
      createKnockbackReplayEvent({
        tick,
        source_spell: sourceSpell,
        target_entity: entity.id,
        vector: vectorPerTick,
        ticks: durationTicks,
      }),
    );
  }

  return {
    impacted_entity_ids: impacted.map((entity) => entity.id),
    knockback_events: knockbackEvents,
  };
}
