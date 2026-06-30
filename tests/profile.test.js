import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_VERSION,
  createDefaultProfile,
  getProfileProgress,
  normalizeProfile,
  recordMatch,
} from "../src/ai/profile.js";

test("default profile starts with empty Edger match stats", () => {
  const profile = createDefaultProfile();

  assert.equal(profile.version, PROFILE_VERSION);
  assert.equal(profile.total_matches, 0);
  assert.equal(profile.wins, 0);
  assert.equal(profile.losses, 0);
  assert.equal(profile.draws, 0);
});

test("old ladder profile payloads reset instead of migrating", () => {
  const profile = normalizeProfile({
    version: 1,
    unlocked_tiers: ["noob", "mid", "top", "self"],
    selected_tier: "self",
    total_matches: 100,
    wins_by_tier: { top: 3 },
  });

  assert.equal(profile.version, PROFILE_VERSION);
  assert.equal(profile.total_matches, 0);
  assert.equal(profile.wins, 0);
});

test("recordMatch stores aggregate Edger results", () => {
  const afterWin = recordMatch(createDefaultProfile(), { winner: "blue" });
  const afterLoss = recordMatch(afterWin, { winner: "red" });
  const afterDraw = recordMatch(afterLoss, { winner: null });

  assert.equal(afterDraw.total_matches, 3);
  assert.equal(afterDraw.wins, 1);
  assert.equal(afterDraw.losses, 1);
  assert.equal(afterDraw.draws, 1);
});

test("profile progress reports resolved win rate", () => {
  const profile = normalizeProfile({
    version: PROFILE_VERSION,
    total_matches: 4,
    wins: 2,
    losses: 1,
    draws: 1,
  });
  const progress = getProfileProgress(profile);

  assert.equal(progress.resolved_matches, 3);
  assert.equal(progress.win_rate, 2 / 3);
});
