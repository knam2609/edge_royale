import test from "node:test";
import assert from "node:assert/strict";

import { getCard } from "../src/sim/cards.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createArena } from "../src/sim/map.js";

function choosePlayableCard(hand, elixir) {
  for (const cardId of hand) {
    const card = getCard(cardId);
    if (card && card.cost <= elixir) {
      return card;
    }
  }
  return null;
}

function cardPlayY(cardType) {
  return cardType === "troop" ? 24 : 10;
}

test("engine initializes 4-card hand + draw queue for each actor", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({ seed: 2026, arena, fireballConfig: FIREBALL_CONFIG, initialEntities: [] });

  const blueHand = engine.getHand("blue");
  const redHand = engine.getHand("red");
  const blueQueue = engine.getDeckQueue("blue");
  const redQueue = engine.getDeckQueue("red");

  assert.equal(blueHand.length, 4);
  assert.equal(redHand.length, 4);
  assert.equal(blueQueue.length, 4);
  assert.equal(redQueue.length, 4);

  assert.equal(new Set([...blueHand, ...blueQueue]).size, 8);
  assert.equal(new Set([...redHand, ...redQueue]).size, 8);
});

test("PLAY_CARD spends elixir and cycles card through hand/draw queue", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({ seed: 2027, arena, fireballConfig: FIREBALL_CONFIG, initialEntities: [] });

  const handBefore = engine.getHand("blue");
  const queueBefore = engine.getDeckQueue("blue");
  const card = choosePlayableCard(handBefore, engine.state.elixir.blue.elixir);
  assert.ok(card, "expected at least one playable card in opening hand");

  const elixirBefore = engine.state.elixir.blue.elixir;
  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: card.id,
      x: 9,
      y: cardPlayY(card.type),
    },
  ]);

  const handAfter = engine.getHand("blue");
  const queueAfter = engine.getDeckQueue("blue");

  assert.equal(handAfter.length, 4);
  assert.equal(queueAfter.length, 4);
  assert.ok(queueAfter.includes(card.id), "played card should rotate to back of draw queue");
  assert.ok(elixirBefore - engine.state.elixir.blue.elixir >= card.cost);

  const playedEvent = engine.state.replay.events.find((event) => event.type === "card_played" && event.actor === "blue");
  assert.ok(playedEvent);
});

test("PLAY_CARD does nothing when card is not in hand", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({ seed: 2028, arena, fireballConfig: FIREBALL_CONFIG, initialEntities: [] });

  const handBefore = engine.getHand("blue");
  const queueBefore = engine.getDeckQueue("blue");

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "fireball",
      x: 9,
      y: 10,
    },
  ]);

  const handAfter = engine.getHand("blue");
  const queueAfter = engine.getDeckQueue("blue");

  // If fireball happened to be in hand for this seed, skip this assertion path.
  if (!handBefore.includes("fireball")) {
    assert.deepEqual(handAfter, handBefore);
    assert.deepEqual(queueAfter, queueBefore);
    assert.equal(engine.state.replay.events.some((event) => event.type === "card_played"), false);
  }
});

test("troop PLAY_CARD rejects enemy-side placement for blue", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({ seed: 2029, arena, fireballConfig: FIREBALL_CONFIG, initialEntities: [] });

  const hand = engine.getHand("blue");
  const troopId = hand.find((cardId) => getCard(cardId)?.type === "troop");
  assert.ok(troopId, "expected a troop card in opening hand");

  const before = engine.getHand("blue");
  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: troopId,
      x: 9,
      y: 8,
    },
  ]);

  assert.deepEqual(engine.getHand("blue"), before);
});
