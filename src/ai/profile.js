export const PROFILE_VERSION = 1;
export const BOT_TIER_ORDER = Object.freeze(["noob", "mid", "top", "self"]);

export const SELF_PLAY_UNLOCK_RULE = Object.freeze({
  min_matches: 100,
  min_top_wins: 3,
});

function uniqueTierList(input) {
  const seen = new Set();
  const ordered = [];
  for (const tier of BOT_TIER_ORDER) {
    if (Array.isArray(input) && input.includes(tier) && !seen.has(tier)) {
      seen.add(tier);
      ordered.push(tier);
    }
  }
  return ordered;
}

function normalizeWins(rawWins) {
  const wins = {};
  for (const tier of BOT_TIER_ORDER) {
    const value = Number(rawWins?.[tier] ?? 0);
    wins[tier] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return wins;
}

export function createDefaultProfile() {
  return {
    version: PROFILE_VERSION,
    unlocked_tiers: ["noob"],
    selected_tier: "noob",
    total_matches: 0,
    wins_by_tier: normalizeWins(null),
    updated_at: Date.now(),
  };
}

function ensureValidSelection(unlocked, selectedTier) {
  if (unlocked.includes(selectedTier)) {
    return selectedTier;
  }
  return unlocked[unlocked.length - 1] ?? "noob";
}

export function normalizeProfile(rawProfile) {
  const fallback = createDefaultProfile();
  const unlocked = uniqueTierList(rawProfile?.unlocked_tiers);
  if (!unlocked.includes("noob")) {
    unlocked.unshift("noob");
  }

  const normalized = {
    version: PROFILE_VERSION,
    unlocked_tiers: unlocked,
    selected_tier: ensureValidSelection(unlocked, rawProfile?.selected_tier ?? fallback.selected_tier),
    total_matches: Math.max(0, Math.floor(Number(rawProfile?.total_matches ?? 0) || 0)),
    wins_by_tier: normalizeWins(rawProfile?.wins_by_tier),
    updated_at: Number(rawProfile?.updated_at) || Date.now(),
  };

  return normalized;
}

export function isTierUnlocked(profile, tierId) {
  return normalizeProfile(profile).unlocked_tiers.includes(tierId);
}

export function getNextTier(tierId) {
  const index = BOT_TIER_ORDER.indexOf(tierId);
  if (index < 0 || index + 1 >= BOT_TIER_ORDER.length) {
    return null;
  }
  return BOT_TIER_ORDER[index + 1];
}

export function setSelectedTier(profile, tierId) {
  const normalized = normalizeProfile(profile);
  if (!normalized.unlocked_tiers.includes(tierId)) {
    return normalized;
  }

  return {
    ...normalized,
    selected_tier: tierId,
    updated_at: Date.now(),
  };
}

function maybeUnlockSelfPlay(profile) {
  if (profile.unlocked_tiers.includes("self")) {
    return { profile, selfUnlocked: false };
  }

  const totalMatches = profile.total_matches;
  const topWins = profile.wins_by_tier.top;
  if (totalMatches < SELF_PLAY_UNLOCK_RULE.min_matches || topWins < SELF_PLAY_UNLOCK_RULE.min_top_wins) {
    return { profile, selfUnlocked: false };
  }

  return {
    profile: {
      ...profile,
      unlocked_tiers: [...profile.unlocked_tiers, "self"],
      updated_at: Date.now(),
    },
    selfUnlocked: true,
  };
}

export function recordMatch(profile, { opponentTier, winner }) {
  const normalized = normalizeProfile(profile);
  const tier = BOT_TIER_ORDER.includes(opponentTier) ? opponentTier : normalized.selected_tier;
  const updatedWins = { ...normalized.wins_by_tier };
  const newlyUnlocked = [];

  if (winner === "blue") {
    updatedWins[tier] = (updatedWins[tier] ?? 0) + 1;

    const nextTier = getNextTier(tier);
    if (nextTier && nextTier !== "self" && !normalized.unlocked_tiers.includes(nextTier)) {
      newlyUnlocked.push(nextTier);
    }
  }

  let nextProfile = {
    ...normalized,
    total_matches: normalized.total_matches + 1,
    wins_by_tier: updatedWins,
    unlocked_tiers: uniqueTierList([...normalized.unlocked_tiers, ...newlyUnlocked]),
    updated_at: Date.now(),
  };

  const selfUnlock = maybeUnlockSelfPlay(nextProfile);
  nextProfile = selfUnlock.profile;
  if (selfUnlock.selfUnlocked) {
    newlyUnlocked.push("self");
  }

  nextProfile.selected_tier = ensureValidSelection(nextProfile.unlocked_tiers, nextProfile.selected_tier);

  return {
    profile: nextProfile,
    newlyUnlocked,
  };
}

export function getProfileProgress(profile) {
  const normalized = normalizeProfile(profile);
  const matchesNeeded = Math.max(0, SELF_PLAY_UNLOCK_RULE.min_matches - normalized.total_matches);
  const topWinsNeeded = Math.max(0, SELF_PLAY_UNLOCK_RULE.min_top_wins - normalized.wins_by_tier.top);

  return {
    total_matches: normalized.total_matches,
    top_wins: normalized.wins_by_tier.top,
    self_play_ready: matchesNeeded === 0 && topWinsNeeded === 0,
    matches_needed_for_self: matchesNeeded,
    top_wins_needed_for_self: topWinsNeeded,
    unlocked_tiers: [...normalized.unlocked_tiers],
  };
}
