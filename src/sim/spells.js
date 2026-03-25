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

function isEnemyEntity(entity, actorTeam) {
  if (!actorTeam) {
    return true;
  }
  return entity.team !== actorTeam;
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

function getSpellDamage(config, entity) {
  return entity.entity_type === "tower" ? config.tower_damage : config.troop_damage;
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
  actorTeam = null,
  fireballConfig,
}) {
  const center = { x: impactX, y: impactY };
  const impacted = [];

  // 1) Impact detection
  for (const entity of entities) {
    if (isEnemyEntity(entity, actorTeam) && isInImpactRadius(entity, center, fireballConfig.radius_tiles)) {
      impacted.push(entity);
    }
  }

  // 2) Damage
  for (const entity of impacted) {
    entity.hp = Math.max(0, entity.hp - getSpellDamage(fireballConfig, entity));
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

export function resolveArrowsImpact({
  tick,
  impactX,
  impactY,
  entities,
  sourceSpell,
  actorTeam = null,
  arrowsConfig,
}) {
  const center = { x: impactX, y: impactY };
  const impacted = [];

  for (const entity of entities) {
    if (!isEnemyEntity(entity, actorTeam)) {
      continue;
    }
    if (isInImpactRadius(entity, center, arrowsConfig.radius_tiles)) {
      impacted.push(entity);
    }
  }

  for (const entity of impacted) {
    entity.hp = Math.max(0, entity.hp - getSpellDamage(arrowsConfig, entity));
  }

  return {
    tick,
    source_spell: sourceSpell,
    impacted_entity_ids: impacted.map((entity) => entity.id),
  };
}
