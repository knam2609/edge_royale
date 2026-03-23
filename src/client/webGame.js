import { getCard } from "../sim/cards.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTower } from "../sim/entities.js";
import { createRoyaleArena, snapPositionToGrid } from "../sim/map.js";
import { createRng } from "../sim/random.js";
import {
  BOT_TIERS,
  enumerateLegalCardActions,
  getBotTierConfig,
  normalizeBotTierId,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../ai/ladderRuntime.js";
import {
  createDefaultProfile,
  getProfileProgress,
  normalizeProfile,
  recordMatch,
  setSelectedTier,
} from "../ai/profile.js";
import {
  appendSamples,
  createDecisionSample,
  createEmptyTrainingStore,
  normalizeTrainingStore,
  summarizeTrainingStore,
  trainSelfModel,
} from "../ai/training.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("reset-btn");
const trainBtn = document.getElementById("train-btn");
const botTierSelect = document.getElementById("bot-tier-select");
const profileSummary = document.getElementById("profile-summary");

const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });

const MAX_ELIXIR = 10;
const PROFILE_STORAGE_KEY = "edge_royale_profile_v1";
const TRAINING_STORAGE_KEY = "edge_royale_training_data_v1";
const SELF_MODEL_STORAGE_KEY = "edge_royale_self_model_v1";
const HAND_SLOTS = 4;
const BASE_HAND_CARD_WIDTH = 140;
const BASE_HAND_CARD_HEIGHT = 54;
const BASE_HAND_GAP = 10;
const DRAG_START_DISTANCE = 8;
const LAYOUT_PADDING = 12;
const LAYOUT_GAP = 8;
const MIN_ARENA_HEIGHT = 140;
const MAX_TRANSIENT_EFFECTS = 96;

const CARD_LABEL = Object.freeze({
  giant: "Giant",
  knight: "Knight",
  archers: "Archers",
  mini_pekka: "Mini P.E.K.K.A",
  musketeer: "Musketeer",
  goblins: "Goblins",
  arrows: "Arrows",
  fireball: "Fireball",
});

const CARD_MONOGRAM = Object.freeze({
  giant: "GI",
  knight: "KN",
  archers: "AR",
  mini_pekka: "MP",
  musketeer: "MS",
  goblins: "GB",
  arrows: "AX",
  fireball: "FB",
});

const TOWER_LAYOUT = Object.freeze({
  blue: Object.freeze([
    Object.freeze({ id: "blue_crown_left", team: "blue", tower_role: "crown", x: 5, y: 26, hp: 2500 }),
    Object.freeze({ id: "blue_crown_right", team: "blue", tower_role: "crown", x: 13, y: 26, hp: 2500 }),
    Object.freeze({ id: "blue_king", team: "blue", tower_role: "king", x: 9, y: 30, hp: 3600, is_active: false }),
  ]),
  red: Object.freeze([
    Object.freeze({ id: "red_crown_left", team: "red", tower_role: "crown", x: 5, y: 6, hp: 2500 }),
    Object.freeze({ id: "red_crown_right", team: "red", tower_role: "crown", x: 13, y: 6, hp: 2500 }),
    Object.freeze({ id: "red_king", team: "red", tower_role: "king", x: 9, y: 2, hp: 3600, is_active: false }),
  ]),
});

const ALL_TOWER_LAYOUT = Object.freeze([...TOWER_LAYOUT.blue, ...TOWER_LAYOUT.red]);

const ATTACK_ANIMATION_TICKS = Object.freeze({
  giant: 7,
  knight: 6,
  archers: 6,
  mini_pekka: 7,
  musketeer: 6,
  goblins: 5,
});

const appState = {
  mode: "ready",
  paused: false,
  pendingActions: [],
  statusMessage: "Click Start to begin.",
  selectedCardIndex: 0,
  selectedBotTier: "noob",
  engine: null,
  canvasMetrics: { width: canvas.width, height: canvas.height, dpr: 1 },
  dragState: null,
  suppressNextClick: false,
  profile: createDefaultProfile(),
  trainingStore: createEmptyTrainingStore(),
  selfModel: null,
  matchRecorded: false,
  pendingTrainingSamples: [],
  botRng: createRng(20260306),
  botNextDecisionTick: 1,
  lastFrameTime: performance.now(),
  lagMs: 0,
  entityAnimations: new Map(),
  transientEffects: [],
  lastProcessedReplayEventCount: 0,
};

function getCanvasWidth() {
  return appState.canvasMetrics.width;
}

function getCanvasHeight() {
  return appState.canvasMetrics.height;
}

function resizeCanvasToDisplaySize() {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  appState.canvasMetrics = { width: cssWidth, height: cssHeight, dpr };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function loadStoredJson(key, fallbackValue) {
  try {
    const payload = window.localStorage.getItem(key);
    if (!payload) {
      return fallbackValue;
    }
    return JSON.parse(payload);
  } catch {
    return fallbackValue;
  }
}

function saveStoredJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore persistence failures and keep gameplay running.
  }
}

function getTierLabel(tierId) {
  return getBotTierConfig(tierId).label;
}

function syncTierSelectOptions() {
  const profile = normalizeProfile(appState.profile);
  const locked = new Set(
    BOT_TIERS.map((tier) => tier.id).filter((tierId) => !profile.unlocked_tiers.includes(tierId)),
  );

  botTierSelect.innerHTML = "";
  for (const tier of BOT_TIERS) {
    const option = document.createElement("option");
    option.value = tier.id;
    option.textContent = locked.has(tier.id) ? `${tier.label} (Locked)` : tier.label;
    option.disabled = locked.has(tier.id);
    botTierSelect.append(option);
  }

  const selected = profile.unlocked_tiers.includes(appState.selectedBotTier)
    ? appState.selectedBotTier
    : profile.selected_tier;
  appState.selectedBotTier = normalizeBotTierId(selected);
  botTierSelect.value = appState.selectedBotTier;
}

function refreshProfileSummary() {
  const profile = normalizeProfile(appState.profile);
  const progress = getProfileProgress(profile);
  const training = summarizeTrainingStore(appState.trainingStore);
  const selfReady = Boolean(appState.selfModel?.ready);

  const selfStatus = progress.self_play_ready
    ? "Self unlock ready"
    : `Self unlock in ${progress.matches_needed_for_self} matches + ${progress.top_wins_needed_for_self} top wins`;

  profileSummary.textContent = `Tier: ${getTierLabel(appState.selectedBotTier)} | Matches: ${progress.total_matches} | Training samples: ${training.sample_count} | ${selfStatus} | Model: ${selfReady ? "ready" : "not trained"}`;
}

function persistProfile() {
  saveStoredJson(PROFILE_STORAGE_KEY, appState.profile);
}

function persistTrainingStore() {
  saveStoredJson(TRAINING_STORAGE_KEY, appState.trainingStore);
}

function persistSelfModel() {
  saveStoredJson(SELF_MODEL_STORAGE_KEY, appState.selfModel);
}

function hydrateAppState() {
  appState.profile = normalizeProfile(loadStoredJson(PROFILE_STORAGE_KEY, createDefaultProfile()));
  appState.trainingStore = normalizeTrainingStore(loadStoredJson(TRAINING_STORAGE_KEY, createEmptyTrainingStore()));

  const loadedModel = loadStoredJson(SELF_MODEL_STORAGE_KEY, null);
  appState.selfModel = loadedModel && typeof loadedModel === "object" ? loadedModel : null;

  appState.selectedBotTier = normalizeBotTierId(appState.profile.selected_tier);
  syncTierSelectOptions();
  refreshProfileSummary();
}

function worldToScreen(position) {
  const viewport = getArenaViewport();
  const px =
    viewport.x + ((position.x - arena.minX) / (arena.maxX - arena.minX)) * viewport.width;
  const py =
    viewport.y + ((position.y - arena.minY) / (arena.maxY - arena.minY)) * viewport.height;
  return { x: px, y: py };
}

function screenToWorld(position) {
  const viewport = getArenaViewport();
  const normalizedX = clamp01((position.x - viewport.x) / viewport.width);
  const normalizedY = clamp01((position.y - viewport.y) / viewport.height);
  const x = arena.minX + normalizedX * (arena.maxX - arena.minX);
  const y = arena.minY + normalizedY * (arena.maxY - arena.minY);
  return { x: Math.max(arena.minX, Math.min(arena.maxX, x)), y: Math.max(arena.minY, Math.min(arena.maxY, y)) };
}

function getUiLayout() {
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const isCompact = width < 760 || height < 420;
  const frameX = LAYOUT_PADDING;
  const frameWidth = Math.max(1, width - LAYOUT_PADDING * 2);
  const availableHeight = Math.max(1, height - LAYOUT_PADDING * 2);

  const desiredInfoHeight = isCompact ? 58 : 68;
  const desiredHandHeight = isCompact ? 62 : 74;
  const desiredStatusHeight = isCompact ? 20 : 24;
  const minInfoHeight = 42;
  const minHandHeight = 44;
  const minStatusHeight = 16;

  let infoHeight = desiredInfoHeight;
  let handHeight = desiredHandHeight;
  let statusHeight = desiredStatusHeight;

  const minArenaCap = Math.max(
    20,
    availableHeight - (minInfoHeight + minHandHeight + minStatusHeight + LAYOUT_GAP * 3),
  );
  const minArenaHeight = Math.min(MIN_ARENA_HEIGHT, minArenaCap);

  let arenaHeight = Math.max(
    minArenaHeight,
    availableHeight - (infoHeight + handHeight + statusHeight + LAYOUT_GAP * 3),
  );
  let overflow =
    infoHeight + handHeight + statusHeight + LAYOUT_GAP * 3 + arenaHeight - availableHeight;

  if (overflow > 0) {
    const infoReduction = Math.min(infoHeight - minInfoHeight, overflow);
    infoHeight -= infoReduction;
    overflow -= infoReduction;

    const handReduction = Math.min(handHeight - minHandHeight, overflow);
    handHeight -= handReduction;
    overflow -= handReduction;

    const statusReduction = Math.min(statusHeight - minStatusHeight, overflow);
    statusHeight -= statusReduction;
  }

  arenaHeight = Math.max(20, availableHeight - (infoHeight + handHeight + statusHeight + LAYOUT_GAP * 3));

  const infoPanel = {
    x: frameX,
    y: LAYOUT_PADDING,
    width: frameWidth,
    height: infoHeight,
  };

  const arenaViewport = {
    x: frameX,
    y: Math.min(height - LAYOUT_PADDING - arenaHeight, infoPanel.y + infoPanel.height + LAYOUT_GAP),
    width: frameWidth,
    height: arenaHeight,
  };

  const handPanel = {
    x: frameX,
    y: arenaViewport.y + arenaViewport.height + LAYOUT_GAP,
    width: frameWidth,
    height: handHeight,
  };

  const statusPanel = {
    x: frameX,
    y: handPanel.y + handPanel.height + LAYOUT_GAP,
    width: frameWidth,
    height: statusHeight,
  };

  return { isCompact, infoPanel, arenaViewport, handPanel, statusPanel };
}

function getArenaViewport() {
  return getUiLayout().arenaViewport;
}

function isPointInArenaViewport(point) {
  const viewport = getArenaViewport();
  return (
    point.x >= viewport.x &&
    point.x <= viewport.x + viewport.width &&
    point.y >= viewport.y &&
    point.y <= viewport.y + viewport.height
  );
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function easeOutCubic(value) {
  const t = clamp01(value);
  return 1 - (1 - t) ** 3;
}

function fitTextToWidth(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let candidate = text;
  while (candidate.length > 1 && ctx.measureText(`${candidate}…`).width > maxWidth) {
    candidate = candidate.slice(0, -1);
  }
  return `${candidate}…`;
}

function tilesToPixels(tiles) {
  const viewport = getArenaViewport();
  const pxPerTileX = viewport.width / (arena.maxX - arena.minX);
  const pxPerTileY = viewport.height / (arena.maxY - arena.minY);
  return tiles * ((pxPerTileX + pxPerTileY) * 0.5);
}

function getTeamPalette(actor) {
  if (actor === "blue") {
    return {
      stroke: "#6fa8ff",
      glow: "rgba(72,145,255,0.28)",
      text: "#e4efff",
    };
  }

  return {
    stroke: "#ff8f8f",
    glow: "rgba(239,95,95,0.28)",
    text: "#ffe6e6",
  };
}

function getCardAccent(cardId) {
  if (cardId === "giant") {
    return "#dfb15e";
  }
  if (cardId === "knight") {
    return "#79b5ff";
  }
  if (cardId === "archers") {
    return "#7ed07f";
  }
  if (cardId === "mini_pekka") {
    return "#74d8f3";
  }
  if (cardId === "musketeer") {
    return "#ffd27c";
  }
  if (cardId === "goblins") {
    return "#6fd56d";
  }
  if (cardId === "fireball") {
    return "#ff9c4f";
  }
  if (cardId === "arrows") {
    return "#f7d165";
  }
  return "#dce7ff";
}

function fract(value) {
  return value - Math.floor(value);
}

function sampleUnitNoise(seed) {
  return fract(Math.sin(seed * 12.9898) * 43758.5453123);
}

function getStringSeed(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) {
    total = (total * 31 + value.charCodeAt(i)) % 100000;
  }
  return total;
}

function getCardMonogram(cardId) {
  return CARD_MONOGRAM[cardId] ?? (CARD_LABEL[cardId] ?? cardId).slice(0, 2).toUpperCase();
}

function resetVisualState() {
  appState.entityAnimations = new Map();
  appState.transientEffects = [];
  appState.lastProcessedReplayEventCount = appState.engine?.state?.replay?.events?.length ?? 0;
}

function pushTransientEffect(effect) {
  appState.transientEffects.push(effect);
  if (appState.transientEffects.length > MAX_TRANSIENT_EFFECTS) {
    appState.transientEffects.splice(0, appState.transientEffects.length - MAX_TRANSIENT_EFFECTS);
  }
}

function queueAttackVisual(event) {
  const startTick = event.tick;
  const endTick = startTick + (ATTACK_ANIMATION_TICKS[event.attacker_card_id] ?? 5);

  appState.entityAnimations.set(event.attacker_id, {
    type: "attack",
    cardId: event.attacker_card_id,
    startTick,
    endTick,
    targetId: event.target_id,
    targetX: event.target_x,
    targetY: event.target_y,
  });

  if (event.attacker_card_id === "archers") {
    pushTransientEffect({
      type: "arrow_projectile",
      startTick,
      endTick: startTick + 7,
      actor: event.attacker_team,
      fromX: event.attacker_x,
      fromY: event.attacker_y,
      toX: event.target_x,
      toY: event.target_y,
    });
  } else if (event.attacker_card_id === "musketeer") {
    pushTransientEffect({
      type: "shotgun_blast",
      startTick,
      endTick: startTick + 5,
      actor: event.attacker_team,
      fromX: event.attacker_x,
      fromY: event.attacker_y,
      toX: event.target_x,
      toY: event.target_y,
    });
  } else if (event.attacker_card_id === "tower") {
    pushTransientEffect({
      type: "tower_bolt",
      startTick,
      endTick: startTick + 6,
      actor: event.attacker_team,
      fromX: event.attacker_x,
      fromY: event.attacker_y,
      toX: event.target_x,
      toY: event.target_y,
    });
  }

  pushTransientEffect({
    type: "hit_spark",
    startTick,
    endTick: startTick + 4,
    actor: event.attacker_team,
    cardId: event.attacker_card_id,
    x: event.target_x,
    y: event.target_y,
  });
}

function processReplayVisualEvents() {
  const replayEvents = appState.engine.state.replay.events.slice(appState.lastProcessedReplayEventCount);

  for (const event of replayEvents) {
    if (event.type === "troop_deployed") {
      pushTransientEffect({
        type: "deploy_burst",
        startTick: event.tick,
        endTick: event.tick + 7,
        actor: event.actor,
        cardId: event.card_id,
        x: event.x,
        y: event.y,
      });
      continue;
    }

    if (event.type !== "spell_impact") {
      continue;
    }

    if (event.source_spell === "fireball") {
      pushTransientEffect({
        type: "fireball_burst",
        startTick: event.tick,
        endTick: event.tick + 9,
        actor: event.actor,
        x: event.x,
        y: event.y,
      });
      continue;
    }

    if (event.source_spell === "arrows") {
      pushTransientEffect({
        type: "arrows_burst",
        startTick: event.tick,
        endTick: event.tick + 8,
        actor: event.actor,
        x: event.x,
        y: event.y,
      });
    }
  }

  appState.lastProcessedReplayEventCount = appState.engine.state.replay.events.length;
}

function syncVisualState() {
  const tick = appState.engine?.state?.tick ?? 0;

  for (const event of appState.engine?.state?.recent_combat_events ?? []) {
    queueAttackVisual(event);
  }

  if (appState.engine?.state?.replay?.events) {
    processReplayVisualEvents();
  }

  for (const [entityId, animation] of appState.entityAnimations.entries()) {
    if (animation.endTick < tick) {
      appState.entityAnimations.delete(entityId);
    }
  }

  appState.transientEffects = appState.transientEffects.filter((effect) => effect.endTick >= tick);
}

function getHandLayout() {
  const { handPanel } = getUiLayout();
  const nextCardWidth = Math.max(54, Math.min(76, Math.round(handPanel.width * 0.085)));
  const nextCardGap = Math.max(8, Math.round(nextCardWidth * 0.18));
  const availableWidth = Math.max(220, handPanel.width - 24 - nextCardWidth - nextCardGap);
  const baseTotalWidth = HAND_SLOTS * BASE_HAND_CARD_WIDTH + (HAND_SLOTS - 1) * BASE_HAND_GAP;
  const baseScale = Math.min(1, availableWidth / baseTotalWidth);
  const gap = Math.max(4, Math.round(BASE_HAND_GAP * Math.max(0.48, baseScale)));
  const cardWidth = Math.max(62, Math.floor((availableWidth - (HAND_SLOTS - 1) * gap) / HAND_SLOTS));
  const cardScale = cardWidth / BASE_HAND_CARD_WIDTH;
  const preferredCardHeight = Math.max(34, Math.round(BASE_HAND_CARD_HEIGHT * cardScale));
  const cardHeight = Math.min(preferredCardHeight, Math.max(34, handPanel.height - 16));
  const titleFont = Math.max(8, Math.round(12 * Math.max(0.55, cardScale)));
  const auxFont = Math.max(8, Math.round(11 * Math.max(0.55, cardScale)));

  return {
    cardWidth,
    cardHeight,
    gap,
    titleFont,
    auxFont,
    nextCardWidth,
    nextCardGap,
  };
}

function getNextCardRect() {
  const { handPanel } = getUiLayout();
  const layout = getHandLayout();
  return {
    x: handPanel.x + 10,
    y: handPanel.y + (handPanel.height - layout.cardHeight) / 2,
    width: layout.nextCardWidth,
    height: layout.cardHeight,
  };
}

function getHandSlotRects() {
  const { handPanel } = getUiLayout();
  const layout = getHandLayout();
  const nextCardRect = getNextCardRect();
  const totalWidth = HAND_SLOTS * layout.cardWidth + (HAND_SLOTS - 1) * layout.gap;
  const contentX = nextCardRect.x + nextCardRect.width + layout.nextCardGap;
  const contentWidth = handPanel.x + handPanel.width - contentX - 10;
  const startX = contentX + Math.max(0, (contentWidth - totalWidth) / 2);
  const y = handPanel.y + (handPanel.height - layout.cardHeight) / 2;

  const slots = [];
  for (let i = 0; i < HAND_SLOTS; i += 1) {
    slots.push({
      index: i,
      x: startX + i * (layout.cardWidth + layout.gap),
      y,
      width: layout.cardWidth,
      height: layout.cardHeight,
    });
  }

  return slots;
}

function findHandSlotHit(x, y) {
  for (const slot of getHandSlotRects()) {
    if (x >= slot.x && x <= slot.x + slot.width && y >= slot.y && y <= slot.y + slot.height) {
      return slot.index;
    }
  }
  return null;
}

function createInitialEntities() {
  return ALL_TOWER_LAYOUT.map((tower) => createTower(tower));
}

function resetGame() {
  const profile = normalizeProfile(appState.profile);
  if (!profile.unlocked_tiers.includes(appState.selectedBotTier)) {
    appState.selectedBotTier = profile.selected_tier;
  }

  const seedBase = 20260306 + profile.total_matches * 37 + appState.selectedBotTier.length * 13;
  appState.engine = createEngine({
    seed: seedBase,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: createInitialEntities(),
  });

  appState.botRng = createRng(seedBase ^ 0x5f3759df);
  appState.botNextDecisionTick = 1;
  appState.matchRecorded = false;
  appState.pendingTrainingSamples = [];
  appState.pendingActions = [];
  appState.mode = "ready";
  appState.paused = false;
  appState.selectedCardIndex = 0;
  appState.dragState = null;
  appState.suppressNextClick = false;
  appState.lagMs = 0;
  resetVisualState();
  appState.statusMessage = `Ready. Opponent: ${getTierLabel(appState.selectedBotTier)}. Pick a card and click or drag to play.`;
  syncTierSelectOptions();
  refreshProfileSummary();
}

function getSelectedCardId(actor = "blue") {
  const hand = appState.engine.getHand(actor);
  return hand[appState.selectedCardIndex] ?? null;
}

function getPlacementStatus(cardId, worldPosition, actor = "blue") {
  const card = getCard(cardId);
  if (!card) {
    return { ok: false, reason: "Unknown card.", card: null, position: worldPosition };
  }

  const snappedPosition = snapPositionToGrid(worldPosition, arena);

  if (appState.mode !== "playing") {
    return { ok: false, reason: "Press Start to begin.", card, position: snappedPosition };
  }

  const currentElixir = appState.engine.state.elixir[actor]?.elixir ?? 0;
  if (currentElixir < card.cost) {
    return {
      ok: false,
      reason: `Not enough elixir for ${CARD_LABEL[cardId] ?? cardId}.`,
      card,
      position: snappedPosition,
    };
  }

  if (card.type === "troop") {
    if (!arena.isPathable(snappedPosition.x, snappedPosition.y)) {
      return { ok: false, reason: "Troops need a land tile.", card, position: snappedPosition };
    }
    if (actor === "blue" && snappedPosition.y <= arena.river.maxY) {
      return { ok: false, reason: "Troops must be played on your side.", card, position: snappedPosition };
    }
    if (actor === "red" && snappedPosition.y >= arena.river.minY) {
      return { ok: false, reason: "Troops must be played on your side.", card, position: snappedPosition };
    }
  }

  return { ok: true, reason: null, card, position: snappedPosition };
}

function queuePlayerCardPlay(worldPosition, { cardIndex = appState.selectedCardIndex, insideArena = true } = {}) {
  if (appState.mode !== "playing") {
    return false;
  }

  if (!insideArena) {
    appState.statusMessage = "Play cards inside the arena.";
    return false;
  }

  const hand = appState.engine.getHand("blue");
  const cardId = hand[cardIndex] ?? null;
  if (!cardId) {
    appState.statusMessage = "No card in selected slot.";
    return false;
  }

  const placementStatus = getPlacementStatus(cardId, worldPosition, "blue");
  if (!placementStatus.ok) {
    appState.statusMessage = placementStatus.reason;
    return false;
  }

  const currentElixir = appState.engine.state.elixir.blue.elixir;
  const nextTick = appState.engine.state.tick + 1;
  appState.pendingActions.push({
    tick: nextTick,
    type: "PLAY_CARD",
    actor: "blue",
    cardId,
    x: placementStatus.position.x,
    y: placementStatus.position.y,
  });
  appState.selectedCardIndex = cardIndex;

  const sample = createDecisionSample({
    phase: getMatchPhase({
      tick: appState.engine.state.tick,
      isOvertime: appState.engine.state.isOvertime,
    }),
    elixir: currentElixir,
    hand: appState.engine.getHand("blue"),
    cardId,
    tick: nextTick,
    sourceTier: appState.selectedBotTier,
  });
  if (sample) {
    appState.pendingTrainingSamples.push(sample);
  }

  return true;
}

function buildBotActions(tick) {
  if (tick < appState.botNextDecisionTick) {
    return [];
  }

  const legalActions = enumerateLegalCardActions({
    engine: appState.engine,
    actor: "red",
  });
  const decisionDelay = rollDecisionDelayTicks({
    tierId: appState.selectedBotTier,
    rng: appState.botRng,
  });
  appState.botNextDecisionTick = tick + decisionDelay;

  const selected = selectBotAction({
    tierId: appState.selectedBotTier,
    engine: appState.engine,
    actor: "red",
    legalActions,
    rng: appState.botRng,
    trainedModel: appState.selfModel,
  });

  if (!selected || selected.type !== "PLAY_CARD") {
    return [];
  }

  return [
    {
      tick,
      type: "PLAY_CARD",
      actor: "red",
      cardId: selected.cardId,
      x: selected.x,
      y: selected.y,
    },
  ];
}

function formatWinnerStatus(result) {
  const who = result.winner ? `${result.winner.toUpperCase()} wins` : "Draw";
  const score = `${result.score.blue_crowns}-${result.score.red_crowns}`;
  const hp = `${Math.round(result.score.blue_tower_hp)}-${Math.round(result.score.red_tower_hp)}`;
  const reason =
    result.reason === "king_tower_destroyed"
      ? "3-crown finish"
      : result.reason.replaceAll("_", " ");
  return `${who} (${reason}). Crowns ${score}, tower HP ${hp}.`;
}

function appendMatchTrainingSamples() {
  if (appState.pendingTrainingSamples.length === 0) {
    return;
  }

  appState.trainingStore = appendSamples(appState.trainingStore, appState.pendingTrainingSamples);
  persistTrainingStore();
  appState.pendingTrainingSamples = [];
}

function applyMatchProgression(matchResult) {
  if (appState.matchRecorded) {
    return [];
  }

  appendMatchTrainingSamples();

  const progression = recordMatch(appState.profile, {
    opponentTier: appState.selectedBotTier,
    winner: matchResult.winner,
  });

  appState.profile = setSelectedTier(progression.profile, appState.selectedBotTier);
  persistProfile();
  appState.matchRecorded = true;
  syncTierSelectOptions();
  refreshProfileSummary();

  return progression.newlyUnlocked;
}

function stepGameTick() {
  if (appState.mode !== "playing" || appState.paused) {
    return;
  }

  const nextTick = appState.engine.state.tick + 1;

  const playerActions = appState.pendingActions.filter((action) => action.tick === nextTick);
  appState.pendingActions = appState.pendingActions.filter((action) => action.tick > nextTick);

  const botActions = buildBotActions(nextTick);
  appState.engine.step([...playerActions, ...botActions]);
  syncVisualState();

  if (appState.engine.shouldStartOvertime()) {
    appState.engine.setOvertime(true);
    appState.statusMessage = "Overtime started: 3x elixir active.";
    return;
  }

  const matchResult = appState.engine.getMatchResult();
  if (matchResult) {
    appState.mode = "game_over";
    const newlyUnlocked = applyMatchProgression(matchResult);
    const unlockMessage =
      newlyUnlocked.length > 0 ? ` Unlocked: ${newlyUnlocked.map((tierId) => getTierLabel(tierId)).join(", ")}.` : "";
    appState.statusMessage = `${formatWinnerStatus(matchResult)}${unlockMessage}`;
  }
}

function getActivePlacementCardId() {
  if (appState.dragState?.cardId) {
    return appState.dragState.cardId;
  }
  return getSelectedCardId("blue");
}

function pathRoundedRect(x, y, width, height, radius) {
  const rounded = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + rounded, y);
  ctx.arcTo(x + width, y, x + width, y + height, rounded);
  ctx.arcTo(x + width, y + height, x, y + height, rounded);
  ctx.arcTo(x, y + height, x, y, rounded);
  ctx.arcTo(x, y, x + width, y, rounded);
  ctx.closePath();
}

function fillRoundedRect(x, y, width, height, radius, fillStyle, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  pathRoundedRect(x, y, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function strokeRoundedRect(x, y, width, height, radius, strokeStyle, lineWidth = 1, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  pathRoundedRect(x, y, width, height, radius);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
  ctx.restore();
}

function drawShadow(screen, radiusX, radiusY, alpha = 0.18) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.ellipse(screen.x, screen.y + 6, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#1e3e2c";
  ctx.fill();
  ctx.restore();
}

function drawArrowGlyph(x, y, angle, length, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.25, length * 0.16);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-length * 0.48, 0);
  ctx.lineTo(length * 0.38, 0);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(length * 0.12, -length * 0.18);
  ctx.lineTo(length * 0.38, 0);
  ctx.lineTo(length * 0.12, length * 0.18);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-length * 0.48, 0);
  ctx.lineTo(-length * 0.64, -length * 0.2);
  ctx.moveTo(-length * 0.48, 0);
  ctx.lineTo(-length * 0.64, length * 0.2);
  ctx.stroke();
  ctx.restore();
}

function drawCrownIcon(x, y, size, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(-size * 0.5, size * 0.34);
  ctx.lineTo(-size * 0.35, -size * 0.3);
  ctx.lineTo(0, -size * 0.02);
  ctx.lineTo(size * 0.35, -size * 0.34);
  ctx.lineTo(size * 0.5, size * 0.34);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function formatBattleClock(seconds) {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const remainder = clamped % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function getEntityAnimation(entity) {
  return appState.entityAnimations.get(entity.id) ?? null;
}

function getAnimationProgress(animation) {
  if (!animation) {
    return 0;
  }
  const duration = Math.max(1, animation.endTick - animation.startTick);
  return clamp01((appState.engine.state.tick - animation.startTick) / duration);
}

function getEntityFacingAngle(entity, entityLookup, animation = null) {
  const animatedTarget =
    animation && Number.isFinite(animation.targetX) && Number.isFinite(animation.targetY)
      ? { x: animation.targetX, y: animation.targetY }
      : null;
  const liveTarget = entityLookup.get(entity.target_entity_id) ?? null;

  if (animatedTarget) {
    return Math.atan2(animatedTarget.y - entity.y, animatedTarget.x - entity.x);
  }

  if (liveTarget) {
    return Math.atan2(liveTarget.y - entity.y, liveTarget.x - entity.x);
  }

  const vx = entity.velocity?.x ?? 0;
  const vy = entity.velocity?.y ?? 0;
  if (Math.hypot(vx, vy) > 0.01) {
    return Math.atan2(vy, vx);
  }

  return entity.team === "blue" ? -Math.PI * 0.5 : Math.PI * 0.5;
}

function getTroopScale(cardId) {
  if (cardId === "giant") {
    return 16;
  }
  if (cardId === "mini_pekka") {
    return 13.5;
  }
  if (cardId === "knight" || cardId === "musketeer") {
    return 12;
  }
  if (cardId === "archers") {
    return 10.5;
  }
  if (cardId === "goblins") {
    return 9.5;
  }
  return 11;
}

function getTroopPalette(entity) {
  const teamStroke = entity.team === "blue" ? "#5a8eff" : "#ff6b6b";
  const teamFill = entity.team === "blue" ? "#d7e6ff" : "#ffdada";

  if (entity.cardId === "giant") {
    return {
      teamStroke,
      teamFill,
      body: "#d79c58",
      accent: "#7a4f2a",
      skin: "#f2c79d",
      weapon: "#f4e1a7",
      trim: "#734428",
    };
  }

  if (entity.cardId === "knight") {
    return {
      teamStroke,
      teamFill,
      body: "#8aa5c6",
      accent: "#f1cf6d",
      skin: "#f0d5b4",
      weapon: "#dfe8f2",
      trim: "#51698c",
    };
  }

  if (entity.cardId === "mini_pekka") {
    return {
      teamStroke,
      teamFill,
      body: "#72c8df",
      accent: "#1d5b74",
      skin: "#dce9ef",
      weapon: "#f4f8fb",
      trim: "#26475f",
    };
  }

  if (entity.cardId === "archers") {
    return {
      teamStroke,
      teamFill,
      body: "#78b05c",
      accent: "#ddf0b6",
      skin: "#f2d3b4",
      weapon: "#8b5f32",
      trim: "#45642e",
    };
  }

  if (entity.cardId === "musketeer") {
    return {
      teamStroke,
      teamFill,
      body: "#597cb7",
      accent: "#f5d37b",
      skin: "#f2d4bc",
      weapon: "#d8c3a2",
      trim: "#29405f",
    };
  }

  return {
    teamStroke,
    teamFill,
    body: "#6ec857",
    accent: "#def5ba",
    skin: "#8fe16f",
    weapon: "#f2ede4",
    trim: "#376225",
  };
}

function drawHealthBar(entity, screen, width) {
  const hpRatio = clamp01(entity.hp / entity.maxHp);
  const barX = screen.x - width * 0.5;
  const barY = screen.y - getTroopScale(entity.cardId) - 14;
  fillRoundedRect(barX, barY, width, 5, 3, "rgba(13,25,24,0.42)");
  fillRoundedRect(barX, barY, width * hpRatio, 5, 3, "#7ff29d");
  strokeRoundedRect(barX, barY, width, 5, 3, "rgba(255,255,255,0.34)");
}

function drawTowerHealthBar(entity, screen) {
  const hpRatio = clamp01(entity.hp / entity.maxHp);
  const width = entity.tower_role === "king" ? 58 : 46;
  const barX = screen.x - width * 0.5;
  const barY = screen.y - (entity.tower_role === "king" ? 42 : 34);
  fillRoundedRect(barX, barY, width, 6, 3, "rgba(14,19,33,0.46)");
  fillRoundedRect(barX, barY, width * hpRatio, 6, 3, "#7ff29d");
  strokeRoundedRect(barX, barY, width, 6, 3, "rgba(255,255,255,0.38)");
}

function drawArcTrail(centerX, centerY, radius, fromAngle, toAngle, color, alpha = 1, lineWidth = 3) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, fromAngle, toAngle);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function drawTowerPadAt(worldX, worldY, team, towerRole = "crown") {
  const screen = worldToScreen({ x: worldX, y: worldY });
  const padRadius = towerRole === "king" ? 31 : 24;
  drawShadow(screen, padRadius, 10, 0.15);
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.fillStyle = "rgba(222,229,232,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, towerRole === "king" ? 30 : 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(108,117,128,0.9)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, towerRole === "king" ? 20 : 17, 0, Math.PI * 2);
  ctx.fillStyle = team === "blue" ? "rgba(88,140,255,0.2)" : "rgba(255,110,110,0.2)";
  ctx.fill();
  if (towerRole === "king") {
    drawCrownIcon(0, -1, 12, "rgba(244,212,123,0.95)");
  }
  ctx.restore();
}

function drawArenaBackground() {
  const { arenaViewport } = getUiLayout();
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#dff2ff");
  sky.addColorStop(0.45, "#b8e1ff");
  sky.addColorStop(1, "#96c7ff");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  fillRoundedRect(arenaViewport.x - 4, arenaViewport.y - 4, arenaViewport.width + 8, arenaViewport.height + 8, 24, "rgba(42,88,46,0.18)");
  fillRoundedRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height, 20, "#7cc85d");

  ctx.save();
  pathRoundedRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height, 20);
  ctx.clip();

  const grass = ctx.createLinearGradient(0, arenaViewport.y, 0, arenaViewport.y + arenaViewport.height);
  grass.addColorStop(0, "#8fdc69");
  grass.addColorStop(0.45, "#73c85a");
  grass.addColorStop(1, "#5ca847");
  ctx.fillStyle = grass;
  ctx.fillRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height);

  const tileWidth = arenaViewport.width / (arena.maxX - arena.minX);
  const tileHeight = arenaViewport.height / (arena.maxY - arena.minY);
  for (let x = 0; x <= arena.maxX - arena.minX; x += 1) {
    ctx.strokeStyle = x % 3 === 0 ? "rgba(255,255,255,0.08)" : "rgba(18,76,28,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(arenaViewport.x + x * tileWidth, arenaViewport.y);
    ctx.lineTo(arenaViewport.x + x * tileWidth, arenaViewport.y + arenaViewport.height);
    ctx.stroke();
  }

  for (let y = 0; y <= arena.maxY - arena.minY; y += 1) {
    ctx.strokeStyle = y % 4 === 0 ? "rgba(255,255,255,0.08)" : "rgba(21,82,31,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(arenaViewport.x, arenaViewport.y + y * tileHeight);
    ctx.lineTo(arenaViewport.x + arenaViewport.width, arenaViewport.y + y * tileHeight);
    ctx.stroke();
  }

  for (const bridge of arena.bridges) {
    const laneLeft = worldToScreen({ x: bridge.minX, y: arena.minY }).x;
    const laneRight = worldToScreen({ x: bridge.maxX, y: arena.minY }).x;
    const laneWidth = laneRight - laneLeft;
    const laneGradient = ctx.createLinearGradient(laneLeft, 0, laneRight, 0);
    laneGradient.addColorStop(0, "rgba(255,255,255,0)");
    laneGradient.addColorStop(0.5, "rgba(255,255,255,0.08)");
    laneGradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = laneGradient;
    ctx.fillRect(laneLeft, arenaViewport.y, laneWidth, arenaViewport.height);
  }

  const riverTop = worldToScreen({ x: arena.minX, y: arena.river.minY }).y;
  const riverBottom = worldToScreen({ x: arena.minX, y: arena.river.maxY }).y;
  const riverY = (riverTop + riverBottom) * 0.5;
  const riverHeight = Math.max(34, riverBottom - riverTop);
  const riverGradient = ctx.createLinearGradient(0, riverY - riverHeight * 0.5, 0, riverY + riverHeight * 0.5);
  riverGradient.addColorStop(0, "#68d0ff");
  riverGradient.addColorStop(1, "#2d97d7");
  ctx.fillStyle = riverGradient;
  ctx.fillRect(arenaViewport.x, riverY - riverHeight * 0.5, arenaViewport.width, riverHeight);

  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(arenaViewport.x, riverY - riverHeight * 0.18);
  ctx.lineTo(arenaViewport.x + arenaViewport.width, riverY - riverHeight * 0.18);
  ctx.moveTo(arenaViewport.x, riverY + riverHeight * 0.18);
  ctx.lineTo(arenaViewport.x + arenaViewport.width, riverY + riverHeight * 0.18);
  ctx.stroke();

  const bridgeHeight = riverHeight + 12;
  for (const bridge of arena.bridges) {
    const left = worldToScreen({ x: bridge.minX, y: arena.river.centerY }).x;
    const right = worldToScreen({ x: bridge.maxX, y: arena.river.centerY }).x;
    const bridgeWidth = Math.max(48, right - left);
    const bridgeCenter = worldToScreen({ x: bridge.x, y: arena.river.centerY });
    fillRoundedRect(
      bridgeCenter.x - bridgeWidth * 0.5,
      riverY - bridgeHeight * 0.5,
      bridgeWidth,
      bridgeHeight,
      8,
      "#d2b17d",
    );
    ctx.strokeStyle = "rgba(108,80,52,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bridgeCenter.x - bridgeWidth * 0.5, riverY - bridgeHeight * 0.18);
    ctx.lineTo(bridgeCenter.x + bridgeWidth * 0.5, riverY - bridgeHeight * 0.18);
    ctx.moveTo(bridgeCenter.x - bridgeWidth * 0.5, riverY + bridgeHeight * 0.18);
    ctx.lineTo(bridgeCenter.x + bridgeWidth * 0.5, riverY + bridgeHeight * 0.18);
    ctx.stroke();
  }

  for (const tower of ALL_TOWER_LAYOUT) {
    drawTowerPadAt(tower.x, tower.y, tower.team, tower.tower_role);
  }

  const placementCardId = getActivePlacementCardId();
  const placementCard = placementCardId ? getCard(placementCardId) : null;
  if (placementCard?.type === "troop") {
    const splitTop = worldToScreen({ x: arena.minX, y: arena.river.minY }).y;
    const splitBottom = worldToScreen({ x: arena.minX, y: arena.river.maxY }).y;
    ctx.fillStyle = "rgba(98,165,255,0.08)";
    ctx.fillRect(arenaViewport.x, splitBottom, arenaViewport.width, arenaViewport.y + arenaViewport.height - splitBottom);
    ctx.fillStyle = "rgba(255,105,105,0.08)";
    ctx.fillRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, splitTop - arenaViewport.y);
    ctx.setLineDash([12, 7]);
    ctx.strokeStyle = "rgba(255,244,198,0.86)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(arenaViewport.x, splitTop);
    ctx.lineTo(arenaViewport.x + arenaViewport.width, splitTop);
    ctx.moveTo(arenaViewport.x, splitBottom);
    ctx.lineTo(arenaViewport.x + arenaViewport.width, splitBottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  strokeRoundedRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height, 20, "rgba(255,255,255,0.55)", 2);
}

function drawCountdownRing(screen, radius, progress, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, -Math.PI * 0.5, -Math.PI * 0.5 + progress * Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawSpellReticle({ screen, radius, color, progress, label, actor, alpha = 1 }) {
  const teamPalette = getTeamPalette(actor);
  const pulse = 1 + 0.05 * Math.sin(appState.engine.state.tick * 0.35);
  const ringRadius = radius * pulse;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.setLineDash([9, 7]);
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, ringRadius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  drawCountdownRing(screen, ringRadius + 8, progress, color, alpha);
  drawCountdownRing(screen, ringRadius + 14, progress, teamPalette.stroke, alpha * 0.8);

  ctx.beginPath();
  ctx.moveTo(screen.x - 9, screen.y);
  ctx.lineTo(screen.x + 9, screen.y);
  ctx.moveTo(screen.x, screen.y - 9);
  ctx.lineTo(screen.x, screen.y + 9);
  ctx.strokeStyle = `${color}cc`;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = "11px Avenir Next";
  ctx.textAlign = "center";
  ctx.fillStyle = teamPalette.text;
  ctx.fillText(label, screen.x, screen.y - ringRadius - 14);
  ctx.restore();
}

function drawPendingEffects() {
  const tick = appState.engine.state.tick;
  const effects = [...appState.engine.state.pending_effects].sort((a, b) => a.effect_id - b.effect_id);

  for (const effect of effects) {
    const lifeTicks = Math.max(1, effect.resolve_tick - effect.enqueue_tick);
    const elapsedLifeTicks = Math.max(0, tick - effect.enqueue_tick);
    const lifeProgress = clamp01(elapsedLifeTicks / lifeTicks);
    const easeProgress = easeOutCubic(lifeProgress);
    const remainingTicks = Math.max(0, effect.resolve_tick - tick);
    const target = worldToScreen(effect);
    const teamPalette = getTeamPalette(effect.actor);
    const cardAccent = getCardAccent(effect.card_id);
    const fadeAlpha = 0.38 + (1 - lifeProgress) * 0.62;

    if (effect.effect_type === "troop_deploy") {
      const totalTicks = getCard(effect.card_id)?.deploy_time_ticks ?? Math.max(1, effect.resolve_tick - effect.enqueue_tick);
      const progress = clamp01(1 - remainingTicks / Math.max(1, totalTicks));
      const fillRadius = lerp(10, 22, easeProgress);
      ctx.save();
      ctx.globalAlpha = fadeAlpha;
      ctx.beginPath();
      ctx.arc(target.x, target.y, fillRadius, 0, Math.PI * 2);
      ctx.fillStyle = teamPalette.glow;
      ctx.fill();
      ctx.restore();

      drawCountdownRing(target, 24, progress, teamPalette.stroke, fadeAlpha);
      ctx.font = "11px Avenir Next";
      ctx.textAlign = "center";
      ctx.fillStyle = teamPalette.text;
      ctx.fillText(getCardMonogram(effect.card_id), target.x, target.y + 4);
      continue;
    }

    if (effect.effect_type === "spell_arrows") {
      const castTicks = effect.cast_delay_ticks ?? Math.max(1, effect.resolve_tick - effect.enqueue_tick);
      const elapsed = Math.max(0, tick - effect.enqueue_tick);
      const progress = clamp01(elapsed / Math.max(1, castTicks));
      const radius = tilesToPixels(ARROWS_CONFIG.radius_tiles);
      drawSpellReticle({
        screen: target,
        radius,
        color: cardAccent,
        progress,
        label: "ARROWS RAIN",
        actor: effect.actor,
        alpha: fadeAlpha,
      });

      for (let index = 0; index < 12; index += 1) {
        const angle = sampleUnitNoise(effect.effect_id * 19 + index * 7) * Math.PI * 2;
        const distance = radius * Math.sqrt(sampleUnitNoise(effect.effect_id * 29 + index * 11)) * 0.85;
        const fallOffset = lerp(34, 5, progress) + (index % 3) * 3;
        const arrowX = target.x + Math.cos(angle) * distance;
        const arrowY = target.y + Math.sin(angle) * distance - fallOffset;
        drawArrowGlyph(arrowX, arrowY, Math.PI * 0.5, 15, "#ffe6a2", fadeAlpha);
      }
      continue;
    }

    if (effect.effect_type !== "spell_fireball") {
      continue;
    }

    const castTicks = effect.cast_delay_ticks ?? 0;
    const travelTicks = Math.max(1, effect.travel_ticks ?? 1);
    const elapsed = Math.max(0, tick - effect.enqueue_tick);
    const totalDuration = Math.max(1, effect.resolve_tick - effect.enqueue_tick);
    const totalProgress = clamp01(elapsed / totalDuration);
    drawSpellReticle({
      screen: target,
      radius: tilesToPixels(FIREBALL_CONFIG.radius_tiles),
      color: cardAccent,
      progress: totalProgress,
      label: elapsed < castTicks ? "FIREBALL" : "INBOUND",
      actor: effect.actor,
      alpha: fadeAlpha,
    });

    const launchPoint = worldToScreen({
      x: effect.launch_x ?? effect.x,
      y: effect.launch_y ?? effect.y,
    });

    if (elapsed < castTicks) {
      const castProgress = castTicks <= 0 ? 1 : clamp01(elapsed / Math.max(1, castTicks));
      ctx.save();
      ctx.globalAlpha = fadeAlpha;
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(launchPoint.x, launchPoint.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = "rgba(255,203,134,0.85)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      drawCountdownRing(launchPoint, 12, castProgress, teamPalette.stroke, fadeAlpha);
      continue;
    }

    const travelElapsed = Math.max(0, tick - (effect.enqueue_tick + castTicks) + 1);
    const travelProgress = clamp01(travelElapsed / travelTicks);
    const easedTravel = easeOutCubic(travelProgress);
    const projectile = {
      x: lerp(launchPoint.x, target.x, easedTravel),
      y: lerp(launchPoint.y, target.y, easedTravel),
    };

    ctx.save();
    ctx.globalAlpha = fadeAlpha;
    ctx.beginPath();
    ctx.moveTo(launchPoint.x, launchPoint.y);
    ctx.lineTo(projectile.x, projectile.y);
    ctx.strokeStyle = "rgba(255,152,74,0.85)";
    ctx.lineWidth = 4;
    ctx.stroke();

    for (let puff = 0; puff < 3; puff += 1) {
      const puffProgress = Math.max(0, easedTravel - puff * 0.08);
      const puffX = lerp(launchPoint.x, target.x, puffProgress);
      const puffY = lerp(launchPoint.y, target.y, puffProgress);
      ctx.beginPath();
      ctx.arc(puffX, puffY, 5 - puff, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(88,51,45,${0.2 + puff * 0.08})`;
      ctx.fill();
    }

    const glow = ctx.createRadialGradient(projectile.x, projectile.y, 2, projectile.x, projectile.y, 14);
    glow.addColorStop(0, "#fff2d4");
    glow.addColorStop(0.45, "#ff9f4f");
    glow.addColorStop(1, "rgba(255,112,57,0)");
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.restore();
  }
}

function drawTransientEffects() {
  const tick = appState.engine.state.tick;

  for (const effect of appState.transientEffects) {
    const duration = Math.max(1, effect.endTick - effect.startTick);
    const progress = clamp01((tick - effect.startTick) / duration);
    const eased = easeOutCubic(progress);
    const alpha = 1 - progress;

    if (effect.type === "deploy_burst") {
      const screen = worldToScreen(effect);
      const radius = lerp(8, 24, eased);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = effect.actor === "blue" ? "rgba(97,156,255,0.24)" : "rgba(255,114,114,0.22)";
      ctx.fill();
      ctx.restore();
      continue;
    }

    if (effect.type === "hit_spark") {
      const screen = worldToScreen(effect);
      const color = effect.cardId === "goblins" ? "#e8ffbf" : "#fff0cb";
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(screen.x, screen.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (let ray = 0; ray < 6; ray += 1) {
        const angle = (Math.PI * 2 * ray) / 6 + progress * 0.4;
        const inner = 2;
        const outer = lerp(8, 16, eased);
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }

    if (effect.type === "arrow_projectile") {
      const from = worldToScreen({ x: effect.fromX, y: effect.fromY });
      const to = worldToScreen({ x: effect.toX, y: effect.toY });
      const x = lerp(from.x, to.x, eased);
      const y = lerp(from.y, to.y, eased);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(x, y);
      ctx.strokeStyle = "rgba(255,249,210,0.52)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      drawArrowGlyph(x, y, angle, 16, "#fef1b8", alpha);
      continue;
    }

    if (effect.type === "shotgun_blast") {
      const from = worldToScreen({ x: effect.fromX, y: effect.fromY });
      const to = worldToScreen({ x: effect.toX, y: effect.toY });
      const baseAngle = Math.atan2(to.y - from.y, to.x - from.x);
      const coneLength = lerp(12, 34, eased);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(from.x, from.y);
      ctx.rotate(baseAngle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(coneLength, -coneLength * 0.25);
      ctx.lineTo(coneLength * 0.9, coneLength * 0.25);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,224,138,0.78)";
      ctx.fill();
      ctx.restore();

      for (const spread of [-0.16, 0, 0.16]) {
        drawArrowGlyph(from.x + Math.cos(baseAngle) * coneLength, from.y + Math.sin(baseAngle) * coneLength, baseAngle + spread, 10, "#fff3c4", alpha * 0.7);
      }
      continue;
    }

    if (effect.type === "tower_bolt") {
      const from = worldToScreen({ x: effect.fromX, y: effect.fromY });
      const to = worldToScreen({ x: effect.toX, y: effect.toY });
      const x = lerp(from.x, to.x, eased);
      const y = lerp(from.y, to.y, eased);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(x, y);
      ctx.strokeStyle = effect.actor === "blue" ? "#9cd4ff" : "#ffd0c1";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff5dd";
      ctx.fill();
      ctx.restore();
      continue;
    }

    if (effect.type === "fireball_burst") {
      const screen = worldToScreen(effect);
      const radius = lerp(8, tilesToPixels(FIREBALL_CONFIG.radius_tiles), eased);
      ctx.save();
      ctx.globalAlpha = alpha;
      const glow = ctx.createRadialGradient(screen.x, screen.y, 3, screen.x, screen.y, radius);
      glow.addColorStop(0, "#fff3d7");
      glow.addColorStop(0.4, "#ffad51");
      glow.addColorStop(1, "rgba(255,106,62,0)");
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.restore();
      continue;
    }

    if (effect.type === "arrows_burst") {
      const screen = worldToScreen(effect);
      const radius = tilesToPixels(ARROWS_CONFIG.radius_tiles) * 0.75;
      for (let index = 0; index < 9; index += 1) {
        const angle = sampleUnitNoise(index * 17 + effect.startTick) * Math.PI * 2;
        const distance = radius * Math.sqrt(sampleUnitNoise(index * 31 + effect.startTick)) * 0.9;
        drawArrowGlyph(
          screen.x + Math.cos(angle) * distance,
          screen.y + Math.sin(angle) * distance,
          Math.PI * 0.5,
          11,
          "#ffefba",
          alpha,
        );
      }
    }
  }
}

function drawTroop(entity, entityLookup) {
  const tick = appState.engine.state.tick;
  const animation = getEntityAnimation(entity);
  const attackProgress = getAnimationProgress(animation);
  const screen = worldToScreen(entity);
  const palette = getTroopPalette(entity);
  const teamPalette = getTeamPalette(entity.team);
  const scale = getTroopScale(entity.cardId);
  const facing = getEntityFacingAngle(entity, entityLookup, animation) + Math.PI * 0.5;
  const seed = getStringSeed(entity.id);
  const moveStrength = Math.hypot(entity.velocity?.x ?? 0, entity.velocity?.y ?? 0) > 0.01 ? 1 : 0.35;
  const sway = Math.sin(tick * 0.75 + seed * 0.03) * moveStrength;
  const reach = Math.sin(attackProgress * Math.PI);

  drawShadow(screen, scale * 0.88, scale * 0.44);

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(facing);
  ctx.beginPath();
  ctx.arc(0, 0, scale * 0.92, 0, Math.PI * 2);
  ctx.fillStyle = teamPalette.glow;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, scale * 0.76, 0, Math.PI * 2);
  ctx.fillStyle = palette.teamFill;
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(0, 1 + sway * 0.45, scale * 0.72, scale * 0.82, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.body;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, -scale * 0.68 + sway * 0.2, scale * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = palette.skin;
  ctx.fill();

  if (entity.cardId === "giant") {
    const punchY = -scale * (0.32 + reach * 0.78);
    ctx.strokeStyle = palette.trim;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-scale * 0.52, -scale * 0.1);
    ctx.lineTo(-scale * 0.78, scale * 0.28 + sway * 0.25);
    ctx.moveTo(scale * 0.46, -scale * 0.1);
    ctx.lineTo(scale * 0.12, punchY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(scale * 0.12, punchY, scale * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = palette.weapon;
    ctx.fill();

    ctx.fillStyle = palette.accent;
    ctx.fillRect(-scale * 0.4, scale * 0.1, scale * 0.8, scale * 0.14);
  } else if (entity.cardId === "knight") {
    const handleX = scale * 0.34;
    const handleY = -scale * 0.08;
    const swordAngle = lerp(-Math.PI * 0.9, Math.PI * 0.05, reach);
    const swordLength = scale * 1.18;
    const tipX = handleX + Math.cos(swordAngle) * swordLength;
    const tipY = handleY + Math.sin(swordAngle) * swordLength;
    drawArcTrail(handleX, handleY, swordLength * 0.72, -Math.PI * 0.86, swordAngle, "rgba(255,243,189,0.8)", reach * 0.8, 4);
    ctx.strokeStyle = palette.weapon;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(handleX, handleY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-scale * 0.46, 0, scale * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = palette.trim;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-scale * 0.46, 0, scale * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = palette.accent;
    ctx.fill();
  } else if (entity.cardId === "mini_pekka") {
    const handleX = scale * 0.34;
    const handleY = -scale * 0.08;
    const swordAngle = lerp(-Math.PI * 1.05, Math.PI * 0.1, reach);
    const swordLength = scale * 1.42;
    const tipX = handleX + Math.cos(swordAngle) * swordLength;
    const tipY = handleY + Math.sin(swordAngle) * swordLength;
    drawArcTrail(handleX, handleY, swordLength * 0.74, -Math.PI, swordAngle, "rgba(189,248,255,0.82)", reach * 0.85, 5);
    ctx.strokeStyle = palette.weapon;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(handleX, handleY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-scale * 0.3, -scale * 0.92);
    ctx.lineTo(-scale * 0.08, -scale * 1.16);
    ctx.lineTo(0, -scale * 0.86);
    ctx.closePath();
    ctx.moveTo(scale * 0.3, -scale * 0.92);
    ctx.lineTo(scale * 0.08, -scale * 1.16);
    ctx.lineTo(0, -scale * 0.86);
    ctx.closePath();
    ctx.fillStyle = palette.accent;
    ctx.fill();
  } else if (entity.cardId === "archers") {
    const handPull = reach * scale * 0.34;
    ctx.strokeStyle = palette.weapon;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(-scale * 0.2, -scale * 0.08, scale * 0.48, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-scale * 0.2, -scale * 0.56);
    ctx.lineTo(-scale * 0.2 + handPull, scale * 0.04);
    ctx.lineTo(-scale * 0.2, scale * 0.4);
    ctx.stroke();
    ctx.strokeStyle = "#fdf3ca";
    ctx.beginPath();
    ctx.moveTo(-scale * 0.02, -scale * 0.12);
    ctx.lineTo(scale * (0.56 + reach * 0.28), -scale * 0.12);
    ctx.stroke();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(-scale * 0.42, -scale * 0.96, scale * 0.84, scale * 0.18);
  } else if (entity.cardId === "musketeer") {
    const recoil = reach * scale * 0.22;
    ctx.translate(0, recoil);
    ctx.strokeStyle = palette.weapon;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(scale * 0.08, -scale * 0.06);
    ctx.lineTo(scale * 0.92, -scale * 0.22);
    ctx.stroke();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(-scale * 0.54, -scale * 1.04, scale * 1.08, scale * 0.2);
  } else if (entity.cardId === "goblins") {
    const knifeY = -scale * (0.2 + reach * 0.92);
    ctx.strokeStyle = palette.weapon;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(scale * 0.18, -scale * 0.06);
    ctx.lineTo(scale * 0.18, knifeY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(scale * 0.18, knifeY);
    ctx.lineTo(scale * 0.34, knifeY - scale * 0.14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-scale * 0.18, -scale * 0.88, scale * 0.11, 0, Math.PI * 2);
    ctx.arc(scale * 0.18, -scale * 0.88, scale * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = palette.trim;
    ctx.fill();
  }

  ctx.strokeStyle = palette.teamStroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, scale * 0.76, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  drawHealthBar(entity, screen, scale * 1.9);
}

function drawTower(entity, entityLookup) {
  const screen = worldToScreen(entity);
  const teamPalette = getTeamPalette(entity.team);
  const target = entityLookup.get(entity.target_entity_id) ?? null;
  const angle = target ? Math.atan2(target.y - entity.y, target.x - entity.x) : (entity.team === "blue" ? -Math.PI * 0.5 : Math.PI * 0.5);
  const isKing = entity.tower_role === "king";
  const towerWidth = isKing ? 34 : 26;
  const towerHeight = isKing ? 40 : 30;
  drawShadow(screen, isKing ? 28 : 22, 10, 0.14);

  ctx.save();
  ctx.translate(screen.x, screen.y);
  fillRoundedRect(-towerWidth * 0.5, -towerHeight * 0.25, towerWidth, towerHeight, 6, "#dfe3e7");
  strokeRoundedRect(-towerWidth * 0.5, -towerHeight * 0.25, towerWidth, towerHeight, 6, "rgba(92,103,112,0.92)", 2);
  fillRoundedRect(-towerWidth * 0.38, -towerHeight * 0.5, towerWidth * 0.76, towerHeight * 0.3, 4, entity.team === "blue" ? "#5a8eff" : "#ff6969");
  fillRoundedRect(-towerWidth * 0.24, towerHeight * 0.08, towerWidth * 0.48, towerHeight * 0.18, 4, "rgba(86,96,112,0.9)");

  ctx.save();
  ctx.rotate(angle);
  fillRoundedRect(-4, -towerHeight * 0.52, 8, isKing ? 20 : 16, 4, entity.is_active === false ? "#8f9cab" : "#a0a8b2");
  ctx.fillStyle = entity.is_active === false ? "#71808f" : "#55626d";
  ctx.fillRect(-3, -towerHeight * 0.72, 6, 12);
  ctx.restore();

  if (isKing) {
    drawCrownIcon(0, -towerHeight * 0.12, 10, "#f6dd84", entity.is_active === false ? 0.65 : 1);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.font = "10px Avenir Next";
    ctx.textAlign = "center";
    ctx.fillText("CT", 0, 4);
  }

  if (isKing && entity.is_active === false) {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "10px Avenir Next";
    ctx.fillText("zzz", 0, 16);
  }
  ctx.restore();

  drawTowerHealthBar(entity, screen);
}

function drawEntity(entity, entityLookup) {
  if (entity.hp <= 0) {
    return;
  }

  if (entity.entity_type === "tower") {
    drawTower(entity, entityLookup);
    return;
  }

  drawTroop(entity, entityLookup);
}

function drawPlacementPreview() {
  const drag = appState.dragState;
  if (!drag || !drag.isDragging) {
    return;
  }

  const card = getCard(drag.cardId);
  if (!card) {
    return;
  }

  const handLayout = getHandLayout();
  const pointer = { x: drag.currentX, y: drag.currentY };
  const pointerInArena = isPointInArenaViewport(pointer);
  const world = screenToWorld(pointer);
  const placementStatus = pointerInArena
    ? getPlacementStatus(drag.cardId, world, "blue")
    : { ok: false, reason: "Play cards inside the arena.", position: snapPositionToGrid(world, arena) };
  const screen = worldToScreen(placementStatus.position);
  const legal = placementStatus.ok;
  const stroke = legal ? "#7bffb2" : "#ffb1b1";
  const fill = legal ? "rgba(98, 216, 144, 0.24)" : "rgba(255, 108, 108, 0.24)";
  const label = CARD_LABEL[drag.cardId] ?? drag.cardId;
  const radius =
    card.type === "spell"
      ? tilesToPixels(card.id === "fireball" ? FIREBALL_CONFIG.radius_tiles : ARROWS_CONFIG.radius_tiles)
      : 18;

  const originSlot = getHandSlotRects().find((slot) => slot.index === drag.slotIndex);
  if (originSlot) {
    ctx.save();
    ctx.globalAlpha = 0.68;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(originSlot.x + originSlot.width / 2, originSlot.y + originSlot.height / 2);
    ctx.lineTo(screen.x, screen.y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = "12px Avenir Next";
  ctx.textAlign = "center";
  ctx.fillStyle = "#f6f9ff";
  ctx.fillText(label, screen.x, screen.y - radius - 14);
  if (!legal && placementStatus.reason) {
    ctx.fillStyle = "#ffdede";
    ctx.fillText(placementStatus.reason, screen.x, screen.y + radius + 18);
  }
  ctx.restore();

  const ghostWidth = Math.max(96, handLayout.cardWidth);
  const ghostHeight = Math.max(42, Math.round(handLayout.cardHeight * 0.8));
  const ghostX = Math.min(getCanvasWidth() - ghostWidth - 10, drag.currentX + 16);
  const ghostY = Math.max(10, drag.currentY - ghostHeight - 16);
  const cost = card.cost ?? 0;

  fillRoundedRect(ghostX, ghostY, ghostWidth, ghostHeight, 12, legal ? "rgba(26,55,102,0.96)" : "rgba(88,34,34,0.95)");
  strokeRoundedRect(ghostX, ghostY, ghostWidth, ghostHeight, 12, legal ? "rgba(123,255,171,0.9)" : "rgba(255,156,156,0.9)", 2);
  ctx.fillStyle = "#f6f9ff";
  ctx.textAlign = "left";
  ctx.font = `${handLayout.titleFont}px Avenir Next`;
  ctx.fillText(label, ghostX + 8, ghostY + Math.min(16, ghostHeight * 0.45));
  ctx.textAlign = "right";
  ctx.font = `${Math.max(10, handLayout.auxFont)}px Avenir Next`;
  ctx.fillStyle = "#f7d165";
  ctx.fillText(`${cost} elixir`, ghostX + ghostWidth - 8, ghostY + Math.min(16, ghostHeight * 0.45));
}

function drawElixirPips({ x, y, actor, amount, gemSize = 9, gemGap = 4, labelFont = 10, label = null }) {
  const color = actor === "blue" ? "#78b2ff" : "#ff8c8c";
  const step = gemSize + gemGap;

  ctx.font = `${labelFont}px Avenir Next`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#f4f8ff";
  ctx.fillText(label ?? `${actor.toUpperCase()} ELIXIR`, x, y);

  for (let index = 0; index < MAX_ELIXIR; index += 1) {
    const gemX = x + index * step + gemSize * 0.5;
    const gemY = y + 12;
    ctx.save();
    ctx.translate(gemX, gemY);
    ctx.rotate(Math.PI * 0.25);
    ctx.fillStyle = index < amount ? color : "rgba(255,255,255,0.18)";
    ctx.fillRect(-gemSize * 0.5, -gemSize * 0.5, gemSize, gemSize);
    ctx.strokeStyle = index < amount ? "rgba(255,255,255,0.74)" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-gemSize * 0.5, -gemSize * 0.5, gemSize, gemSize);
    ctx.restore();
  }
}

function drawHand() {
  const { handPanel, isCompact } = getUiLayout();
  const hand = appState.engine.getHand("blue");
  const deckQueue = appState.engine.getDeckQueue("blue");
  const slots = getHandSlotRects();
  const layout = getHandLayout();
  const nextCardRect = getNextCardRect();
  const dragIndex = appState.dragState?.slotIndex ?? null;
  const nextCardId = deckQueue[0] ?? null;
  const nextCard = nextCardId ? getCard(nextCardId) : null;

  fillRoundedRect(handPanel.x, handPanel.y, handPanel.width, handPanel.height, 18, "rgba(31,43,78,0.86)");
  strokeRoundedRect(handPanel.x, handPanel.y, handPanel.width, handPanel.height, 18, "rgba(255,255,255,0.24)", 1.5);

  fillRoundedRect(nextCardRect.x, nextCardRect.y, nextCardRect.width, nextCardRect.height, 14, "rgba(16,23,44,0.86)");
  strokeRoundedRect(nextCardRect.x, nextCardRect.y, nextCardRect.width, nextCardRect.height, 14, "rgba(255,255,255,0.2)", 1.2);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.textAlign = "center";
  ctx.font = `${Math.max(8, layout.auxFont)}px Avenir Next`;
  ctx.fillText("NEXT", nextCardRect.x + nextCardRect.width * 0.5, nextCardRect.y + 14);
  if (nextCard) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.max(11, layout.titleFont + 3)}px Avenir Next`;
    ctx.fillText(getCardMonogram(nextCardId), nextCardRect.x + nextCardRect.width * 0.5, nextCardRect.y + nextCardRect.height * 0.55);
    ctx.font = `${Math.max(8, layout.auxFont)}px Avenir Next`;
    ctx.fillStyle = "#f7d165";
    ctx.fillText(String(nextCard.cost), nextCardRect.x + nextCardRect.width * 0.5, nextCardRect.y + nextCardRect.height - 10);
  }

  for (const slot of slots) {
    const cardId = hand[slot.index] ?? null;
    const card = cardId ? getCard(cardId) : null;
    const isSelected = slot.index === appState.selectedCardIndex;
    const affordable = card ? appState.engine.state.elixir.blue.elixir >= card.cost : false;
    const isDraggingCard = appState.dragState?.isDragging && dragIndex === slot.index;
    const accent = getCardAccent(cardId);
    const lift = isSelected ? 6 : 0;

    ctx.save();
    ctx.globalAlpha = isDraggingCard ? 0.45 : 1;
    fillRoundedRect(slot.x, slot.y - lift, slot.width, slot.height, 14, isSelected ? "rgba(255,255,255,0.22)" : "rgba(16,23,44,0.8)");
    fillRoundedRect(slot.x, slot.y - lift, slot.width, 8, 14, accent, affordable ? 1 : 0.55);
    strokeRoundedRect(slot.x, slot.y - lift, slot.width, slot.height, 14, isSelected ? "#fff3c2" : "rgba(255,255,255,0.24)", isSelected ? 2.2 : 1.4);
    ctx.restore();

    if (!card) {
      continue;
    }

    const narrowCard = slot.width < 96;
    const title = fitTextToWidth(CARD_LABEL[cardId] ?? cardId, slot.width - 20);
    const glyphY = slot.y - lift + slot.height * (isCompact ? 0.52 : 0.5);
    ctx.fillStyle = affordable ? "#ffffff" : "#bcc8dc";
    ctx.textAlign = "center";
    ctx.font = `${Math.max(14, layout.titleFont + 6)}px Avenir Next`;
    ctx.fillText(getCardMonogram(cardId), slot.x + slot.width * 0.5, glyphY);

    ctx.font = `${layout.titleFont}px Avenir Next`;
    ctx.fillText(title, slot.x + slot.width * 0.5, slot.y - lift + slot.height - 14);

    fillRoundedRect(slot.x + 6, slot.y - lift + 6, 22, 18, 9, "rgba(13,20,38,0.8)");
    strokeRoundedRect(slot.x + 6, slot.y - lift + 6, 22, 18, 9, "rgba(255,255,255,0.2)", 1);
    ctx.fillStyle = "#f7d165";
    ctx.font = `${Math.max(10, layout.auxFont)}px Avenir Next`;
    ctx.fillText(String(card.cost), slot.x + 17, slot.y - lift + 19);

    if (!narrowCard) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = `${layout.auxFont}px Avenir Next`;
      ctx.fillText(String(slot.index + 1), slot.x + slot.width - 12, slot.y - lift + 19);
    }
  }
}

function drawHud() {
  const tick = appState.engine.state.tick;
  const phase = getMatchPhase({ tick, isOvertime: appState.engine.state.isOvertime });
  const regulationRemaining = Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(tick, MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, tick - MATCH_CONFIG.regulation_ticks);
  const overtimeRemaining = Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed);
  const activeClock = phase === "overtime" ? overtimeRemaining / TICK_RATE : regulationRemaining / TICK_RATE;
  const score = appState.engine.getScore();
  const { infoPanel, statusPanel, isCompact } = getUiLayout();
  const pipSize = isCompact ? 6 : 7;
  const pipGap = isCompact ? 2 : 3;
  const labelFont = isCompact ? 7 : 8;
  const clockText = formatBattleClock(activeClock);
  const centerWidth = Math.min(176, infoPanel.width * 0.22);
  const leftWidth = Math.min(190, infoPanel.width * 0.28);
  const rightWidth = leftWidth;

  fillRoundedRect(infoPanel.x, infoPanel.y, infoPanel.width, infoPanel.height, 18, "rgba(20,31,58,0.84)");
  strokeRoundedRect(infoPanel.x, infoPanel.y, infoPanel.width, infoPanel.height, 18, "rgba(255,255,255,0.24)", 1.2);

  fillRoundedRect(infoPanel.x + 8, infoPanel.y + 7, leftWidth, infoPanel.height - 14, 14, "rgba(62,118,225,0.9)");
  fillRoundedRect(infoPanel.x + infoPanel.width - rightWidth - 8, infoPanel.y + 7, rightWidth, infoPanel.height - 14, 14, "rgba(223,90,90,0.9)");
  fillRoundedRect(infoPanel.x + (infoPanel.width - centerWidth) * 0.5, infoPanel.y + 6, centerWidth, infoPanel.height - 12, 14, "rgba(14,21,40,0.94)");

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.font = `${isCompact ? 10 : 11}px Avenir Next`;
  ctx.fillText("YOU", infoPanel.x + 18, infoPanel.y + 22);
  ctx.font = `${isCompact ? 9 : 10}px Avenir Next`;
  ctx.fillText(getTierLabel(appState.selectedBotTier), infoPanel.x + infoPanel.width - rightWidth + 10, infoPanel.y + 22);

  for (let index = 0; index < 3; index += 1) {
    drawCrownIcon(
      infoPanel.x + 22 + index * 16,
      infoPanel.y + infoPanel.height * 0.58,
      10,
      index < score.blue_crowns ? "#ffe181" : "rgba(255,255,255,0.28)",
    );
    drawCrownIcon(
      infoPanel.x + infoPanel.width - rightWidth + 18 + index * 16,
      infoPanel.y + infoPanel.height * 0.58,
      10,
      index < score.red_crowns ? "#ffe181" : "rgba(255,255,255,0.28)",
    );
  }

  ctx.textAlign = "center";
  ctx.font = `${isCompact ? 13 : 16}px Avenir Next`;
  ctx.fillText(clockText, infoPanel.x + infoPanel.width * 0.5, infoPanel.y + 22);
  ctx.font = `${isCompact ? 8 : 10}px Avenir Next`;
  ctx.fillStyle = "#dbe6ff";
  ctx.fillText(phase === "overtime" ? "OVERTIME" : "BATTLE", infoPanel.x + infoPanel.width * 0.5, infoPanel.y + infoPanel.height * 0.65);

  if (phase === "overtime") {
    fillRoundedRect(infoPanel.x + infoPanel.width * 0.5 - 40, infoPanel.y + infoPanel.height - 22, 80, 16, 8, "rgba(255,204,117,0.2)");
    ctx.fillStyle = "#ffe4a7";
    ctx.fillText("3x ELIXIR", infoPanel.x + infoPanel.width * 0.5, infoPanel.y + infoPanel.height - 10);
  }

  drawElixirPips({
    x: infoPanel.x + 18,
    y: infoPanel.y + infoPanel.height - 22,
    actor: "blue",
    amount: appState.engine.state.elixir.blue.elixir,
    gemSize: pipSize,
    gemGap: pipGap,
    labelFont,
    label: "ELIXIR",
  });
  drawElixirPips({
    x: infoPanel.x + infoPanel.width - rightWidth + 10,
    y: infoPanel.y + infoPanel.height - 22,
    actor: "red",
    amount: appState.engine.state.elixir.red.elixir,
    gemSize: pipSize,
    gemGap: pipGap,
    labelFont,
    label: "ELIXIR",
  });

  fillRoundedRect(statusPanel.x, statusPanel.y, statusPanel.width, statusPanel.height, 12, "rgba(18,27,52,0.75)");
  strokeRoundedRect(statusPanel.x, statusPanel.y, statusPanel.width, statusPanel.height, 12, "rgba(255,255,255,0.24)", 1);
  ctx.textAlign = "left";
  ctx.fillStyle = "#f6f9ff";
  ctx.font = `${isCompact ? 9 : 11}px Avenir Next`;
  const controlHint = isCompact ? "Tap or drag to deploy" : "Drag or tap a card to place on your side";
  const status = fitTextToWidth(`${controlHint} | ${appState.statusMessage}`, statusPanel.width - 16);
  ctx.fillText(status, statusPanel.x + 8, statusPanel.y + Math.round(statusPanel.height * 0.68));
}

function render() {
  drawArenaBackground();

  const arenaViewport = getArenaViewport();
  const renderEntities = appState.engine.state.entities
    .filter((entity) => entity.hp > 0)
    .sort((a, b) => {
      if (a.y !== b.y) {
        return a.y - b.y;
      }
      return a.id.localeCompare(b.id);
    });
  const entityLookup = new Map(renderEntities.map((entity) => [entity.id, entity]));

  ctx.save();
  pathRoundedRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height, 20);
  ctx.clip();
  drawPendingEffects();
  for (const entity of renderEntities) {
    drawEntity(entity, entityLookup);
  }
  drawTransientEffects();
  ctx.restore();

  drawPlacementPreview();
  drawHand();
  drawHud();
}

function runTicks(count) {
  for (let i = 0; i < count; i += 1) {
    stepGameTick();
  }
  render();
}

function frame(now) {
  const elapsed = now - appState.lastFrameTime;
  appState.lastFrameTime = now;

  if (appState.mode === "playing" && !appState.paused) {
    appState.lagMs += elapsed;
    const tickDurationMs = 1000 / TICK_RATE;
    while (appState.lagMs >= tickDurationMs) {
      stepGameTick();
      appState.lagMs -= tickDurationMs;
    }
  }

  render();
  requestAnimationFrame(frame);
}

function getCanvasPointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * getCanvasWidth(),
    y: ((event.clientY - rect.top) / rect.height) * getCanvasHeight(),
  };
}

function clearDragState() {
  appState.dragState = null;
}

canvas.addEventListener("pointerdown", (event) => {
  const point = getCanvasPointFromEvent(event);
  const slotHit = findHandSlotHit(point.x, point.y);
  if (slotHit === null) {
    return;
  }

  const hand = appState.engine.getHand("blue");
  const cardId = hand[slotHit] ?? null;
  appState.selectedCardIndex = slotHit;
  if (!cardId) {
    return;
  }

  appState.dragState = {
    pointerId: event.pointerId,
    slotIndex: slotHit,
    cardId,
    startX: point.x,
    startY: point.y,
    currentX: point.x,
    currentY: point.y,
    isDragging: false,
  };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const drag = appState.dragState;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  const point = getCanvasPointFromEvent(event);
  drag.currentX = point.x;
  drag.currentY = point.y;

  const distance = Math.hypot(point.x - drag.startX, point.y - drag.startY);
  if (!drag.isDragging && distance >= DRAG_START_DISTANCE) {
    drag.isDragging = true;
  }

  if (drag.isDragging) {
    const placementStatus = isPointInArenaViewport(point)
      ? getPlacementStatus(drag.cardId, screenToWorld(point), "blue")
      : { ok: false, reason: "Play cards inside the arena." };
    appState.statusMessage = placementStatus.ok
      ? `Release to play ${CARD_LABEL[drag.cardId] ?? drag.cardId}.`
      : placementStatus.reason;
  }
});

canvas.addEventListener("pointerup", (event) => {
  const drag = appState.dragState;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  const point = getCanvasPointFromEvent(event);
  const slotHit = findHandSlotHit(point.x, point.y);

  if (drag.isDragging) {
    if (slotHit !== null) {
      appState.selectedCardIndex = slotHit;
      appState.statusMessage = "Card selection updated.";
    } else {
      const played = queuePlayerCardPlay(screenToWorld(point), {
        cardIndex: drag.slotIndex,
        insideArena: isPointInArenaViewport(point),
      });
      if (played) {
        appState.statusMessage = `Played ${CARD_LABEL[drag.cardId] ?? drag.cardId}.`;
      }
    }
    appState.suppressNextClick = true;
  }

  clearDragState();
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointercancel", (event) => {
  const drag = appState.dragState;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  clearDragState();
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener("click", (event) => {
  if (appState.suppressNextClick) {
    appState.suppressNextClick = false;
    return;
  }

  const { x, y } = getCanvasPointFromEvent(event);

  const slotHit = findHandSlotHit(x, y);
  if (slotHit !== null) {
    appState.selectedCardIndex = slotHit;
    return;
  }

  queuePlayerCardPlay(screenToWorld({ x, y }), { insideArena: isPointInArenaViewport({ x, y }) });
});

startBtn.addEventListener("click", () => {
  const profile = normalizeProfile(appState.profile);
  if (!profile.unlocked_tiers.includes(appState.selectedBotTier)) {
    appState.statusMessage = `${getTierLabel(appState.selectedBotTier)} is locked. Beat lower tiers first.`;
    syncTierSelectOptions();
    return;
  }

  appState.profile = setSelectedTier(profile, appState.selectedBotTier);
  persistProfile();
  refreshProfileSummary();

  if (appState.mode === "game_over") {
    resetGame();
  }

  appState.mode = "playing";
  appState.paused = false;
  appState.lagMs = 0;
  appState.statusMessage = `Battle started vs ${getTierLabel(appState.selectedBotTier)}. Cycle cards to pressure towers.`;
});

resetBtn.addEventListener("click", () => {
  resetGame();
});

botTierSelect.addEventListener("change", () => {
  const requestedTier = normalizeBotTierId(botTierSelect.value);
  const profile = normalizeProfile(appState.profile);

  if (!profile.unlocked_tiers.includes(requestedTier)) {
    appState.statusMessage = `${getTierLabel(requestedTier)} is locked.`;
    syncTierSelectOptions();
    return;
  }

  appState.selectedBotTier = requestedTier;
  appState.profile = setSelectedTier(profile, requestedTier);
  persistProfile();
  refreshProfileSummary();

  if (appState.mode === "ready") {
    appState.statusMessage = `Ready. Opponent: ${getTierLabel(appState.selectedBotTier)}.`;
  }
});

trainBtn.addEventListener("click", () => {
  const model = trainSelfModel(appState.trainingStore.samples);
  appState.selfModel = model;
  persistSelfModel();
  refreshProfileSummary();

  if (model.ready) {
    appState.statusMessage = `Self-play model trained (${model.sample_count} samples).`;
    return;
  }

  const remaining = Math.max(0, model.min_samples_required - model.sample_count);
  appState.statusMessage = `Need ${remaining} more samples before self model is ready.`;
});

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    appState.paused = !appState.paused;
    return;
  }

  if (["1", "2", "3", "4"].includes(event.key)) {
    appState.selectedCardIndex = Number.parseInt(event.key, 10) - 1;
    return;
  }

  if (event.key.toLowerCase() === "r") {
    resetGame();
    return;
  }

  if (event.key.toLowerCase() === "f") {
    if (!document.fullscreenElement) {
      canvas.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }
});

window.addEventListener("resize", () => {
  resizeCanvasToDisplaySize();
  render();
});

document.addEventListener("fullscreenchange", () => {
  resizeCanvasToDisplaySize();
  render();
});

window.advanceTime = (ms) => {
  const tickCount = Math.max(1, Math.round(ms / (1000 / TICK_RATE)));
  const previousMode = appState.mode;
  if (appState.mode === "ready") {
    appState.mode = "playing";
  }
  runTicks(tickCount);
  if (previousMode === "ready" && appState.mode === "playing") {
    appState.mode = "ready";
  }
};

window.render_game_to_text = () => {
  const tick = appState.engine.state.tick;
  const phase = getMatchPhase({ tick, isOvertime: appState.engine.state.isOvertime });
  const regulationRemaining = Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(tick, MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, tick - MATCH_CONFIG.regulation_ticks);
  const overtimeRemaining = Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed);

  return JSON.stringify({
    coordinate_system: {
      origin: "top-left",
      axis_x: "right",
      axis_y: "down",
      world_bounds: { min_x: arena.minX, max_x: arena.maxX, min_y: arena.minY, max_y: arena.maxY },
    },
    bot_tier: appState.selectedBotTier,
    unlocked_tiers: normalizeProfile(appState.profile).unlocked_tiers,
    training: {
      samples: appState.trainingStore.samples.length,
      model_ready: Boolean(appState.selfModel?.ready),
    },
    mode: appState.mode,
    tick,
    phase,
    elixir: {
      blue: appState.engine.state.elixir.blue.elixir,
      red: appState.engine.state.elixir.red.elixir,
    },
    hand: {
      blue: appState.engine.getHand("blue"),
      blue_selected_index: appState.selectedCardIndex,
      blue_next_card: appState.engine.getDeckQueue("blue")[0] ?? null,
      blue_draw_queue: appState.engine.getDeckQueue("blue"),
      red: appState.engine.getHand("red"),
      red_next_card: appState.engine.getDeckQueue("red")[0] ?? null,
      red_draw_queue: appState.engine.getDeckQueue("red"),
    },
    timers: {
      regulation_remaining_s: Number((regulationRemaining / TICK_RATE).toFixed(2)),
      overtime_remaining_s: Number((overtimeRemaining / TICK_RATE).toFixed(2)),
    },
    score: appState.engine.getScore(),
    match_result: appState.engine.getMatchResult(),
    pending_effects: appState.engine.state.pending_effects.map((effect) => ({
      effect_id: effect.effect_id,
      effect_type: effect.effect_type,
      actor: effect.actor,
      card_id: effect.card_id,
      enqueue_tick: effect.enqueue_tick,
      resolve_tick: effect.resolve_tick,
      x: effect.x,
      y: effect.y,
      launch_x: effect.launch_x ?? null,
      launch_y: effect.launch_y ?? null,
      cast_delay_ticks: effect.cast_delay_ticks ?? null,
      travel_ticks: effect.travel_ticks ?? null,
    })),
    entities: appState.engine.state.entities
      .filter((entity) => entity.hp > 0)
      .map((entity) => ({
        id: entity.id,
        card_id: entity.cardId,
        entity_type: entity.entity_type,
        team: entity.team,
        tower_role: entity.tower_role ?? null,
        is_active: entity.is_active ?? null,
        hp: entity.hp,
        x: entity.x,
        y: entity.y,
        velocity: entity.velocity,
        target_entity_id: entity.target_entity_id,
        attack_cooldown_ticks_remaining: entity.attack_cooldown_ticks_remaining,
        forced_motion_ticks_remaining: entity.forced_motion_ticks_remaining,
      })),
  });
};

hydrateAppState();
resetGame();
resizeCanvasToDisplaySize();
render();
requestAnimationFrame(frame);
