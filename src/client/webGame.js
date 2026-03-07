import { getCard } from "../sim/cards.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTower } from "../sim/entities.js";
import { createArena } from "../sim/map.js";
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

const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });

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

  const desiredInfoHeight = isCompact ? 92 : 118;
  const desiredHandHeight = isCompact ? 64 : 78;
  const desiredStatusHeight = isCompact ? 24 : 30;
  const minInfoHeight = 46;
  const minHandHeight = 38;
  const minStatusHeight = 18;

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
  if (cardId === "fireball") {
    return "#ff9c4f";
  }
  if (cardId === "arrows") {
    return "#f7d165";
  }
  return "#dce7ff";
}

function getHandLayout() {
  const { handPanel } = getUiLayout();
  const availableWidth = Math.max(220, handPanel.width - 20);
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
  };
}

function getHandSlotRects() {
  const { handPanel } = getUiLayout();
  const layout = getHandLayout();
  const totalWidth = HAND_SLOTS * layout.cardWidth + (HAND_SLOTS - 1) * layout.gap;
  const startX = handPanel.x + (handPanel.width - totalWidth) / 2;
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
  return [
    createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: 3800 }),
    createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: 3800 }),
  ];
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
    return { ok: false, reason: "Unknown card.", card: null };
  }

  if (appState.mode !== "playing") {
    return { ok: false, reason: "Press Start to begin.", card };
  }

  const currentElixir = appState.engine.state.elixir[actor]?.elixir ?? 0;
  if (currentElixir < card.cost) {
    return { ok: false, reason: `Not enough elixir for ${CARD_LABEL[cardId] ?? cardId}.`, card };
  }

  if (card.type === "troop") {
    if (actor === "blue" && worldPosition.y < 16) {
      return { ok: false, reason: "Troops must be played on your side.", card };
    }
    if (actor === "red" && worldPosition.y > 16) {
      return { ok: false, reason: "Troops must be played on your side.", card };
    }
  }

  return { ok: true, reason: null, card };
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
    x: Math.round(worldPosition.x * 100) / 100,
    y: Math.round(worldPosition.y * 100) / 100,
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
  return `${who} (${result.reason}). Crowns ${score}, tower HP ${hp}.`;
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

function drawArenaBackground() {
  const { arenaViewport } = getUiLayout();
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const gradient = ctx.createLinearGradient(0, 0, 0, arenaViewport.y + arenaViewport.height);
  gradient.addColorStop(0, "#1e466f");
  gradient.addColorStop(1, "#3d6e93");
  ctx.fillStyle = "#152741";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = gradient;
  ctx.fillRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height);

  const placementCardId = getActivePlacementCardId();
  const placementCard = placementCardId ? getCard(placementCardId) : null;
  if (placementCard?.type === "troop") {
    const splitY = worldToScreen({ x: arena.minX, y: 16 }).y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height);
    ctx.clip();
    ctx.fillStyle = "rgba(83, 188, 248, 0.08)";
    ctx.fillRect(arenaViewport.x, splitY, arenaViewport.width, arenaViewport.y + arenaViewport.height - splitY);
    ctx.fillStyle = "rgba(233, 86, 86, 0.08)";
    ctx.fillRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, splitY - arenaViewport.y);

    ctx.save();
    ctx.setLineDash([10, 7]);
    ctx.strokeStyle = "rgba(255, 246, 187, 0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(arenaViewport.x, splitY);
    ctx.lineTo(arenaViewport.x + arenaViewport.width, splitY);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    if (arenaViewport.height >= 220) {
      ctx.font = `${Math.max(10, Math.round(arenaViewport.width < 700 ? 10 : 11))}px Avenir Next`;
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255, 210, 210, 0.95)";
      ctx.fillText(
        "Enemy side: troops blocked",
        arenaViewport.x + 12,
        Math.max(arenaViewport.y + 16, splitY - 10),
      );
      ctx.fillStyle = "rgba(204, 239, 255, 0.95)";
      ctx.fillText(
        "Your side: troops allowed",
        arenaViewport.x + 12,
        Math.min(arenaViewport.y + arenaViewport.height - 12, splitY + 18),
      );
    }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 4;
  const riverY = worldToScreen({ x: arena.minX, y: 16 }).y;
  ctx.beginPath();
  ctx.moveTo(arenaViewport.x, riverY);
  ctx.lineTo(arenaViewport.x + arenaViewport.width, riverY);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.42)";
  ctx.lineWidth = 2;
  ctx.strokeRect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height);
}

function drawEntity(entity) {
  if (entity.hp <= 0) {
    return;
  }

  const screen = worldToScreen(entity);
  const radius = entity.entity_type === "tower" ? 18 : 11;

  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = entity.team === "blue" ? "#2573ff" : "#ea4f4f";
  ctx.fill();

  ctx.lineWidth = 2;
  ctx.strokeStyle = entity.cardId === "giant" ? "#efb94a" : "rgba(255,255,255,0.85)";
  ctx.stroke();

  ctx.font = "12px Avenir Next";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText((CARD_LABEL[entity.cardId] ?? entity.cardId).slice(0, 3).toUpperCase(), screen.x, screen.y + 4);

  const hpRatio = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
  const barWidth = entity.entity_type === "tower" ? 42 : 28;
  const barHeight = 4;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(screen.x - barWidth / 2, screen.y - radius - 10, barWidth, barHeight);
  ctx.fillStyle = "#6cf58a";
  ctx.fillRect(screen.x - barWidth / 2, screen.y - radius - 10, barWidth * hpRatio, barHeight);
}

function drawCountdownRing(screen, radius, progress, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
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
  const pulse = 1 + 0.06 * Math.sin(appState.engine.state.tick * 0.4);
  const ringRadius = radius * pulse;

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, ringRadius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  drawCountdownRing(screen, ringRadius + 8, progress, color, alpha);
  drawCountdownRing(screen, ringRadius + 14, progress, teamPalette.stroke, alpha * 0.8);

  ctx.beginPath();
  ctx.moveTo(screen.x - 10, screen.y);
  ctx.lineTo(screen.x + 10, screen.y);
  ctx.moveTo(screen.x, screen.y - 10);
  ctx.lineTo(screen.x, screen.y + 10);
  ctx.strokeStyle = `${color}CC`;
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
    const fadeAlpha = 0.35 + (1 - lifeProgress) * 0.65;

    if (effect.effect_type === "troop_deploy") {
      const totalTicks = getCard(effect.card_id)?.deploy_time_ticks ?? Math.max(1, effect.resolve_tick - effect.enqueue_tick);
      const progress = clamp01(1 - remainingTicks / Math.max(1, totalTicks));
      const cardLabel = (CARD_LABEL[effect.card_id] ?? effect.card_id).slice(0, 3).toUpperCase();
      const fillRadius = lerp(12, 20, easeProgress);

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
      ctx.fillText(cardLabel, target.x, target.y + 4);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(`${(remainingTicks / TICK_RATE).toFixed(1)}s`, target.x, target.y + 20);
      continue;
    }

    if (effect.effect_type === "spell_arrows") {
      const castTicks = effect.cast_delay_ticks ?? Math.max(1, effect.resolve_tick - effect.enqueue_tick);
      const elapsed = Math.max(0, tick - effect.enqueue_tick);
      const progress = clamp01(elapsed / Math.max(1, castTicks));
      drawSpellReticle({
        screen: target,
        radius: tilesToPixels(ARROWS_CONFIG.radius_tiles),
        color: cardAccent,
        progress,
        label: "ARROWS",
        actor: effect.actor,
        alpha: fadeAlpha,
      });
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
      label: elapsed < castTicks ? "FIREBALL CAST" : "FIREBALL TRAVEL",
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
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(launchPoint.x, launchPoint.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = cardAccent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
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
    ctx.strokeStyle = cardAccent;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = cardAccent;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,238,214,0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
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
  const screen = worldToScreen(world);
  const placementStatus = pointerInArena
    ? getPlacementStatus(drag.cardId, world, "blue")
    : { ok: false, reason: "Play cards inside the arena." };
  const legal = placementStatus.ok;
  const stroke = legal ? "#79ffab" : "#ff9c9c";
  const fill = legal ? "rgba(80, 214, 138, 0.2)" : "rgba(239, 95, 95, 0.2)";
  const label = CARD_LABEL[drag.cardId] ?? drag.cardId;
  const radius =
    card.type === "spell"
      ? tilesToPixels(card.id === "fireball" ? FIREBALL_CONFIG.radius_tiles : ARROWS_CONFIG.radius_tiles)
      : 18;

  const originSlot = getHandSlotRects().find((slot) => slot.index === drag.slotIndex);
  if (originSlot) {
    ctx.save();
    ctx.globalAlpha = 0.65;
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
    ctx.fillStyle = "#ffd6d6";
    ctx.fillText(placementStatus.reason, screen.x, screen.y + radius + 18);
  }
  ctx.restore();

  const ghostWidth = Math.max(92, handLayout.cardWidth);
  const ghostHeight = Math.max(40, Math.round(handLayout.cardHeight * 0.78));
  const ghostX = Math.min(getCanvasWidth() - ghostWidth - 10, drag.currentX + 16);
  const ghostY = Math.max(10, drag.currentY - ghostHeight - 16);
  const cost = card.cost ?? 0;

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = legal ? "rgba(19, 46, 84, 0.96)" : "rgba(71, 27, 27, 0.94)";
  ctx.fillRect(ghostX, ghostY, ghostWidth, ghostHeight);
  ctx.lineWidth = 2;
  ctx.strokeStyle = legal ? "rgba(123, 255, 171, 0.9)" : "rgba(255, 156, 156, 0.9)";
  ctx.strokeRect(ghostX, ghostY, ghostWidth, ghostHeight);

  ctx.fillStyle = "#f6f9ff";
  ctx.textAlign = "left";
  ctx.font = `${handLayout.titleFont}px Avenir Next`;
  ctx.fillText(label, ghostX + 8, ghostY + Math.min(16, ghostHeight * 0.45));
  ctx.textAlign = "right";
  ctx.font = `${Math.max(10, handLayout.auxFont)}px Avenir Next`;
  ctx.fillStyle = "#f7d165";
  ctx.fillText(`${cost} elixir`, ghostX + ghostWidth - 8, ghostY + Math.min(16, ghostHeight * 0.45));
  ctx.restore();
}

function drawElixirPips({ x, y, actor, amount, pipWidth = 10, pipGap = 4, labelFont = 12, label = null }) {
  const color = actor === "blue" ? "#7cb3ff" : "#ff9f9f";
  const step = pipWidth + pipGap;

  ctx.font = `${labelFont}px Avenir Next`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#e5ecff";
  ctx.fillText(label ?? `${actor.toUpperCase()} ELIXIR`, x, y);

  for (let i = 0; i < MAX_ELIXIR; i += 1) {
    const pipX = x + i * step;
    const filled = i < amount;
    ctx.fillStyle = filled ? color : "rgba(199, 214, 240, 0.25)";
    ctx.fillRect(pipX, y + 6, pipWidth, 12);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pipX, y + 6, pipWidth, 12);
  }
}

function drawHand() {
  const { handPanel } = getUiLayout();
  const hand = appState.engine.getHand("blue");
  const deckQueue = appState.engine.getDeckQueue("blue");
  const slots = getHandSlotRects();
  const layout = getHandLayout();
  const dragIndex = appState.dragState?.slotIndex ?? null;

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(handPanel.x, handPanel.y, handPanel.width, handPanel.height);

  for (const slot of slots) {
    const cardId = hand[slot.index] ?? null;
    const card = cardId ? getCard(cardId) : null;
    const isSelected = slot.index === appState.selectedCardIndex;
    const affordable = card ? appState.engine.state.elixir.blue.elixir >= card.cost : false;
    const isDraggingCard = appState.dragState?.isDragging && dragIndex === slot.index;

    ctx.save();
    ctx.globalAlpha = isDraggingCard ? 0.45 : 1;
    ctx.fillStyle = isSelected ? "rgba(28,45,78,0.95)" : "rgba(17,31,57,0.9)";
    ctx.fillRect(slot.x, slot.y, slot.width, slot.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = isSelected ? "#f7d165" : "rgba(255,255,255,0.25)";
    ctx.strokeRect(slot.x, slot.y, slot.width, slot.height);
    ctx.restore();

    if (!card) {
      continue;
    }

    const titleY = slot.y + Math.min(slot.height - 20, 8 + layout.titleFont);
    const subY = slot.y + Math.min(slot.height - 8, titleY + Math.max(14, layout.titleFont + 6));
    const narrowCard = slot.width < 96;
    ctx.fillStyle = affordable ? "#ffffff" : "#b5bdd1";
    ctx.font = `${layout.titleFont}px Avenir Next`;
    ctx.textAlign = "left";
    if (narrowCard) {
      const compactTitle = fitTextToWidth(`${slot.index + 1}. ${CARD_LABEL[cardId] ?? cardId}`, slot.width - 16);
      ctx.fillText(compactTitle, slot.x + 8, titleY);
      ctx.fillStyle = "#f7d165";
      ctx.font = `${layout.auxFont}px Avenir Next`;
      ctx.fillText(`${card.cost} elixir`, slot.x + 8, subY);
    } else {
      const mainLabel = fitTextToWidth(`${slot.index + 1}. ${CARD_LABEL[cardId] ?? cardId}`, slot.width - 70);
      ctx.fillText(mainLabel, slot.x + 8, titleY);

      ctx.textAlign = "right";
      ctx.fillText(`${card.cost} elixir`, slot.x + slot.width - 8, titleY);
      ctx.textAlign = "left";
    }

    if (slot.index === 0 && deckQueue.length > 0) {
      const nextLabel = CARD_LABEL[deckQueue[0]] ?? deckQueue[0];
      ctx.fillStyle = "#9bb2da";
      ctx.font = `${layout.auxFont}px Avenir Next`;
      const nextText = fitTextToWidth(`Next: ${nextLabel}`, slot.width - 16);
      ctx.fillText(nextText, slot.x + 8, subY);
    }
  }
}

function drawHud() {
  const tick = appState.engine.state.tick;
  const phase = getMatchPhase({ tick, isOvertime: appState.engine.state.isOvertime });

  const regulationRemaining = Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(tick, MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, tick - MATCH_CONFIG.regulation_ticks);
  const overtimeRemaining = Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed);

  const score = appState.engine.getScore();
  const { infoPanel, statusPanel, isCompact } = getUiLayout();
  const trainingSummary = summarizeTrainingStore(appState.trainingStore);
  const titleFont = isCompact ? 12 : 14;
  const bodyFont = isCompact ? 10 : 12;
  const pipWidth = isCompact ? 6 : infoPanel.width < 720 ? 8 : 10;
  const pipGap = isCompact ? 2 : infoPanel.width < 720 ? 3 : 4;
  const pipBlockWidth = MAX_ELIXIR * pipWidth + (MAX_ELIXIR - 1) * pipGap;
  const textLeft = infoPanel.x + 10;
  const textMaxWidth = infoPanel.width - 20;
  const pipLeftX = infoPanel.x + 10;
  const pipRightX = infoPanel.x + infoPanel.width - pipBlockWidth - 10;
  const pipY = infoPanel.y + infoPanel.height - 24;

  ctx.fillStyle = "rgba(12, 20, 38, 0.76)";
  ctx.fillRect(infoPanel.x, infoPanel.y, infoPanel.width, infoPanel.height);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  if (isCompact) {
    const compactLineHeight = 14;
    const compactTop = infoPanel.y + 18;
    ctx.font = `${titleFont}px Avenir Next`;
    const compactLine1 = fitTextToWidth(
      `Bot: ${getTierLabel(appState.selectedBotTier)} | Crowns ${score.blue_crowns}-${score.red_crowns}`,
      textMaxWidth,
    );
    ctx.fillText(compactLine1, textLeft, compactTop);
    ctx.font = `${bodyFont}px Avenir Next`;
    const compactLine2 = fitTextToWidth(
      `Phase ${phase} | Time ${(regulationRemaining / TICK_RATE).toFixed(1)}s | Pending ${appState.engine.state.pending_effects.length}`,
      textMaxWidth,
    );
    ctx.fillText(compactLine2, textLeft, compactTop + compactLineHeight);
    drawElixirPips({
      x: pipLeftX,
      y: pipY,
      actor: "blue",
      label: "BLUE ELIXIR",
      amount: appState.engine.state.elixir.blue.elixir,
      pipWidth,
      pipGap,
      labelFont: 9,
    });
    drawElixirPips({
      x: pipRightX,
      y: pipY,
      actor: "red",
      label: "RED ELIXIR",
      amount: appState.engine.state.elixir.red.elixir,
      pipWidth,
      pipGap,
      labelFont: 9,
    });
  } else {
    const rowGap = 18;
    const rowStart = infoPanel.y + 22;
    ctx.font = `${titleFont}px Avenir Next`;
    ctx.fillText(
      `Mode: ${appState.mode}${appState.paused ? " (paused)" : ""} | Bot: ${getTierLabel(appState.selectedBotTier)} | Phase: ${phase}`,
      textLeft,
      rowStart,
    );
    ctx.fillText(
      `Crowns - Blue: ${score.blue_crowns} | Red: ${score.red_crowns} | Pending effects: ${appState.engine.state.pending_effects.length}`,
      textLeft,
      rowStart + rowGap,
    );
    ctx.font = `${bodyFont}px Avenir Next`;
    ctx.fillText(
      `Time - Regulation: ${(regulationRemaining / TICK_RATE).toFixed(1)}s | Overtime: ${(overtimeRemaining / TICK_RATE).toFixed(1)}s | Samples: ${trainingSummary.sample_count} | Model: ${appState.selfModel?.ready ? "ready" : "not ready"}`,
      textLeft,
      rowStart + rowGap * 2,
    );
    drawElixirPips({
      x: pipLeftX,
      y: pipY,
      actor: "blue",
      amount: appState.engine.state.elixir.blue.elixir,
      pipWidth,
      pipGap,
      labelFont: 10,
    });
    drawElixirPips({
      x: pipRightX,
      y: pipY,
      actor: "red",
      amount: appState.engine.state.elixir.red.elixir,
      pipWidth,
      pipGap,
      labelFont: 10,
    });
  }

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(statusPanel.x, statusPanel.y, statusPanel.width, statusPanel.height);
  ctx.fillStyle = "#f6f9ff";
  const statusFont = isCompact ? 10 : infoPanel.width < 760 ? 11 : 13;
  ctx.font = `${statusFont}px Avenir Next`;
  const controlHint = isCompact ? "Controls: tap/drag card" : "Controls: click or drag card to arena";
  const status = fitTextToWidth(`${controlHint} | ${appState.statusMessage}`, statusPanel.width - 16);
  ctx.fillText(status, statusPanel.x + 8, statusPanel.y + Math.round(statusPanel.height * 0.68));
}

function render() {
  drawArenaBackground();

  const arenaViewport = getArenaViewport();
  ctx.save();
  ctx.beginPath();
  ctx.rect(arenaViewport.x, arenaViewport.y, arenaViewport.width, arenaViewport.height);
  ctx.clip();
  drawPendingEffects();

  for (const entity of appState.engine.state.entities) {
    drawEntity(entity);
  }
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
      blue_draw_queue: appState.engine.getDeckQueue("blue"),
      red: appState.engine.getHand("red"),
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
