import { saveReplay } from "../replay/codec.js";
import { getCard, DEFAULT_DECK } from "./cards.js";
import { resolveTroopBodyCollisions, stepCombat } from "./combat.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, TICK_RATE, getMatchPhase } from "./config.js";
import { ElixirTracker } from "./elixir.js";
import { applyForcedMotion, createTroop } from "./entities.js";
import { hashState } from "./hash.js";
import { evaluateMatchResult, getScoreSnapshot, isRegulationTieForOvertime } from "./match.js";
import { clampToArena, createArena, getNearestBridge, snapPositionToGrid } from "./map.js";
import { getTroopPlacementStatus } from "./placement.js";
import { createRng } from "./random.js";
import { resolveArrowsImpact, resolveFireballImpact } from "./spells.js";

const POSITION_EPSILON = 1e-9;

function cloneEntity(entity) {
  return {
    ...entity,
    forced_motion_vector: { ...entity.forced_motion_vector },
    velocity: { ...(entity.velocity ?? { x: 0, y: 0 }) },
    ground_blocker: entity.ground_blocker ? { ...entity.ground_blocker } : entity.ground_blocker,
  };
}

function cloneCardState(cardState) {
  return {
    blue: {
      hand: [...cardState.blue.hand],
      draw_pile: [...cardState.blue.draw_pile],
    },
    red: {
      hand: [...cardState.red.hand],
      draw_pile: [...cardState.red.draw_pile],
    },
  };
}

function clonePendingEffect(effect) {
  return {
    ...effect,
  };
}

function sortActions(actions) {
  return [...actions].sort((a, b) => {
    if (a.tick !== b.tick) {
      return a.tick - b.tick;
    }
    if (a.type !== b.type) {
      return a.type.localeCompare(b.type);
    }
    return (a.actor ?? "").localeCompare(b.actor ?? "");
  });
}

function sortEffects(effects) {
  return [...effects].sort((a, b) => {
    if (a.resolve_tick !== b.resolve_tick) {
      return a.resolve_tick - b.resolve_tick;
    }
    if (a.enqueue_tick !== b.enqueue_tick) {
      return a.enqueue_tick - b.enqueue_tick;
    }
    if (a.effect_type !== b.effect_type) {
      return a.effect_type.localeCompare(b.effect_type);
    }
    return a.effect_id - b.effect_id;
  });
}

function shuffleDeck(deck, rng) {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

function makeInitialCardState(rng, providedCardState) {
  if (providedCardState) {
    return cloneCardState(providedCardState);
  }

  const createForActor = () => {
    const shuffled = shuffleDeck(DEFAULT_DECK, rng);
    return {
      hand: shuffled.slice(0, 4),
      draw_pile: shuffled.slice(4),
    };
  };

  return {
    blue: createForActor(),
    red: createForActor(),
  };
}

function removeFirst(array, item) {
  const index = array.indexOf(item);
  if (index === -1) {
    return false;
  }
  array.splice(index, 1);
  return true;
}

function cyclePlayedCard(cardState, actor, cardId) {
  const side = cardState[actor];
  if (!side || !removeFirst(side.hand, cardId)) {
    return false;
  }

  const nextCard = side.draw_pile.shift();
  if (nextCard) {
    side.hand.push(nextCard);
  }
  side.draw_pile.push(cardId);
  return true;
}

function isLegalPlacement(arena, entities, actor, card, x, y) {
  const snapped = snapPositionToGrid({ x, y }, arena);
  const bounded = clampToArena(snapped, arena);
  if (Math.abs(bounded.x - snapped.x) > 1e-9 || Math.abs(bounded.y - snapped.y) > 1e-9) {
    return false;
  }

  if (card.type !== "troop") {
    return true;
  }
  return getTroopPlacementStatus({ arena, entities, actor, position: snapped }).ok;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function getDefaultLaunchPosition(arena, actor) {
  return {
    x: (arena.minX + arena.maxX) / 2,
    y: actor === "blue" ? arena.maxY : arena.minY,
  };
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function snapshotPositions(entities) {
  return new Map(entities.map((entity) => [entity.id, { x: entity.x, y: entity.y }]));
}

function updateEntityVelocities(entities, startPositions) {
  for (const entity of entities) {
    const start = startPositions.get(entity.id);
    if (!start || entity.hp <= 0) {
      entity.velocity = { x: 0, y: 0 };
      continue;
    }

    entity.velocity = {
      x: roundCoord(entity.x - start.x),
      y: roundCoord(entity.y - start.y),
    };
  }
}

function getCenterDeploymentColumns(arena) {
  const centerX = (arena.minX + arena.maxX) * 0.5;
  if (!arena.grid) {
    return [roundCoord(centerX)];
  }

  const { step, offsetX } = arena.grid;
  const minSnap = arena.minX + offsetX;
  const maxSnap = arena.maxX - (step - offsetX);
  const columns = [];

  for (let x = minSnap; x <= maxSnap + POSITION_EPSILON; x += step) {
    columns.push(roundCoord(x));
  }

  let minDistance = Number.POSITIVE_INFINITY;
  const closest = [];
  for (const column of columns) {
    const distance = Math.abs(column - centerX);
    if (distance + POSITION_EPSILON < minDistance) {
      minDistance = distance;
      closest.length = 0;
      closest.push(column);
      continue;
    }

    if (Math.abs(distance - minDistance) <= POSITION_EPSILON) {
      closest.push(column);
    }
  }

  return closest;
}

function isCenterSplitDeploy(arena, x) {
  return getCenterDeploymentColumns(arena).some((column) => Math.abs(column - x) <= POSITION_EPSILON);
}

function getSpawnBridgeAssignments(arena, baseX, formation) {
  const count = formation.length;
  if (!arena.bridges?.length || count === 0) {
    return [];
  }

  const nearestBridgeX = getNearestBridge(arena, baseX)?.x ?? baseX;
  if (count < 2 || arena.bridges.length < 2 || !isCenterSplitDeploy(arena, baseX)) {
    return Array(count).fill(nearestBridgeX);
  }

  const orderedBridges = [...arena.bridges].sort((a, b) => a.x - b.x);
  const leftBridgeX = orderedBridges[0]?.x ?? nearestBridgeX;
  const rightBridgeX = orderedBridges[orderedBridges.length - 1]?.x ?? nearestBridgeX;
  const bridgeAssignments = Array(count).fill(rightBridgeX);
  const leftCount = Math.floor(count * 0.5);
  const orderedIndices = formation
    .map((offset, index) => ({ index, x: offset.x ?? 0, y: offset.y ?? 0 }))
    .sort((a, b) => {
      if (a.x !== b.x) {
        return a.x - b.x;
      }
      if (a.y !== b.y) {
        return a.y - b.y;
      }
      return a.index - b.index;
    });

  for (let i = 0; i < leftCount; i += 1) {
    bridgeAssignments[orderedIndices[i].index] = leftBridgeX;
  }

  return bridgeAssignments;
}

function getFireballLaunchPosition(state, actor, impactX, impactY) {
  const towers = state.entities.filter(
    (entity) => entity.team === actor && entity.entity_type === "tower" && entity.hp > 0,
  );

  if (towers.length === 0) {
    return getDefaultLaunchPosition(state.arena, actor);
  }

  const target = { x: impactX, y: impactY };
  towers.sort((a, b) => {
    const distA = squaredDistance(a, target);
    const distB = squaredDistance(b, target);
    if (distA !== distB) {
      return distA - distB;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    x: towers[0].x,
    y: towers[0].y,
  };
}

function getFireballTiming({ state, actor, x, y, fireballConfig }) {
  const launchPosition = getFireballLaunchPosition(state, actor, x, y);
  const castDelayTicks = fireballConfig.cast_delay_ticks ?? 0;
  const speedTilesPerSecond = fireballConfig.travel_speed_tiles_per_second ?? 10;

  let travelTicks = 1;
  if (speedTilesPerSecond > 0) {
    const distance = Math.hypot(x - launchPosition.x, y - launchPosition.y);
    const travelSeconds = distance / speedTilesPerSecond;
    travelTicks = Math.max(1, Math.round(travelSeconds * TICK_RATE));
  }

  return {
    castDelayTicks,
    travelTicks,
    launchPosition,
    resolveTick: state.tick + castDelayTicks + travelTicks,
  };
}

function enqueueScheduledEffect({ state, effect }) {
  const scheduled = {
    effect_id: state.effect_sequence++,
    enqueue_tick: state.tick,
    ...effect,
  };

  state.pending_effects.push(scheduled);
  state.replay.events.push({
    type: "effect_scheduled",
    tick: state.tick,
    effect_id: scheduled.effect_id,
    effect_type: scheduled.effect_type,
    actor: scheduled.actor,
    card_id: scheduled.card_id,
    resolve_tick: scheduled.resolve_tick,
    x: scheduled.x,
    y: scheduled.y,
  });

  return scheduled;
}

function spawnTroops({ state, actor, card, x, y }) {
  const basePosition = clampToArena({ x, y }, state.arena);
  const formation = Array.isArray(card.spawn_offsets) && card.spawn_offsets.length > 0
    ? card.spawn_offsets
    : [{ x: 0, y: 0 }];
  const count = formation.length;
  const yDirection = actor === "blue" ? 1 : -1;
  const createdEntityIds = [];
  const bridgeAssignments = getSpawnBridgeAssignments(state.arena, basePosition.x, formation);

  for (let i = 0; i < count; i += 1) {
    const offset = formation[i] ?? { x: 0, y: 0 };
    const spawnPosition = clampToArena(
      {
        x: basePosition.x + (offset.x ?? 0),
        y: basePosition.y + (offset.y ?? 0) * yDirection,
      },
      state.arena,
    );
    const entityId = `${actor}_${card.id}_${state.spawn_sequence++}`;
    const troop = createTroop({
      id: entityId,
      cardId: card.id,
      team: actor,
      x: spawnPosition.x,
      y: spawnPosition.y,
      hp: card.hp,
    });
    troop.preferred_lane_x = bridgeAssignments[i] ?? troop.x;

    state.entities.push(troop);

    createdEntityIds.push(entityId);
  }

  return createdEntityIds;
}

function resolveScheduledTroopDeploy({ state, effect }) {
  const card = getCard(effect.card_id);
  if (!card || card.type !== "troop") {
    return;
  }

  const entityIds = spawnTroops({
    state,
    actor: effect.actor,
    card,
    x: effect.x,
    y: effect.y,
  });

  state.replay.events.push({
    type: "troop_deployed",
    tick: state.tick,
    effect_id: effect.effect_id,
    actor: effect.actor,
    card_id: card.id,
    x: effect.x,
    y: effect.y,
    entity_ids: entityIds,
  });
}

function resolveScheduledSpell({ state, effect, fireballConfig }) {
  if (effect.card_id === "fireball") {
    const impact = resolveFireballImpact({
      tick: state.tick,
      impactX: effect.x,
      impactY: effect.y,
      entities: state.entities,
      arena: state.arena,
      sourceSpell: "fireball",
      actorTeam: effect.actor,
      fireballConfig,
    });

    state.replay.events.push({
      type: "spell_impact",
      tick: state.tick,
      effect_id: effect.effect_id,
      source_spell: "fireball",
      actor: effect.actor,
      x: effect.x,
      y: effect.y,
      impacted_entity_ids: impact.impacted_entity_ids,
      knockback_events: impact.knockback_events,
    });
    return;
  }

  if (effect.card_id === "arrows") {
    const impact = resolveArrowsImpact({
      tick: state.tick,
      impactX: effect.x,
      impactY: effect.y,
      entities: state.entities,
      sourceSpell: "arrows",
      actorTeam: effect.actor,
      arrowsConfig: ARROWS_CONFIG,
    });

    state.replay.events.push({
      type: "spell_impact",
      tick: state.tick,
      effect_id: effect.effect_id,
      source_spell: "arrows",
      actor: effect.actor,
      x: effect.x,
      y: effect.y,
      impacted_entity_ids: impact.impacted_entity_ids,
      knockback_events: [],
    });
  }
}

function scheduleCardEffect({ state, actor, card, x, y, fireballConfig }) {
  if (card.type === "troop") {
    const deployTicks = card.deploy_time_ticks ?? 0;
    return enqueueScheduledEffect({
      state,
      effect: {
        resolve_tick: state.tick + deployTicks,
        effect_type: "troop_deploy",
        actor,
        card_id: card.id,
        x,
        y,
      },
    });
  }

  if (card.id === "fireball") {
    const timing = getFireballTiming({ state, actor, x, y, fireballConfig });
    return enqueueScheduledEffect({
      state,
      effect: {
        resolve_tick: timing.resolveTick,
        effect_type: "spell_fireball",
        actor,
        card_id: card.id,
        x,
        y,
        launch_x: timing.launchPosition.x,
        launch_y: timing.launchPosition.y,
        cast_delay_ticks: timing.castDelayTicks,
        travel_ticks: timing.travelTicks,
      },
    });
  }

  if (card.id === "arrows") {
    const castDelayTicks = ARROWS_CONFIG.cast_delay_ticks ?? 0;
    return enqueueScheduledEffect({
      state,
      effect: {
        resolve_tick: state.tick + castDelayTicks,
        effect_type: "spell_arrows",
        actor,
        card_id: card.id,
        x,
        y,
        cast_delay_ticks: castDelayTicks,
      },
    });
  }

  return null;
}

function processDueEffects({ state, fireballConfig }) {
  if (state.pending_effects.length === 0) {
    return;
  }

  const due = [];
  const pending = [];

  for (const effect of state.pending_effects) {
    if (effect.resolve_tick <= state.tick) {
      due.push(effect);
    } else {
      pending.push(effect);
    }
  }

  state.pending_effects = pending;

  for (const effect of sortEffects(due)) {
    if (effect.effect_type === "troop_deploy") {
      resolveScheduledTroopDeploy({ state, effect });
      continue;
    }

    if (effect.effect_type === "spell_fireball" || effect.effect_type === "spell_arrows") {
      resolveScheduledSpell({ state, effect, fireballConfig });
    }
  }
}

function processPlayCardAction({ state, action, fireballConfig }) {
  const actor = action.actor ?? "blue";
  const side = state.card_state[actor];
  if (!side) {
    return false;
  }

  const card = getCard(action.cardId);
  if (!card || !side.hand.includes(card.id)) {
    return false;
  }

  const snappedPosition = snapPositionToGrid({ x: action.x, y: action.y }, state.arena);

  if (!isLegalPlacement(state.arena, state.entities, actor, card, snappedPosition.x, snappedPosition.y)) {
    return false;
  }

  const tracker = state.elixir[actor];
  if (!tracker || !tracker.spend(card.cost)) {
    return false;
  }

  const scheduledEffect = scheduleCardEffect({
    state,
    actor,
    card,
    x: snappedPosition.x,
    y: snappedPosition.y,
    fireballConfig,
  });
  if (!scheduledEffect) {
    return false;
  }

  cyclePlayedCard(state.card_state, actor, card.id);

  state.replay.events.push({
    type: "card_played",
    tick: state.tick,
    actor,
    card_id: card.id,
    x: snappedPosition.x,
    y: snappedPosition.y,
    effect_id: scheduledEffect.effect_id,
    resolve_tick: scheduledEffect.resolve_tick,
    hand_after: [...state.card_state[actor].hand],
  });

  return true;
}

function processLegacyCastFireball({ state, action, fireballConfig }) {
  const actor = action.actor ?? "blue";
  const tracker = state.elixir[actor];
  if (!tracker || !tracker.spend(fireballConfig.cost ?? 4)) {
    return false;
  }

  scheduleCardEffect({
    state,
    actor,
    card: getCard("fireball"),
    x: action.x,
    y: action.y,
    fireballConfig,
  });

  return true;
}

export function createEngine({
  seed = 1,
  arena = createArena(),
  fireballConfig = FIREBALL_CONFIG,
  initialEntities = [],
  initialOvertime = false,
  initialCardState = null,
} = {}) {
  const rng = createRng(seed);

  const state = {
    seed,
    tick: 0,
    arena,
    isOvertime: initialOvertime,
    overtime_start_tick: initialOvertime ? 0 : null,
    entities: initialEntities.map(cloneEntity),
    spawn_sequence: 1,
    effect_sequence: 1,
    pending_effects: [],
    recent_combat_events: [],
    card_state: makeInitialCardState(rng, initialCardState),
    replay: {
      seed,
      actions: [],
      events: [],
    },
    match_result: null,
    elixir: {
      blue: new ElixirTracker(),
      red: new ElixirTracker(),
    },
  };

  function setOvertime(flag) {
    const nextFlag = Boolean(flag);
    if (nextFlag && !state.isOvertime) {
      state.overtime_start_tick = state.tick;
    }
    if (!nextFlag) {
      state.overtime_start_tick = null;
    }
    state.isOvertime = nextFlag;
  }

  function getMatchResult() {
    return state.match_result;
  }

  function getScore() {
    return getScoreSnapshot(state.entities);
  }

  function getHand(actor) {
    return [...(state.card_state[actor]?.hand ?? [])];
  }

  function getDeckQueue(actor) {
    return [...(state.card_state[actor]?.draw_pile ?? [])];
  }

  function shouldStartOvertime() {
    if (state.isOvertime || state.tick < 1 || state.match_result) {
      return false;
    }
    return isRegulationTieForOvertime(getScore()) && state.tick >= MATCH_CONFIG.regulation_ticks;
  }

  function step(actionsForTick = []) {
    if (state.match_result) {
      state.recent_combat_events = [];
      return getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
    }

    state.tick += 1;
    const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
    state.elixir.blue.tick(phase);
    state.elixir.red.tick(phase);

    const actions = sortActions(actionsForTick).filter((action) => action.tick === state.tick);

    for (const action of actions) {
      state.replay.actions.push(action);

      if (action.type === "PLAY_CARD") {
        processPlayCardAction({ state, action, fireballConfig });
      } else if (action.type === "CAST_FIREBALL") {
        processLegacyCastFireball({ state, action, fireballConfig });
      }
    }

    processDueEffects({ state, fireballConfig });

    const positionsAtTickStart = snapshotPositions(state.entities);
    state.recent_combat_events = stepCombat({ entities: state.entities, arena }).map((event) => ({
      ...event,
      tick: state.tick,
    }));

    state.entities.sort((a, b) => a.id.localeCompare(b.id));
    for (const entity of state.entities) {
      applyForcedMotion(entity, arena, state.entities);
    }
    const enemyCollisionDisplacedTroopIds = new Set(resolveTroopBodyCollisions({ entities: state.entities, arena }));
    for (const entity of state.entities) {
      if (entity.entity_type !== "troop") {
        continue;
      }

      if (enemyCollisionDisplacedTroopIds.has(entity.id)) {
        entity.enemy_collision_retarget_pending = true;
      }
    }
    updateEntityVelocities(state.entities, positionsAtTickStart);

    const result = evaluateMatchResult({
      tick: state.tick,
      isOvertime: state.isOvertime,
      entities: state.entities,
      overtimeStartTick: state.overtime_start_tick,
    });

    if (result) {
      state.match_result = result;
      state.replay.events.push({
        type: "match_result",
        tick: result.tick,
        winner: result.winner,
        reason: result.reason,
        score: result.score,
      });
    }

    return phase;
  }

  function run(actions = [], totalTicks = 120) {
    const indexed = actions.reduce((acc, action) => {
      const list = acc.get(action.tick) ?? [];
      list.push(action);
      acc.set(action.tick, list);
      return acc;
    }, new Map());

    for (let tick = 1; tick <= totalTicks; tick += 1) {
      step(indexed.get(tick) ?? []);
      if (state.match_result) {
        break;
      }
      rng();
    }

    return state;
  }

  function getStateHash() {
    return hashState({
      tick: state.tick,
      isOvertime: state.isOvertime,
      overtime_start_tick: state.overtime_start_tick,
      card_state: state.card_state,
      pending_effects: sortEffects(state.pending_effects).map(clonePendingEffect),
      effect_sequence: state.effect_sequence,
      match_result: state.match_result,
      entities: state.entities.map((entity) => ({
        id: entity.id,
        hp: entity.hp,
        x: entity.x,
        y: entity.y,
        velocity: entity.velocity,
        target_entity_id: entity.target_entity_id,
        preferred_lane_x: entity.preferred_lane_x ?? null,
        is_active: entity.is_active ?? null,
        collision_radius: entity.collision_radius ?? null,
        body_mass: entity.body_mass ?? null,
        attack_cooldown_ticks_remaining: entity.attack_cooldown_ticks_remaining,
        enemy_collision_retarget_pending: entity.enemy_collision_retarget_pending ?? null,
        forced_motion_vector: entity.forced_motion_vector,
        forced_motion_ticks_remaining: entity.forced_motion_ticks_remaining,
      })),
      replayEvents: state.replay.events,
    });
  }

  function exportReplay() {
    return saveReplay(state.replay);
  }

  return {
    state,
    run,
    step,
    setOvertime,
    getHand,
    getDeckQueue,
    getMatchResult,
    getScore,
    shouldStartOvertime,
    getStateHash,
    exportReplay,
  };
}
