import { FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { createTroop, createTower } from "../sim/entities.js";
import { createArena } from "../sim/map.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("reset-btn");

const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });

const appState = {
  mode: "ready",
  paused: false,
  pendingActions: [],
  statusMessage: "Click Start to begin.",
  engine: null,
  lastFrameTime: performance.now(),
  lagMs: 0,
};

function worldToScreen(position) {
  const px = ((position.x - arena.minX) / (arena.maxX - arena.minX)) * canvas.width;
  const py = ((position.y - arena.minY) / (arena.maxY - arena.minY)) * canvas.height;
  return { x: px, y: py };
}

function screenToWorld(position) {
  const x = arena.minX + (position.x / canvas.width) * (arena.maxX - arena.minX);
  const y = arena.minY + (position.y / canvas.height) * (arena.maxY - arena.minY);
  return { x: Math.max(arena.minX, Math.min(arena.maxX, x)), y: Math.max(arena.minY, Math.min(arena.maxY, y)) };
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
  appState.engine = createEngine({
    seed: 20260306,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: createInitialEntities(),
  });
  appState.pendingActions = [];
  appState.mode = "ready";
  appState.paused = false;
  appState.statusMessage = "Ready. Press Start to battle bots.";
}

function queuePlayerFireball(worldPosition) {
  if (appState.mode !== "playing") {
    return;
  }

  const nextTick = appState.engine.state.tick + 1;
  appState.pendingActions.push({
    tick: nextTick,
    type: "CAST_FIREBALL",
    actor: "blue",
    x: Math.round(worldPosition.x * 100) / 100,
    y: Math.round(worldPosition.y * 100) / 100,
  });
}

function pickBotTarget() {
  const enemies = appState.engine.state.entities.filter(
    (entity) => entity.team === "blue" && entity.hp > 0 && entity.entity_type === "troop",
  );

  if (enemies.length === 0) {
    return { x: 9, y: 26 };
  }

  enemies.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  return enemies[0];
}

function buildBotActions(tick) {
  const redElixir = appState.engine.state.elixir.red.elixir;
  if (tick % TICK_RATE !== 0 || redElixir < FIREBALL_CONFIG.cost) {
    return [];
  }

  const target = pickBotTarget();
  return [
    {
      tick,
      type: "CAST_FIREBALL",
      actor: "red",
      x: target.x,
      y: target.y,
    },
  ];
}

function isFinished() {
  const maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks;
  return appState.engine.state.tick >= maxTicks;
}

function stepGameTick() {
  if (appState.mode !== "playing" || appState.paused) {
    return;
  }

  const nextTick = appState.engine.state.tick + 1;

  if (!appState.engine.state.isOvertime && nextTick > MATCH_CONFIG.regulation_ticks) {
    appState.engine.setOvertime(true);
    appState.statusMessage = "Overtime started: 3x elixir active.";
  }

  const playerActions = appState.pendingActions.filter((action) => action.tick === nextTick);
  appState.pendingActions = appState.pendingActions.filter((action) => action.tick > nextTick);

  const botActions = buildBotActions(nextTick);
  appState.engine.step([...playerActions, ...botActions]);

  if (isFinished()) {
    appState.mode = "game_over";
    appState.statusMessage = "Match finished. Press Reset to run again.";
  }
}

function drawArenaBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#1e466f");
  gradient.addColorStop(1, "#3d6e93");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 4;
  const riverY = canvas.height * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, riverY);
  ctx.lineTo(canvas.width, riverY);
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
  ctx.fillText(entity.cardId.slice(0, 3).toUpperCase(), screen.x, screen.y + 4);

  const hpRatio = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
  const barWidth = entity.entity_type === "tower" ? 42 : 28;
  const barHeight = 4;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(screen.x - barWidth / 2, screen.y - radius - 10, barWidth, barHeight);
  ctx.fillStyle = "#6cf58a";
  ctx.fillRect(screen.x - barWidth / 2, screen.y - radius - 10, barWidth * hpRatio, barHeight);
}

function drawHud() {
  const tick = appState.engine.state.tick;
  const phase = getMatchPhase({ tick, isOvertime: appState.engine.state.isOvertime });

  const regulationRemaining = Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(tick, MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, tick - MATCH_CONFIG.regulation_ticks);
  const overtimeRemaining = Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed);

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(12, 12, 340, 94);

  ctx.fillStyle = "#ffffff";
  ctx.font = "14px Avenir Next";
  ctx.textAlign = "left";
  ctx.fillText(`Mode: ${appState.mode} ${appState.paused ? "(paused)" : ""}`, 22, 34);
  ctx.fillText(`Phase: ${phase}`, 22, 54);
  ctx.fillText(`Elixir - Blue: ${appState.engine.state.elixir.blue.elixir} | Red: ${appState.engine.state.elixir.red.elixir}`, 22, 74);
  ctx.fillText(
    `Time - Regulation: ${(regulationRemaining / TICK_RATE).toFixed(1)}s | Overtime: ${(overtimeRemaining / TICK_RATE).toFixed(1)}s`,
    22,
    94,
  );

  ctx.fillStyle = "rgba(12, 20, 38, 0.72)";
  ctx.fillRect(12, canvas.height - 46, canvas.width - 24, 34);
  ctx.fillStyle = "#f6f9ff";
  ctx.fillText(`Controls: click to cast Fireball (cost 4), Space pause, R reset, F fullscreen | ${appState.statusMessage}`, 20, canvas.height - 24);
}

function render() {
  drawArenaBackground();

  for (const entity of appState.engine.state.entities) {
    drawEntity(entity);
  }

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

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  queuePlayerFireball(screenToWorld({ x, y }));
});

startBtn.addEventListener("click", () => {
  appState.mode = "playing";
  appState.statusMessage = "Battle started. Deflect pushes with Fireball knockback.";
});

resetBtn.addEventListener("click", () => {
  resetGame();
});

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    appState.paused = !appState.paused;
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

window.advanceTime = (ms) => {
  const tickCount = Math.max(1, Math.round(ms / (1000 / TICK_RATE)));
  const previousMode = appState.mode;
  if (appState.mode === "ready") {
    appState.mode = "playing";
  }
  runTicks(tickCount);
  if (previousMode === "ready") {
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
    mode: appState.mode,
    tick,
    phase,
    elixir: {
      blue: appState.engine.state.elixir.blue.elixir,
      red: appState.engine.state.elixir.red.elixir,
    },
    timers: {
      regulation_remaining_s: Number((regulationRemaining / TICK_RATE).toFixed(2)),
      overtime_remaining_s: Number((overtimeRemaining / TICK_RATE).toFixed(2)),
    },
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

resetGame();
render();
requestAnimationFrame(frame);
