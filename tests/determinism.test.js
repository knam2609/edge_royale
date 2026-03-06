import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";

function makeInitialEntities() {
  return [
    createTroop({ id: "a", cardId: "knight", team: "blue", x: 4.2, y: 4.1, hp: 1400 }),
    createTroop({ id: "b", cardId: "goblins", team: "red", x: 4.6, y: 4.4, hp: 220 }),
    createTroop({ id: "c", cardId: "giant", team: "red", x: 5.2, y: 5, hp: 2500 }),
  ];
}

const actions = [
  { tick: 5, type: "CAST_FIREBALL", x: 4.5, y: 4.4, actor: "blue" },
  { tick: 25, type: "CAST_FIREBALL", x: 5.0, y: 5.0, actor: "red" },
];

test("same seed + same input stream yields identical hash with knockback enabled", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });

  const engineA = createEngine({
    seed: 99,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  engineA.setOvertime(true);
  engineA.run(actions, 50);

  const engineB = createEngine({
    seed: 99,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  engineB.setOvertime(true);
  engineB.run(actions, 50);

  assert.equal(engineA.getStateHash(), engineB.getStateHash());

  const spellImpacts = engineA.state.replay.events.filter((event) => event.type === "spell_impact");
  assert.ok(spellImpacts.length > 0);
  assert.ok(spellImpacts.some((event) => event.knockback_events.length > 0));
});
