export const TRAINING_DATA_VERSION = 1;
export const SELF_MODEL_VERSION = 1;

export function createEmptyTrainingStore() {
  return {
    version: TRAINING_DATA_VERSION,
    samples: [],
    updated_at: Date.now(),
  };
}

function normalizeHand(hand) {
  if (!Array.isArray(hand)) {
    return [];
  }

  return hand.filter((cardId) => typeof cardId === "string").slice(0, 4);
}

function normalizeSample(rawSample) {
  if (!rawSample || typeof rawSample !== "object") {
    return null;
  }

  if (typeof rawSample.card_id !== "string" || typeof rawSample.phase !== "string") {
    return null;
  }

  const elixir = Number(rawSample.elixir);
  if (!Number.isFinite(elixir)) {
    return null;
  }

  return {
    phase: rawSample.phase,
    elixir: Math.max(0, Math.min(10, Math.round(elixir))),
    card_id: rawSample.card_id,
    hand: normalizeHand(rawSample.hand),
    tick: Math.max(0, Math.floor(Number(rawSample.tick) || 0)),
    source_tier: typeof rawSample.source_tier === "string" ? rawSample.source_tier : "unknown",
    created_at: Number(rawSample.created_at) || Date.now(),
  };
}

export function normalizeTrainingStore(rawStore) {
  const normalized = createEmptyTrainingStore();

  if (!rawStore || typeof rawStore !== "object") {
    return normalized;
  }

  const samples = Array.isArray(rawStore.samples)
    ? rawStore.samples.map(normalizeSample).filter((sample) => sample !== null)
    : [];

  return {
    version: TRAINING_DATA_VERSION,
    samples,
    updated_at: Number(rawStore.updated_at) || Date.now(),
  };
}

export function createDecisionSample({ phase, elixir, hand, cardId, tick, sourceTier = "human" }) {
  return normalizeSample({
    phase,
    elixir,
    hand,
    card_id: cardId,
    tick,
    source_tier: sourceTier,
    created_at: Date.now(),
  });
}

export function appendSamples(store, samples, maxSamples = 5000) {
  const normalized = normalizeTrainingStore(store);
  const validSamples = Array.isArray(samples)
    ? samples.map((sample) => normalizeSample(sample)).filter((sample) => sample !== null)
    : [];

  const merged = [...normalized.samples, ...validSamples];
  const trimmed = merged.slice(Math.max(0, merged.length - maxSamples));

  return {
    version: TRAINING_DATA_VERSION,
    samples: trimmed,
    updated_at: Date.now(),
  };
}

export function bucketElixir(elixir) {
  const safeElixir = Math.max(0, Math.min(10, Math.floor(Number(elixir) || 0)));
  return Math.floor(safeElixir / 2) * 2;
}

export function makeBucketKey({ phase, elixir }) {
  const phaseKey = typeof phase === "string" && phase.length > 0 ? phase : "normal";
  return `${phaseKey}|${bucketElixir(elixir)}`;
}

function rankCards(cardCounts, hand) {
  const handSet = new Set(hand);
  const ranked = [];

  for (const [cardId, count] of Object.entries(cardCounts ?? {})) {
    if (!handSet.has(cardId)) {
      continue;
    }
    ranked.push({ card_id: cardId, count: Number(count) || 0 });
  }

  ranked.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    return a.card_id.localeCompare(b.card_id);
  });

  return ranked;
}

export function trainSelfModel(samples, { minSamples = 120 } = {}) {
  const normalizedSamples = (Array.isArray(samples) ? samples : [])
    .map((sample) => normalizeSample(sample))
    .filter((sample) => sample !== null);

  const buckets = {};

  for (const sample of normalizedSamples) {
    const key = makeBucketKey({ phase: sample.phase, elixir: sample.elixir });
    if (!buckets[key]) {
      buckets[key] = {
        total: 0,
        cards: {},
      };
    }

    buckets[key].total += 1;
    buckets[key].cards[sample.card_id] = (buckets[key].cards[sample.card_id] ?? 0) + 1;
  }

  return {
    version: SELF_MODEL_VERSION,
    ready: normalizedSamples.length >= minSamples,
    sample_count: normalizedSamples.length,
    min_samples_required: minSamples,
    trained_at: Date.now(),
    buckets,
  };
}

export function selectCardFromModel(model, { phase, elixir, hand }) {
  if (!model || typeof model !== "object") {
    return null;
  }

  const normalizedHand = normalizeHand(hand);
  if (normalizedHand.length === 0) {
    return null;
  }

  const bucket = model.buckets?.[makeBucketKey({ phase, elixir })];
  if (!bucket) {
    return null;
  }

  const ranked = rankCards(bucket.cards, normalizedHand);
  return ranked[0]?.card_id ?? null;
}

export function summarizeTrainingStore(store) {
  const normalized = normalizeTrainingStore(store);
  return {
    sample_count: normalized.samples.length,
    updated_at: normalized.updated_at,
  };
}
