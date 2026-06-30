export const PROFILE_VERSION = 2;

function normalizeCount(value) {
  const normalized = Math.floor(Number(value) || 0);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

export function createDefaultProfile() {
  const now = Date.now();
  return {
    version: PROFILE_VERSION,
    total_matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    created_at: now,
    updated_at: now,
  };
}

export function normalizeProfile(rawProfile) {
  if (!rawProfile || Number(rawProfile.version) !== PROFILE_VERSION) {
    return createDefaultProfile();
  }

  const wins = normalizeCount(rawProfile.wins);
  const losses = normalizeCount(rawProfile.losses);
  const draws = normalizeCount(rawProfile.draws);
  const total = Math.max(normalizeCount(rawProfile.total_matches), wins + losses + draws);
  const now = Date.now();

  return {
    version: PROFILE_VERSION,
    total_matches: total,
    wins,
    losses,
    draws,
    created_at: Number(rawProfile.created_at) || now,
    updated_at: Number(rawProfile.updated_at) || now,
  };
}

export function recordMatch(profile, { winner } = {}) {
  const normalized = normalizeProfile(profile);
  const next = {
    ...normalized,
    total_matches: normalized.total_matches + 1,
    updated_at: Date.now(),
  };

  if (winner === "blue") {
    next.wins += 1;
  } else if (winner === "red") {
    next.losses += 1;
  } else {
    next.draws += 1;
  }

  return next;
}

export function getProfileProgress(profile) {
  const normalized = normalizeProfile(profile);
  const resolved = normalized.wins + normalized.losses;
  return {
    ...normalized,
    resolved_matches: resolved,
    win_rate: resolved > 0 ? normalized.wins / resolved : 0,
  };
}
