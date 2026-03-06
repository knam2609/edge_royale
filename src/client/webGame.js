import { getCard } from "../sim/cards.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTroop, createTower } from "../sim/entities.js";
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
const HAND_CARD_WIDTH = 140;
const HAND_CARD_HEIGHT = 54;
const HAND_GAP = 10;
const HAND_Y_OFFSET = 110;
const DRAG_START_DISTANCE = 8;

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
  const px = ((position.x - arena.minX) / (arena.maxX - arena.minX)) * getCanvasWidth();
  const py = ((position.y - arena.minY) / (arena.maxY - arena.minY)) * getCanvasHeight();
  return { x: px, y: py };
}

function screenToWorld(position) {
  const x = arena.minX + (position.x / getCanvasWidth()) * (arena.maxX - arena.minX);
  const y = arena.minY + (position.y / getCanvasHeight()) * (arena.maxY - arena.minY);
  return { x: Math.max(arena.minX, Math.min(arena.maxX, x)), y: Math.max(arena.minY, Math.min(arena.maxY, y)) };
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

function tilesToPixels(tiles) {
  const pxPerTileX = getCanvasWidth() / (arena.maxX - arena.minX);
  const pxPerTileY = getCanvasHeight() / (arena.maxY - arena.minY);
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

function getHandSlotRects() {
  const totalWidth = HAND_SLOTS * HAND_CARD_WIDTH + (HAND_SLOTS - 1) * HAND_GAP;
  const startX = (getCanvasWidth() - totalWidth) / 2;
  const y = getCanvasHeight() - HAND_Y_OFFSET;

  const slots = [];
  for (let i = 0; i < HAND_SLOTS; i += 1) {
    slots.push({
      index: i,
      x: startX + i * (HAND_CARD_WIDTH + HAND_GAP),
      y,
      width: HAND_CARD_WIDTH,
      height: HAND_CARD_HEIGHT,
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
    createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 9, y: 24, hp: 2500 }),
    createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 7.2, y: 26.2, hp: 1400 }),
    createTroop({ id: "red_knight", cardId: "knight", team: "red", x: 10.2, y: 8, hp: 1400 }),
    createTroop({ id: "red_goblins", cardId: "goblins", team: "red", x: 8.4, y: 10, hp: 220 }),
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

function queuePlayerCardPlay(worldPosition, { cardIndex = appState.selectedCardIndex } = {}) {
  if (appState.mode !== "playing") {
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
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#1e466f");
  gradient.addColorStop(1, "#3d6e93");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const placementCardId = getActivePlacementCardId();
  const placementCard = placementCardId ? getCard(placementCardId) : null;
  if (placementCard?.type === "troop") {
    const splitY = worldToScreen({ x: arena.minX, y: 16 }).y;
    ctx.fillStyle = "rgba(83, 188, 248, 0.08)";
    ctx.fillRect(0, splitY, width, height - splitY);
    ctx.fillStyle = "rgba(233, 86, 86, 0.08)";
    ctx.fillRect(0, 0, width, splitY);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 4;
  const riverY = height * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, riverY);
  ctx.lineTo(width, riverY);
  ctx.stroke();
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

  const world = screenToWorld({ x: drag.currentX, y: drag.currentY });
  const screen = worldToScreen(world);
  const placementStatus = getPlacementStatus(drag.cardId, world, "blue");
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
}

function drawElixirPips({ x, y, actor, amount }) {
  const color = actor === "blue" ? "#7cb3ff" : "#ff9f9f";

  ctx.font = "12px Avenir Next";
  ctx.textAlign = "left";
  ctx.fillStyle = "#e5ecff";
  ctx.fillText(`${actor.toUpperCase()} ELIXIR`, x, y);

  for (let i = 0; i < MAX_ELIXIR; i += 1) {
    const pipX = x + i * 14;
    const filled = i < amount;
    ctx.fillStyle = filled ? color : "rgba(199, 214, 240, 0.25)";
    ctx.fillRect(pipX, y + 6, 10, 12);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pipX, y + 6, 10, 12);
  }
}

function drawHand() {
  const hand = appState.engine.getHand("blue");
  const deckQueue = appState.engine.getDeckQueue("blue");
  const slots = getHandSlotRects();
  const dragIndex = appState.dragState?.slotIndex ?? null;

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

    ctx.fillStyle = affordable ? "#ffffff" : "#b5bdd1";
    ctx.font = "12px Avenir Next";
    ctx.textAlign = "left";
    ctx.fillText(`${slot.index + 1}. ${CARD_LABEL[cardId] ?? cardId}`, slot.x + 8, slot.y + 20);

    ctx.textAlign = "right";
    ctx.fillText(`${card.cost} elixir`, slot.x + slot.width - 8, slot.y + 20);
    ctx.textAlign = "left";

    if (slot.index === 0 && deckQueue.length > 0) {
      const nextLabel = CARD_LABEL[deckQueue[0]] ?? deckQueue[0];
      ctx.fillStyle = "#9bb2da";
      ctx.fillText(`Next: ${nextLabel}`, slot.x + 8, slot.y + 40);
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
  const width = getCanvasWidth();
  const height = getCanvasHeight();
  const trainingSummary = summarizeTrainingStore(appState.trainingStore);
  const panelWidth = Math.min(560, width - 24);
  const panelHeight = 194;

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(12, 12, panelWidth, panelHeight);

  ctx.fillStyle = "#ffffff";
  ctx.font = "14px Avenir Next";
  ctx.textAlign = "left";
  ctx.fillText(`Mode: ${appState.mode} ${appState.paused ? "(paused)" : ""}`, 22, 34);
  ctx.fillText(`Bot: ${getTierLabel(appState.selectedBotTier)}`, 22, 54);
  ctx.fillText(`Phase: ${phase}`, 22, 74);
  ctx.fillText(`Crowns - Blue: ${score.blue_crowns} | Red: ${score.red_crowns}`, 22, 94);
  ctx.fillText(`Pending effects: ${appState.engine.state.pending_effects.length}`, 22, 114);
  ctx.fillText(
    `Training samples: ${trainingSummary.sample_count} | Self model: ${appState.selfModel?.ready ? "ready" : "not ready"}`,
    22,
    134,
  );
  ctx.fillText(
    `Time - Regulation: ${(regulationRemaining / TICK_RATE).toFixed(1)}s | Overtime: ${(overtimeRemaining / TICK_RATE).toFixed(1)}s`,
    22,
    154,
  );
  drawElixirPips({ x: 22, y: 164, actor: "blue", amount: appState.engine.state.elixir.blue.elixir });
  drawElixirPips({ x: 190, y: 164, actor: "red", amount: appState.engine.state.elixir.red.elixir });

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(12, height - 40, width - 24, 30);
  ctx.fillStyle = "#f6f9ff";
  ctx.fillText(`Controls: click or drag card to arena | ${appState.statusMessage}`, 20, height - 20);
}

function render() {
  drawArenaBackground();

  drawPendingEffects();

  for (const entity of appState.engine.state.entities) {
    drawEntity(entity);
  }

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
    const placementStatus = getPlacementStatus(drag.cardId, screenToWorld(point), "blue");
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
      const played = queuePlayerCardPlay(screenToWorld(point), { cardIndex: drag.slotIndex });
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

  queuePlayerCardPlay(screenToWorld({ x, y }));
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
