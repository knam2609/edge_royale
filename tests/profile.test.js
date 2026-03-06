import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultProfile,
  normalizeProfile,
  recordMatch,
  setSelectedTier,
} from "../src/ai/profile.js";

test("default profile starts with only noob unlocked", () => {
  const profile = createDefaultProfile();
  assert.deepEqual(profile.unlocked_tiers, ["noob"]);
  assert.equal(profile.selected_tier, "noob");
});

test("winning current tier unlocks the next tier", () => {
  const start = normalizeProfile({
    unlocked_tiers: ["noob"],
    selected_tier: "noob",
    total_matches: 0,
    wins_by_tier: { noob: 0, mid: 0, top: 0, self: 0 },
  });

  const result = recordMatch(start, { opponentTier: "noob", winner: "blue" });

  assert.equal(result.profile.total_matches, 1);
  assert.equal(result.profile.wins_by_tier.noob, 1);
  assert.ok(result.profile.unlocked_tiers.includes("mid"));
  assert.ok(result.newlyUnlocked.includes("mid"));
});

test("self tier unlocks after 100 matches and 3 top wins", () => {
  const start = normalizeProfile({
    unlocked_tiers: ["noob", "mid", "top"],
    selected_tier: "top",
    total_matches: 99,
    wins_by_tier: { noob: 10, mid: 5, top: 2, self: 0 },
  });

  const result = recordMatch(start, { opponentTier: "top", winner: "blue" });

  assert.equal(result.profile.total_matches, 100);
  assert.equal(result.profile.wins_by_tier.top, 3);
  assert.ok(result.profile.unlocked_tiers.includes("self"));
  assert.ok(result.newlyUnlocked.includes("self"));
});

test("cannot select a locked tier", () => {
  const profile = normalizeProfile({
    unlocked_tiers: ["noob"],
    selected_tier: "noob",
    total_matches: 0,
  });

  const updated = setSelectedTier(profile, "top");
  assert.equal(updated.selected_tier, "noob");
});
