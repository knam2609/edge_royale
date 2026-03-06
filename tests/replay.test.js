import test from "node:test";
import assert from "node:assert/strict";

import { loadReplay } from "../src/replay/codec.js";
import { REPLAY_SCHEMA_VERSION } from "../src/replay/schema.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";

function makeInitialEntities() {
  return [
    createTroop({ id: "a", cardId: "knight", team: "blue", x: 4, y: 4, hp: 1400 }),
    createTroop({ id: "b", cardId: "goblins", team: "red", x: 4.4, y: 4.2, hp: 220 }),
    createTroop({ id: "c", cardId: "giant", team: "red", x: 5.1, y: 5.1, hp: 2500 }),
  ];
}

test("replay round-trip preserves knockback events and final state", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const actions = [{ tick: 7, type: "CAST_FIREBALL", x: 4.3, y: 4.2, actor: "blue" }];

  const original = createEngine({
    seed: 123,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  original.run(actions, 30);

  const replayJson = original.exportReplay();
  const replay = loadReplay(replayJson);

  assert.equal(replay.version, REPLAY_SCHEMA_VERSION);
  const spellImpact = replay.events.find((event) => event.type === "spell_impact");
  assert.ok(spellImpact);
  assert.ok(Array.isArray(spellImpact.knockback_events));
  assert.ok(spellImpact.knockback_events.length > 0);

  const replayed = createEngine({
    seed: replay.seed,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  replayed.run(replay.actions, 30);

  assert.equal(original.getStateHash(), replayed.getStateHash());
  assert.deepEqual(original.state.replay.events, replayed.state.replay.events);
});

test("older replay payloads without knockback field are loaded with safe fallback", () => {
  const oldReplay = {
    version: "1.0",
    seed: 1,
    actions: [{ tick: 2, type: "CAST_FIREBALL", x: 1, y: 1 }],
    events: [{ type: "spell_impact", tick: 2, source_spell: "fireball", impacted_entity_ids: ["a"] }],
  };

  const loaded = loadReplay(oldReplay);
  assert.equal(loaded.version, "1.0");
  assert.deepEqual(loaded.events[0].knockback_events, []);
});
