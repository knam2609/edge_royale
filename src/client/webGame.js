import { getCard } from "../sim/cards.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTower } from "../sim/entities.js";
import { createRoyaleArena, snapPositionToGrid } from "../sim/map.js";
import { createRng } from "../sim/random.js";
import { getTowerStats } from "../sim/stats.js";
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
import {
  computePortraitBattleLayout,
  findHandSlotHit as findHandSlotHitForLayout,
  pointInRect,
  viewportToWorld,
  worldToViewport,
} from "./layout.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("reset-btn");
const trainBtn = document.getElementById("train-btn");
const botTierSelect = document.getElementById("bot-tier-select");
const profileSummary = document.getElementById("profile-summary");
const setupOverlay = document.getElementById("setup-overlay");
const setupTitle = document.getElementById("setup-title");
const setupSubtitle = document.getElementById("setup-subtitle");

const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
const WORLD_BOUNDS = Object.freeze({
  minX: arena.minX,
  maxX: arena.maxX,
  minY: arena.minY,
  maxY: arena.maxY,
});

const MAX_ELIXIR = 10;
const PROFILE_STORAGE_KEY = "edge_royale_profile_v1";
const TRAINING_STORAGE_KEY = "edge_royale_training_data_v1";
const SELF_MODEL_STORAGE_KEY = "edge_royale_self_model_v1";
const HAND_SLOTS = 4;
const DRAG_START_DISTANCE = 8;
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
    Object.freeze({ id: "blue_crown_left", team: "blue", tower_role: "crown", x: 5, y: 26, hp: getTowerStats("crown").hp }),
    Object.freeze({ id: "blue_crown_right", team: "blue", tower_role: "crown", x: 13, y: 26, hp: getTowerStats("crown").hp }),
    Object.freeze({ id: "blue_king", team: "blue", tower_role: "king", x: 9, y: 30, hp: getTowerStats("king").hp, is_active: false }),
  ]),
  red: Object.freeze([
    Object.freeze({ id: "red_crown_left", team: "red", tower_role: "crown", x: 5, y: 6, hp: getTowerStats("crown").hp }),
    Object.freeze({ id: "red_crown_right", team: "red", tower_role: "crown", x: 13, y: 6, hp: getTowerStats("crown").hp }),
    Object.freeze({ id: "red_king", team: "red", tower_role: "king", x: 9, y: 2, hp: getTowerStats("king").hp, is_active: false }),
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

function syncSetupOverlay() {
  const showOverlay = appState.mode !== "playing";
  setupOverlay.hidden = !showOverlay;
  setupOverlay.setAttribute("aria-hidden", showOverlay ? "false" : "true");
  setupTitle.textContent = appState.mode === "game_over" ? "Battle Finished" : "Edge Royale";
  setupSubtitle.textContent =
    appState.mode === "game_over"
      ? appState.statusMessage
      : "Portrait battle frame calibrated to the Clash Royale arena reference.";
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

let cachedBattleLayoutKey = "";
let cachedBattleLayout = null;

function getBattleLayout() {
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const cacheKey = `${width}x${height}`;
  if (cacheKey !== cachedBattleLayoutKey || !cachedBattleLayout) {
    cachedBattleLayout = computePortraitBattleLayout(width, height);
    cachedBattleLayoutKey = cacheKey;
  }
  return cachedBattleLayout;
}

function worldToScreen(position) {
  return worldToViewport(position, WORLD_BOUNDS, getArenaViewport());
}

function screenToWorld(position) {
  return viewportToWorld(position, WORLD_BOUNDS, getArenaViewport());
}

function getUiLayout() {
  const layout = getBattleLayout();
  return {
    ...layout,
    isCompact: layout.scale < 0.72,
  };
}

function getArenaViewport() {
  return getBattleLayout().arenaViewport;
}

function getLayoutScale() {
  return getBattleLayout().scale;
}

function isPointInArenaViewport(point) {
  return pointInRect(point, getArenaViewport());
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
  const layout = getBattleLayout();
  const firstSlot = layout.handSlots[0];
  const secondSlot = layout.handSlots[1];
  const gap = secondSlot.x - firstSlot.x - firstSlot.width;
  const cardScale = layout.scale;

  return {
    cardWidth: firstSlot.width,
    cardHeight: firstSlot.height,
    gap,
    titleFont: Math.max(11, Math.round(20 * cardScale)),
    auxFont: Math.max(8, Math.round(13 * cardScale)),
    nextCardWidth: layout.nextCardRect.width,
    nextCardGap: firstSlot.x - (layout.nextCardRect.x + layout.nextCardRect.width),
  };
}

function getNextCardRect() {
  return getBattleLayout().nextCardRect;
}

function getHandSlotRects() {
  return getBattleLayout().handSlots.map((slot, index) => ({ ...slot, index }));
}

function findHandSlotHit(x, y) {
  return findHandSlotHitForLayout(getBattleLayout(), { x, y });
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

function drawOutlinedText(
  text,
  x,
  y,
  {
    font = "12px Trebuchet MS",
    fillStyle = "#ffffff",
    strokeStyle = "rgba(11,16,29,0.9)",
    lineWidth = 3,
    textAlign = "center",
  } = {},
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = textAlign;
  ctx.lineJoin = "round";
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCardCostBadge(centerX, centerY, radius, cost, alpha = 1) {
  const gradient = ctx.createLinearGradient(centerX, centerY - radius, centerX, centerY + radius);
  gradient.addColorStop(0, "#f56dff");
  gradient.addColorStop(1, "#9d22c9");

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "#4f0f67";
  ctx.lineWidth = Math.max(1.2, radius * 0.18);
  ctx.stroke();
  drawOutlinedText(String(cost), centerX, centerY + radius * 0.3, {
    font: `${Math.max(10, radius * 1.04)}px Trebuchet MS`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(67,13,83,0.95)",
    lineWidth: Math.max(1.6, radius * 0.2),
  });
  ctx.restore();
}

function drawCardPortrait(cardId, rect, { affordable = true, alpha = 1 } = {}) {
  if (!cardId) {
    return;
  }

  const accent = getCardAccent(cardId);
  const radius = Math.min(rect.width, rect.height) * 0.18;
  const centerX = rect.x + rect.width * 0.5;
  const centerY = rect.y + rect.height * 0.6;
  const unit = Math.min(rect.width, rect.height) * 0.16;
  const background = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height);
  background.addColorStop(0, "rgba(255,255,255,0.92)");
  background.addColorStop(1, "rgba(185,203,232,0.9)");

  ctx.save();
  ctx.globalAlpha = alpha;
  pathRoundedRect(rect.x, rect.y, rect.width, rect.height, radius);
  ctx.clip();
  ctx.fillStyle = background;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  const glow = ctx.createRadialGradient(centerX, centerY - unit * 0.4, unit * 0.3, centerX, centerY, unit * 3);
  glow.addColorStop(0, `${accent}dd`);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.fillStyle = "rgba(255,255,255,0.32)";
  ctx.beginPath();
  ctx.ellipse(centerX - unit * 1.4, rect.y + unit * 0.8, unit * 1.8, unit * 0.9, -0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(centerX, centerY);

  if (cardId === "giant") {
    ctx.fillStyle = "#8c5a34";
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.6, unit * 1.9, unit * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#efc49d";
    ctx.beginPath();
    ctx.arc(0, -unit * 0.25, unit * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#a05a2c";
    ctx.beginPath();
    ctx.moveTo(-unit * 1.05, unit * 0.05);
    ctx.lineTo(0, unit * 1.35);
    ctx.lineTo(unit * 1.05, unit * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#4f2d1a";
    ctx.lineWidth = Math.max(1.5, unit * 0.12);
    ctx.beginPath();
    ctx.moveTo(-unit * 0.55, -unit * 0.45);
    ctx.lineTo(-unit * 0.1, -unit * 0.55);
    ctx.moveTo(unit * 0.55, -unit * 0.45);
    ctx.lineTo(unit * 0.1, -unit * 0.55);
    ctx.stroke();
  } else if (cardId === "knight") {
    ctx.fillStyle = "#6e8fb5";
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.72, unit * 1.6, unit * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dfe8f2";
    ctx.beginPath();
    ctx.arc(0, -unit * 0.15, unit * 1.08, Math.PI, 0);
    ctx.lineTo(unit * 1.02, unit * 0.54);
    ctx.lineTo(-unit * 1.02, unit * 0.54);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#29405f";
    ctx.fillRect(-unit * 0.36, unit * 0.05, unit * 0.72, unit * 0.22);
    ctx.fillStyle = "#f1cf6d";
    ctx.beginPath();
    ctx.moveTo(0, -unit * 1.25);
    ctx.lineTo(unit * 0.2, -unit * 0.68);
    ctx.lineTo(-unit * 0.2, -unit * 0.68);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#dfe8f2";
    ctx.lineWidth = Math.max(1.8, unit * 0.14);
    ctx.beginPath();
    ctx.moveTo(unit * 0.9, -unit * 0.15);
    ctx.lineTo(unit * 1.55, -unit * 0.95);
    ctx.stroke();
  } else if (cardId === "archers") {
    for (const offsetX of [-unit * 0.7, unit * 0.7]) {
      ctx.fillStyle = "#78b05c";
      ctx.beginPath();
      ctx.ellipse(offsetX, unit * 0.62, unit * 0.92, unit * 1.08, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f2d3b4";
      ctx.beginPath();
      ctx.arc(offsetX, -unit * 0.05, unit * 0.58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#dd8aa9";
      ctx.beginPath();
      ctx.arc(offsetX - unit * 0.28, -unit * 0.1, unit * 0.2, 0, Math.PI * 2);
      ctx.arc(offsetX + unit * 0.28, -unit * 0.1, unit * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "#8b5f32";
    ctx.lineWidth = Math.max(1.5, unit * 0.12);
    ctx.beginPath();
    ctx.arc(-unit * 0.15, unit * 0.05, unit * 1.05, Math.PI * 1.14, Math.PI * 1.9);
    ctx.stroke();
    drawArrowGlyph(unit * 0.72, -unit * 0.12, 0, unit * 1.4, "#fff1bf", 1);
  } else if (cardId === "mini_pekka") {
    ctx.fillStyle = "#72c8df";
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.62, unit * 1.65, unit * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dce9ef";
    ctx.beginPath();
    ctx.arc(0, -unit * 0.1, unit * 1.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d5b74";
    ctx.fillRect(-unit * 0.55, -unit * 0.18, unit * 1.1, unit * 0.22);
    ctx.beginPath();
    ctx.moveTo(-unit * 0.7, -unit * 1.05);
    ctx.lineTo(-unit * 0.18, -unit * 1.48);
    ctx.lineTo(0, -unit * 0.88);
    ctx.closePath();
    ctx.moveTo(unit * 0.7, -unit * 1.05);
    ctx.lineTo(unit * 0.18, -unit * 1.48);
    ctx.lineTo(0, -unit * 0.88);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#f4f8fb";
    ctx.lineWidth = Math.max(2.2, unit * 0.16);
    ctx.beginPath();
    ctx.moveTo(unit * 0.86, unit * 0.12);
    ctx.lineTo(unit * 1.6, -unit * 1.1);
    ctx.stroke();
  } else if (cardId === "musketeer") {
    ctx.fillStyle = "#597cb7";
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.72, unit * 1.65, unit * 1.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f2d4bc";
    ctx.beginPath();
    ctx.arc(0, -unit * 0.08, unit * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#29405f";
    ctx.beginPath();
    ctx.ellipse(0, -unit * 0.78, unit * 1.42, unit * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-unit * 0.95, -unit * 0.82, unit * 1.9, unit * 0.26);
    ctx.fillStyle = "#f5d37b";
    ctx.fillRect(-unit * 0.25, -unit * 1.48, unit * 0.5, unit * 0.72);
    ctx.strokeStyle = "#d8c3a2";
    ctx.lineWidth = Math.max(2.2, unit * 0.16);
    ctx.beginPath();
    ctx.moveTo(unit * 0.45, unit * 0.12);
    ctx.lineTo(unit * 1.95, -unit * 0.22);
    ctx.stroke();
  } else if (cardId === "goblins") {
    for (const { x, y } of [
      { x: -unit * 0.95, y: unit * 0.08 },
      { x: unit * 0.95, y: unit * 0.08 },
      { x: -unit * 0.5, y: unit * 0.92 },
      { x: unit * 0.5, y: unit * 0.92 },
    ]) {
      ctx.fillStyle = "#7ad85f";
      ctx.beginPath();
      ctx.arc(x, y, unit * 0.52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#376225";
      ctx.beginPath();
      ctx.moveTo(x - unit * 0.56, y - unit * 0.12);
      ctx.lineTo(x - unit * 1.02, y - unit * 0.38);
      ctx.lineTo(x - unit * 0.72, y + unit * 0.06);
      ctx.closePath();
      ctx.moveTo(x + unit * 0.56, y - unit * 0.12);
      ctx.lineTo(x + unit * 1.02, y - unit * 0.38);
      ctx.lineTo(x + unit * 0.72, y + unit * 0.06);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = "#f2ede4";
    ctx.lineWidth = Math.max(1.6, unit * 0.12);
    ctx.beginPath();
    ctx.moveTo(unit * 1.1, unit * 0.22);
    ctx.lineTo(unit * 1.45, -unit * 0.75);
    ctx.stroke();
  } else if (cardId === "arrows") {
    ctx.strokeStyle = "#c6982f";
    ctx.lineWidth = Math.max(1.8, unit * 0.14);
    ctx.beginPath();
    ctx.arc(0, unit * 0.18, unit * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    for (const [index, angle] of [-0.35, 0, 0.35].entries()) {
      drawArrowGlyph(-unit * 0.75 + index * unit * 0.72, unit * 0.05, -Math.PI * 0.25 + angle * 0.1, unit * 1.55, "#ffefb4", 1);
    }
  } else if (cardId === "fireball") {
    const flame = ctx.createRadialGradient(0, 0, unit * 0.12, 0, 0, unit * 1.75);
    flame.addColorStop(0, "#fff2d2");
    flame.addColorStop(0.45, "#ff9c4f");
    flame.addColorStop(1, "#d6521f");
    ctx.beginPath();
    ctx.arc(0, 0, unit * 1.28, 0, Math.PI * 2);
    ctx.fillStyle = flame;
    ctx.fill();
    ctx.fillStyle = "rgba(255,134,70,0.76)";
    ctx.beginPath();
    ctx.moveTo(-unit * 1.7, unit * 0.45);
    ctx.lineTo(-unit * 0.5, -unit * 0.22);
    ctx.lineTo(-unit * 0.25, unit * 1.02);
    ctx.closePath();
    ctx.fill();
  }

  if (!affordable) {
    ctx.fillStyle = "rgba(10,14,27,0.34)";
    ctx.fillRect(rect.x - centerX, rect.y - centerY, rect.width, rect.height);
  }

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
  const layoutScale = getLayoutScale();
  if (cardId === "giant") {
    return 16 * layoutScale;
  }
  if (cardId === "mini_pekka") {
    return 13.5 * layoutScale;
  }
  if (cardId === "knight" || cardId === "musketeer") {
    return 12 * layoutScale;
  }
  if (cardId === "archers") {
    return 11.4 * layoutScale;
  }
  if (cardId === "goblins") {
    return 10.5 * layoutScale;
  }
  return 11 * layoutScale;
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
      body: "#5f9a4f",
      accent: "#d884a7",
      skin: "#f2d3b4",
      weapon: "#8b5f32",
      trim: "#385124",
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
    body: "#4ea93b",
    accent: "#dff6b2",
    skin: "#98ee70",
    weapon: "#fff7df",
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
  const layoutScale = getLayoutScale();
  const hpRatio = clamp01(entity.hp / entity.maxHp);
  const teamPalette = getTeamPalette(entity.team);
  const width = (entity.tower_role === "king" ? 58 : 46) * layoutScale;
  const barX = screen.x - width * 0.5;
  const height = Math.max(4, 6 * layoutScale);
  const radius = Math.max(3, 3 * layoutScale);
  const barY = screen.y - (entity.tower_role === "king" ? 42 : 34) * layoutScale;
  fillRoundedRect(barX, barY, width, height, radius, "rgba(14,19,33,0.46)");
  fillRoundedRect(barX, barY, width * hpRatio, height, radius, "#7ff29d");
  strokeRoundedRect(barX, barY, width, height, radius, "rgba(255,255,255,0.38)");
  drawOutlinedText(String(Math.max(0, Math.ceil(entity.hp))), screen.x, barY - 4 * layoutScale, {
    font: `${Math.max(9, 11 * layoutScale)}px Trebuchet MS`,
    fillStyle: teamPalette.text,
    strokeStyle: "rgba(10,15,27,0.96)",
    lineWidth: Math.max(2, 2.6 * layoutScale),
  });
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
  const layoutScale = getLayoutScale();
  const screen = worldToScreen({ x: worldX, y: worldY });
  const padRadius = (towerRole === "king" ? 31 : 24) * layoutScale;
  drawShadow(screen, padRadius, 10, 0.15);
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.fillStyle = "rgba(222,229,232,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, (towerRole === "king" ? 30 : 25) * layoutScale, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(108,117,128,0.9)";
  ctx.lineWidth = Math.max(1.4, 2 * layoutScale);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, (towerRole === "king" ? 20 : 17) * layoutScale, 0, Math.PI * 2);
  ctx.fillStyle = team === "blue" ? "rgba(88,140,255,0.2)" : "rgba(255,110,110,0.2)";
  ctx.fill();
  if (towerRole === "king") {
    drawCrownIcon(0, -1 * layoutScale, 12 * layoutScale, "rgba(244,212,123,0.95)");
  }
  ctx.restore();
}

function drawArenaBackground() {
  const layout = getBattleLayout();
  const { frame, arenaViewport, bottomTray } = layout;
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const frameRadius = Math.max(24, 30 * layout.scale);
  const arenaRadius = Math.max(18, 24 * layout.scale);
  const pageGradient = ctx.createLinearGradient(0, 0, 0, height);
  pageGradient.addColorStop(0, "#5d7e4b");
  pageGradient.addColorStop(0.5, "#88ad62");
  pageGradient.addColorStop(1, "#506d3f");
  ctx.fillStyle = pageGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#223421";
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.5, frame.width * 0.72, frame.height * 0.58, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  fillRoundedRect(frame.x, frame.y, frame.width, frame.height, frameRadius, "#98bb74");
  strokeRoundedRect(frame.x, frame.y, frame.width, frame.height, frameRadius, "rgba(255,255,255,0.26)", Math.max(2, 2.5 * layout.scale));

  fillRoundedRect(
    frame.x + 6 * layout.scale,
    frame.y + 6 * layout.scale,
    frame.width - 12 * layout.scale,
    frame.height - 12 * layout.scale,
    Math.max(20, 26 * layout.scale),
    "#a6ca7c",
  );

  ctx.save();
  pathRoundedRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height, arenaRadius);
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

  fillRoundedRect(
    bottomTray.x - 6 * layout.scale,
    bottomTray.y - 10 * layout.scale,
    bottomTray.width + 18 * layout.scale,
    bottomTray.height + 18 * layout.scale,
    Math.max(18, 24 * layout.scale),
    "rgba(39,93,181,0.72)",
  );
  strokeRoundedRect(
    arenaViewport.x,
    arenaViewport.y,
    arenaViewport.width,
    arenaViewport.height,
    arenaRadius,
    "rgba(255,255,255,0.42)",
    Math.max(1.4, 2 * layout.scale),
  );
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
    ctx.fillStyle = palette.weapon;
    ctx.beginPath();
    ctx.arc(0, -scale * 0.72, scale * 0.42, Math.PI, 0);
    ctx.lineTo(scale * 0.42, -scale * 0.18);
    ctx.lineTo(-scale * 0.42, -scale * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = palette.trim;
    ctx.fillRect(-scale * 0.2, -scale * 0.54, scale * 0.4, scale * 0.12);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(0, -scale * 1.14);
    ctx.lineTo(scale * 0.16, -scale * 0.86);
    ctx.lineTo(-scale * 0.16, -scale * 0.86);
    ctx.closePath();
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
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(-scale * 0.28, -scale * 0.7, scale * 0.14, 0, Math.PI * 2);
    ctx.arc(scale * 0.28, -scale * 0.7, scale * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.body;
    ctx.beginPath();
    ctx.moveTo(-scale * 0.42, -scale * 0.98);
    ctx.lineTo(0, -scale * 1.24);
    ctx.lineTo(scale * 0.42, -scale * 0.98);
    ctx.closePath();
    ctx.fill();
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
    ctx.fillStyle = palette.trim;
    ctx.fillRect(scale * 0.3, -scale * 0.2, scale * 0.12, scale * 0.56);
  } else if (entity.cardId === "musketeer") {
    const recoil = reach * scale * 0.22;
    ctx.translate(0, recoil);
    ctx.fillStyle = palette.trim;
    ctx.beginPath();
    ctx.ellipse(0, -scale * 0.96, scale * 0.62, scale * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-scale * 0.42, -scale * 1.06, scale * 0.84, scale * 0.18);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(scale * 0.14, -scale * 1.18);
    ctx.lineTo(scale * 0.54, -scale * 1.34);
    ctx.lineTo(scale * 0.28, -scale * 0.92);
    ctx.closePath();
    ctx.fill();
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
    ctx.fillStyle = palette.trim;
    ctx.beginPath();
    ctx.moveTo(-scale * 0.44, -scale * 0.74);
    ctx.lineTo(-scale * 0.82, -scale * 0.9);
    ctx.lineTo(-scale * 0.52, -scale * 0.48);
    ctx.closePath();
    ctx.moveTo(scale * 0.44, -scale * 0.74);
    ctx.lineTo(scale * 0.82, -scale * 0.9);
    ctx.lineTo(scale * 0.52, -scale * 0.48);
    ctx.closePath();
    ctx.fill();
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
    ctx.fillStyle = palette.weapon;
    ctx.beginPath();
    ctx.arc(0, -scale * 0.58, scale * 0.09, 0, Math.PI * 2);
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

function drawCrownRail(score, layout) {
  const rail = layout.crownRail;
  const radius = Math.max(16, 18 * layout.scale);
  fillRoundedRect(rail.x, rail.y, rail.width, rail.height, radius, "rgba(24,33,35,0.64)");
  strokeRoundedRect(rail.x, rail.y, rail.width, rail.height, radius, "rgba(0,0,0,0.74)", Math.max(2, 2.4 * layout.scale));

  const badgeHeight = rail.height * 0.35;
  const badgeWidth = rail.width * 0.82;
  const badgeX = rail.x + (rail.width - badgeWidth) * 0.5;
  const redY = rail.y + rail.height * 0.02;
  const blueY = rail.y + rail.height - badgeHeight - rail.height * 0.02;

  for (const badge of [
    { actor: "red", count: score.red_crowns, y: redY, fill: "#ec5f5d" },
    { actor: "blue", count: score.blue_crowns, y: blueY, fill: "#69a5ff" },
  ]) {
    fillRoundedRect(badgeX, badge.y, badgeWidth, badgeHeight, radius, badge.fill);
    strokeRoundedRect(badgeX, badge.y, badgeWidth, badgeHeight, radius, "rgba(35,16,16,0.72)", Math.max(2, 2.4 * layout.scale));
    drawCrownIcon(
      badgeX + badgeWidth * 0.5,
      badge.y + badgeHeight * 0.34,
      Math.max(14, 18 * layout.scale),
      badge.actor === "red" ? "#ffe5a4" : "#ffdd8b",
    );
    ctx.textAlign = "center";
    ctx.fillStyle = "#10171c";
    ctx.font = `${Math.max(22, 34 * layout.scale)}px Trebuchet MS`;
    ctx.fillText(String(badge.count), badgeX + badgeWidth * 0.5, badge.y + badgeHeight * 0.82);
  }
}

function drawElixirMeter(layout) {
  const elixirBar = layout.elixirBar;
  const amount = appState.engine.state.elixir.blue.elixir;
  const orbSize = elixirBar.height * 1.28;
  const orbX = elixirBar.x - orbSize * 0.28;
  const orbY = elixirBar.y - orbSize * 0.18;
  const gradient = ctx.createLinearGradient(0, elixirBar.y, 0, elixirBar.y + elixirBar.height);
  gradient.addColorStop(0, "#f384ff");
  gradient.addColorStop(1, "#b838de");

  ctx.save();
  ctx.beginPath();
  ctx.arc(orbX + orbSize * 0.45, orbY + orbSize * 0.52, orbSize * 0.34, Math.PI * 0.06, Math.PI * 1.94);
  ctx.fillStyle = "#c545ef";
  ctx.fill();
  ctx.restore();

  fillRoundedRect(elixirBar.x, elixirBar.y, elixirBar.width, elixirBar.height, elixirBar.height * 0.24, "rgba(18,27,76,0.92)");
  strokeRoundedRect(
    elixirBar.x,
    elixirBar.y,
    elixirBar.width,
    elixirBar.height,
    elixirBar.height * 0.24,
    "rgba(0,0,0,0.58)",
    Math.max(1.4, 2 * layout.scale),
  );

  const segmentGap = 2 * layout.scale;
  const segmentWidth = (elixirBar.width - segmentGap * (MAX_ELIXIR - 1)) / MAX_ELIXIR;
  for (let index = 0; index < MAX_ELIXIR; index += 1) {
    const segmentX = elixirBar.x + index * (segmentWidth + segmentGap);
    fillRoundedRect(
      segmentX,
      elixirBar.y + 3 * layout.scale,
      segmentWidth,
      elixirBar.height - 6 * layout.scale,
      elixirBar.height * 0.18,
      index < amount ? gradient : "rgba(255,255,255,0.08)",
    );
  }

  ctx.textAlign = "left";
  ctx.fillStyle = "#f9d7ff";
  ctx.font = `${Math.max(20, 28 * layout.scale)}px Trebuchet MS`;
  ctx.fillText(String(amount), elixirBar.x - 10 * layout.scale, elixirBar.y + elixirBar.height * 0.82);
  ctx.font = `${Math.max(10, 13 * layout.scale)}px Trebuchet MS`;
  ctx.fillStyle = "#ffd0ff";
  ctx.fillText("Max: 10", elixirBar.x + 4 * layout.scale, elixirBar.y + elixirBar.height + 12 * layout.scale);
}

function drawHand() {
  const layout = getBattleLayout();
  const { bottomTray, closeButton, nextCardRect, statusRect } = getUiLayout();
  const hand = appState.engine.getHand("blue");
  const deckQueue = appState.engine.getDeckQueue("blue");
  const slots = getHandSlotRects();
  const handSizing = getHandLayout();
  const dragIndex = appState.dragState?.slotIndex ?? null;
  const nextCardId = deckQueue[0] ?? null;
  const nextCard = nextCardId ? getCard(nextCardId) : null;
  const radius = Math.max(16, 18 * layout.scale);

  fillRoundedRect(bottomTray.x, bottomTray.y, bottomTray.width, bottomTray.height, radius, "#2e7df4");
  fillRoundedRect(
    bottomTray.x + 8 * layout.scale,
    bottomTray.y + 8 * layout.scale,
    bottomTray.width - 16 * layout.scale,
    bottomTray.height - 16 * layout.scale,
    Math.max(14, 16 * layout.scale),
    "#205cc5",
  );
  strokeRoundedRect(bottomTray.x, bottomTray.y, bottomTray.width, bottomTray.height, radius, "rgba(255,255,255,0.26)", Math.max(1.6, 2 * layout.scale));

  fillRoundedRect(closeButton.x, closeButton.y, closeButton.width, closeButton.height, closeButton.width * 0.18, "#a86a46");
  strokeRoundedRect(closeButton.x, closeButton.y, closeButton.width, closeButton.height, closeButton.width * 0.18, "#5c301a", Math.max(2, 2.4 * layout.scale));
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff5eb";
  ctx.font = `${Math.max(26, 34 * layout.scale)}px Trebuchet MS`;
  ctx.fillText("×", closeButton.x + closeButton.width * 0.5, closeButton.y + closeButton.height * 0.72);

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `${Math.max(16, 22 * layout.scale)}px Trebuchet MS`;
  ctx.fillText("Next:", closeButton.x - 2 * layout.scale, nextCardRect.y - 12 * layout.scale);

  fillRoundedRect(nextCardRect.x, nextCardRect.y, nextCardRect.width, nextCardRect.height, 12 * layout.scale, "rgba(19,27,55,0.88)");
  strokeRoundedRect(nextCardRect.x, nextCardRect.y, nextCardRect.width, nextCardRect.height, 12 * layout.scale, "rgba(255,255,255,0.24)", Math.max(1.3, 1.7 * layout.scale));
  if (nextCard) {
    drawCardPortrait(
      nextCardId,
      {
        x: nextCardRect.x + 5 * layout.scale,
        y: nextCardRect.y + 6 * layout.scale,
        width: nextCardRect.width - 10 * layout.scale,
        height: nextCardRect.height - 12 * layout.scale,
      },
      { affordable: true },
    );
    drawCardCostBadge(
      nextCardRect.x + 15 * layout.scale,
      nextCardRect.y + 16 * layout.scale,
      Math.max(9, 10.5 * layout.scale),
      nextCard.cost,
    );
  }

  for (const slot of slots) {
    const cardId = hand[slot.index] ?? null;
    const card = cardId ? getCard(cardId) : null;
    const isSelected = slot.index === appState.selectedCardIndex;
    const affordable = card ? appState.engine.state.elixir.blue.elixir >= card.cost : false;
    const isDraggingCard = appState.dragState?.isDragging && dragIndex === slot.index;
    const accent = getCardAccent(cardId);
    const lift = isSelected ? 10 * layout.scale : 0;
    const portraitRect = {
      x: slot.x + 8 * layout.scale,
      y: slot.y + 16 * layout.scale - lift,
      width: slot.width - 16 * layout.scale,
      height: slot.height - 28 * layout.scale,
    };

    ctx.save();
    ctx.globalAlpha = isDraggingCard ? 0.45 : 1;
    fillRoundedRect(slot.x, slot.y - lift, slot.width, slot.height, 14 * layout.scale, isSelected ? "rgba(255,255,255,0.24)" : "rgba(12,19,44,0.78)");
    fillRoundedRect(slot.x, slot.y - lift, slot.width, Math.max(8, 10 * layout.scale), 14 * layout.scale, accent, affordable ? 1 : 0.55);
    fillRoundedRect(
      portraitRect.x,
      portraitRect.y,
      portraitRect.width,
      portraitRect.height,
      12 * layout.scale,
      "rgba(255,255,255,0.08)",
    );
    strokeRoundedRect(
      slot.x,
      slot.y - lift,
      slot.width,
      slot.height,
      14 * layout.scale,
      isSelected ? "#fff3c2" : "rgba(255,255,255,0.26)",
      isSelected ? Math.max(2, 2.4 * layout.scale) : Math.max(1.2, 1.5 * layout.scale),
    );
    ctx.restore();

    if (!card) {
      continue;
    }

    drawCardPortrait(cardId, portraitRect, {
      affordable,
      alpha: isDraggingCard ? 0.45 : 1,
    });
    drawCardCostBadge(
      slot.x + 18 * layout.scale,
      slot.y + 19 * layout.scale - lift,
      Math.max(11, 13 * layout.scale),
      card.cost,
      affordable ? 1 : 0.88,
    );
  }

  ctx.textAlign = "left";
  const hideIdleStatus =
    appState.statusMessage.startsWith("Battle started vs") || appState.statusMessage.startsWith("Ready.");
  if (!hideIdleStatus) {
    ctx.fillStyle = "#edf1ff";
    ctx.font = `${Math.max(9, 12 * layout.scale)}px Trebuchet MS`;
    const status = fitTextToWidth(appState.statusMessage, statusRect.width);
    ctx.fillText(status, statusRect.x, statusRect.y + statusRect.height * 0.72);
  }
  drawElixirMeter(layout);
}

function drawHud() {
  const layout = getBattleLayout();
  const tick = appState.engine.state.tick;
  const phase = getMatchPhase({ tick, isOvertime: appState.engine.state.isOvertime });
  const regulationRemaining = Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(tick, MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, tick - MATCH_CONFIG.regulation_ticks);
  const overtimeRemaining = Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed);
  const activeClock = phase === "overtime" ? overtimeRemaining / TICK_RATE : regulationRemaining / TICK_RATE;
  const score = appState.engine.getScore();
  const clockText = formatBattleClock(activeClock);
  const topBanner = layout.topBanner;
  const timerBox = layout.timerBox;
  const opponentName = fitTextToWidth(getTierLabel(appState.selectedBotTier), topBanner.width - 88 * layout.scale);

  fillRoundedRect(topBanner.x, topBanner.y, topBanner.width, topBanner.height, 18 * layout.scale, "rgba(84,122,44,0.14)");
  fillRoundedRect(topBanner.x + 4 * layout.scale, topBanner.y + 10 * layout.scale, 50 * layout.scale, 56 * layout.scale, 14 * layout.scale, "#6f4d37");
  strokeRoundedRect(topBanner.x + 4 * layout.scale, topBanner.y + 10 * layout.scale, 50 * layout.scale, 56 * layout.scale, 14 * layout.scale, "#2d2019", Math.max(2, 2.2 * layout.scale));
  drawCrownIcon(topBanner.x + 29 * layout.scale, topBanner.y + 39 * layout.scale, 15 * layout.scale, "#84c8ff");

  ctx.textAlign = "left";
  ctx.fillStyle = "#ff4f8a";
  ctx.font = `${Math.max(18, 26 * layout.scale)}px Trebuchet MS`;
  ctx.fillText(opponentName, topBanner.x + 62 * layout.scale, topBanner.y + 30 * layout.scale);
  ctx.fillStyle = "#fff3d8";
  ctx.font = `${Math.max(14, 18 * layout.scale)}px Trebuchet MS`;
  ctx.fillText("Royale Trainers", topBanner.x + 62 * layout.scale, topBanner.y + 60 * layout.scale);

  fillRoundedRect(timerBox.x, timerBox.y, timerBox.width, timerBox.height, 14 * layout.scale, "rgba(12,16,21,0.9)");
  strokeRoundedRect(timerBox.x, timerBox.y, timerBox.width, timerBox.height, 14 * layout.scale, "rgba(0,0,0,0.78)", Math.max(2, 2.2 * layout.scale));
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff4cb";
  ctx.font = `${Math.max(13, 18 * layout.scale)}px Trebuchet MS`;
  ctx.fillText("Time left:", timerBox.x + timerBox.width * 0.5, timerBox.y + 22 * layout.scale);
  ctx.font = `${Math.max(30, 46 * layout.scale)}px Trebuchet MS`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(clockText, timerBox.x + timerBox.width * 0.5, timerBox.y + timerBox.height * 0.72);

  if (phase === "overtime") {
    fillRoundedRect(timerBox.x, timerBox.y + timerBox.height + 6 * layout.scale, timerBox.width, 18 * layout.scale, 9 * layout.scale, "rgba(255,167,73,0.72)");
    ctx.fillStyle = "#fff4cb";
    ctx.font = `${Math.max(10, 13 * layout.scale)}px Trebuchet MS`;
    ctx.fillText("3x ELIXIR", timerBox.x + timerBox.width * 0.5, timerBox.y + timerBox.height + 20 * layout.scale);
  }

  drawCrownRail(score, layout);
}

function render() {
  syncSetupOverlay();
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
  if (pointInRect({ x, y }, getBattleLayout().closeButton)) {
    resetGame();
    return;
  }

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
