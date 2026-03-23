import test from "node:test";
import assert from "node:assert/strict";

import {
  REFERENCE_SCREEN,
  computePortraitBattleLayout,
  findHandSlotHit,
  viewportToWorld,
  worldToViewport,
} from "../src/client/layout.js";

const WORLD_BOUNDS = Object.freeze({
  minX: 0,
  maxX: 18,
  minY: 0,
  maxY: 32,
});

function almostEqual(actual, expected, epsilon = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

test("portrait reference layout preserves the measured anchors", () => {
  const layout = computePortraitBattleLayout(REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);

  assert.equal(layout.frame.x, 0);
  assert.equal(layout.frame.y, 0);
  assert.equal(layout.frame.width, REFERENCE_SCREEN.width);
  assert.equal(layout.frame.height, REFERENCE_SCREEN.height);
  assert.equal(layout.arenaViewport.y, 86);
  assert.equal(layout.bottomTray.y, 1088);
  assert.equal(layout.handSlots.length, 4);
  assert.ok(layout.crownRail.x > layout.arenaViewport.x + layout.arenaViewport.width * 0.9);
});

test("desktop layout keeps the portrait baseline centered with uniform scaling", () => {
  const layout = computePortraitBattleLayout(1400, 900);
  const expectedScale = 900 / REFERENCE_SCREEN.height;

  almostEqual(layout.scale, expectedScale);
  almostEqual(layout.frame.height, 900);
  almostEqual(layout.frame.width, REFERENCE_SCREEN.width * expectedScale);
  almostEqual(layout.frame.x, (1400 - layout.frame.width) * 0.5);
  almostEqual(layout.arenaViewport.width, 750 * expectedScale);
});

test("hand hit testing excludes the next card panel and returns slot indices", () => {
  const layout = computePortraitBattleLayout(REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);
  const slot = layout.handSlots[2];
  const slotCenter = { x: slot.x + slot.width * 0.5, y: slot.y + slot.height * 0.5 };
  const nextCardCenter = {
    x: layout.nextCardRect.x + layout.nextCardRect.width * 0.5,
    y: layout.nextCardRect.y + layout.nextCardRect.height * 0.5,
  };

  assert.equal(findHandSlotHit(layout, slotCenter), 2);
  assert.equal(findHandSlotHit(layout, nextCardCenter), null);
});

test("arena viewport world/screen mapping round-trips through the portrait rect", () => {
  const layout = computePortraitBattleLayout(REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);
  const midpoint = { x: 9, y: 16 };
  const screenPoint = worldToViewport(midpoint, WORLD_BOUNDS, layout.arenaViewport);
  const roundTrip = viewportToWorld(screenPoint, WORLD_BOUNDS, layout.arenaViewport);

  almostEqual(screenPoint.x, layout.arenaViewport.x + layout.arenaViewport.width * 0.5);
  almostEqual(screenPoint.y, layout.arenaViewport.y + layout.arenaViewport.height * 0.5);
  almostEqual(roundTrip.x, midpoint.x);
  almostEqual(roundTrip.y, midpoint.y);
});
