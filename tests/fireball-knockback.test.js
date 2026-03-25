import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { applyForcedMotion, createTower, createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";
import { resolveFireballImpact } from "../src/sim/spells.js";

function runKnockbackTicks(entities, arena, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    for (const entity of entities) {
      applyForcedMotion(entity, arena);
    }
  }
}

test("fireball knocks back troops except giant and does not move towers", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });

  const giant = createTroop({ id: "g1", cardId: "giant", team: "red", x: 5, y: 5.2, hp: 2500 });
  const knight = createTroop({ id: "k1", cardId: "knight", team: "red", x: 5.3, y: 5.3, hp: 1400 });
  const goblin = createTroop({ id: "gb1", cardId: "goblins", team: "red", x: 4.8, y: 4.9, hp: 220 });
  const tower = createTower({ id: "t1", team: "red", x: 5.6, y: 5.4, hp: 3000 });

  const entities = [giant, knight, goblin, tower];

  const impact = resolveFireballImpact({
    tick: 10,
    impactX: 5,
    impactY: 5,
    entities,
    arena,
    sourceSpell: "fireball",
    fireballConfig: {
      ...FIREBALL_CONFIG,
      radius_tiles: 2.5,
      troop_damage: 100,
      tower_damage: 100,
    },
  });

  assert.equal(giant.hp, 2400);
  assert.equal(knight.hp, 1300);
  assert.equal(goblin.hp, 120);
  assert.equal(tower.hp, 2900);

  assert.equal(giant.forced_motion_ticks_remaining, 0);
  assert.equal(tower.forced_motion_ticks_remaining, 0);
  assert.equal(knight.forced_motion_ticks_remaining, 5);
  assert.equal(goblin.forced_motion_ticks_remaining, 5);

  assert.equal(impact.knockback_events.length, 2);
  for (const event of impact.knockback_events) {
    assert.equal(event.source_spell, "fireball");
    assert.equal(event.ticks, 5);
  }

  const knightStart = { x: knight.x, y: knight.y };
  const goblinStart = { x: goblin.x, y: goblin.y };
  runKnockbackTicks(entities, arena, FIREBALL_CONFIG.knockback_duration_ticks);

  assert.notEqual(knight.x, knightStart.x);
  assert.notEqual(goblin.y, goblinStart.y);
  assert.equal(giant.x, 5);
  assert.equal(tower.x, 5.6);
});

test("fireball knockback displacement is clamped to map bounds and pathable space deterministically", () => {
  const arena = createArena({
    minX: 0,
    maxX: 10,
    minY: 0,
    maxY: 10,
    isPathable: (x, y) => x <= 9.6 && y >= 0,
  });

  const makeTarget = () => createTroop({ id: "k2", cardId: "knight", team: "red", x: 9.8, y: 5, hp: 1400 });

  const runOnce = () => {
    const target = makeTarget();
    resolveFireballImpact({
      tick: 8,
      impactX: 9,
      impactY: 5,
      entities: [target],
      arena,
      sourceSpell: "fireball",
      fireballConfig: {
        ...FIREBALL_CONFIG,
        troop_damage: 1,
        tower_damage: 1,
      },
    });

    runKnockbackTicks([target], arena, FIREBALL_CONFIG.knockback_duration_ticks);
    return { x: target.x, y: target.y };
  };

  const first = runOnce();
  const second = runOnce();

  assert.ok(first.x <= 9.6);
  assert.deepEqual(first, second);
});
