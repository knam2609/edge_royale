import test from "node:test";
import assert from "node:assert/strict";

import { loadReplay } from "../src/replay/codec.js";
import { enumerateLegalCardActions, EDGER_BOT_ID, selectBotAction } from "../src/ai/botRuntime.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";
import { getTowerStats } from "../src/sim/stats.js";

function makeCardState() {
  return {
    blue: {
      hand: ["giant", "knight", "archers", "arrows"],
      draw_pile: ["musketeer", "mini_pekka", "goblins", "fireball"],
    },
    red: {
      hand: ["giant", "knight", "arrows", "fireball"],
      draw_pile: ["musketeer", "mini_pekka", "goblins", "archers"],
    },
  };
}

function makeEngine() {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const crownHp = getTowerStats("crown").hp;
  const engine = createEngine({
    seed: 606,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
      createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 9, y: 22, hp: 2800 }),
    ],
    initialCardState: makeCardState(),
  });
  engine.state.elixir.red.elixir = 10;
  engine.state.elixir.blue.elixir = 10;
  return engine;
}

function runMlPolicyTicks(totalTicks = 120) {
  const engine = makeEngine();
  const selectedActions = [];

  for (let i = 0; i < totalTicks && !engine.getMatchResult(); i += 1) {
    const tick = engine.state.tick + 1;
    const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
    const selected = selectBotAction({
      botId: EDGER_BOT_ID,
      engine,
      actor: "red",
      legalActions,
    });
    const actions = [];
    if (selected.type === "PLAY_CARD") {
      const action = {
        tick,
        type: "PLAY_CARD",
        actor: "red",
        cardId: selected.cardId,
        x: selected.x,
        y: selected.y,
      };
      actions.push(action);
      selectedActions.push(action);
    }
    engine.step(actions);
  }

  return {
    actions: selectedActions,
    hash: engine.getStateHash(),
    replay: engine.exportReplay(),
    tick: engine.state.tick,
  };
}

test("same ML model and same seed produce identical action streams", () => {
  const first = runMlPolicyTicks();
  const second = runMlPolicyTicks();

  assert.ok(first.actions.length > 0);
  assert.deepEqual(second.actions, first.actions);
  assert.equal(second.hash, first.hash);
});

test("replay round-trip with ML-generated actions reproduces final hash and events", () => {
  const original = runMlPolicyTicks();
  const replay = loadReplay(original.replay);
  const replayed = makeEngine();

  replayed.run(replay.actions, original.tick);

  assert.equal(replayed.getStateHash(), original.hash);
  assert.deepEqual(replayed.state.replay.events, replay.events);
});
