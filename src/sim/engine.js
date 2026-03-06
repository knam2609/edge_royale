import { saveReplay } from "../replay/codec.js";
import { getCard, DEFAULT_DECK } from "./cards.js";
import { stepCombat } from "./combat.js";
import { ARROWS_CONFIG, MATCH_CONFIG, getMatchPhase } from "./config.js";
import { ElixirTracker } from "./elixir.js";
import { applyForcedMotion, createTroop } from "./entities.js";
import { hashState } from "./hash.js";
import { evaluateMatchResult, getScoreSnapshot, isRegulationTieForOvertime } from "./match.js";
import { clampToArena, createArena } from "./map.js";
import { createRng } from "./random.js";
import { resolveArrowsImpact, resolveFireballImpact } from "./spells.js";

function cloneEntity(entity) {
  return {
    ...entity,
    forced_motion_vector: { ...entity.forced_motion_vector },
    velocity: { ...(entity.velocity ?? { x: 0, y: 0 }) },
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

function isLegalPlacement(arena, actor, card, x, y) {
  const bounded = clampToArena({ x, y }, arena);
  if (Math.abs(bounded.x - x) > 1e-9 || Math.abs(bounded.y - y) > 1e-9) {
    return false;
  }

  if (card.type !== "troop") {
    return true;
  }

  const midY = (arena.minY + arena.maxY) / 2;
  if (actor === "blue") {
    return y >= midY;
  }
  return y <= midY;
}

function applySpell({ state, actor, cardId, x, y, fireballConfig }) {
  if (cardId === "fireball") {
    const impact = resolveFireballImpact({
      tick: state.tick,
      impactX: x,
      impactY: y,
      entities: state.entities,
      arena: state.arena,
      sourceSpell: "fireball",
      actorTeam: actor,
      fireballConfig,
    });

    state.replay.events.push({
      type: "spell_impact",
      tick: state.tick,
      source_spell: "fireball",
      actor,
      impacted_entity_ids: impact.impacted_entity_ids,
      knockback_events: impact.knockback_events,
    });
    return;
  }

  if (cardId === "arrows") {
    const impact = resolveArrowsImpact({
      tick: state.tick,
      impactX: x,
      impactY: y,
      entities: state.entities,
      sourceSpell: "arrows",
      actorTeam: actor,
      arrowsConfig: ARROWS_CONFIG,
    });

    state.replay.events.push({
      type: "spell_impact",
      tick: state.tick,
      source_spell: "arrows",
      actor,
      impacted_entity_ids: impact.impacted_entity_ids,
      knockback_events: [],
    });
  }
}

function spawnTroops({ state, actor, card, x, y }) {
  const count = card.spawn_count ?? 1;
  const spread = card.spread ?? 0;

  for (let i = 0; i < count; i += 1) {
    const slotOffset = (i - (count - 1) / 2) * spread;
    const spawnPosition = clampToArena({ x: x + slotOffset, y }, state.arena);

    state.entities.push(
      createTroop({
        id: `${actor}_${card.id}_${state.spawn_sequence++}`,
        cardId: card.id,
        team: actor,
        x: spawnPosition.x,
        y: spawnPosition.y,
        hp: card.hp,
      }),
    );
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

  if (!isLegalPlacement(state.arena, actor, card, action.x, action.y)) {
    return false;
  }

  const tracker = state.elixir[actor];
  if (!tracker || !tracker.spend(card.cost)) {
    return false;
  }

  if (card.type === "spell") {
    applySpell({ state, actor, cardId: card.id, x: action.x, y: action.y, fireballConfig });
  } else {
    spawnTroops({ state, actor, card, x: action.x, y: action.y });
  }

  cyclePlayedCard(state.card_state, actor, card.id);

  state.replay.events.push({
    type: "card_played",
    tick: state.tick,
    actor,
    card_id: card.id,
    x: action.x,
    y: action.y,
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

  const impact = resolveFireballImpact({
    tick: state.tick,
    impactX: action.x,
    impactY: action.y,
    entities: state.entities,
    arena: state.arena,
    sourceSpell: "fireball",
    actorTeam: actor,
    fireballConfig,
  });

  state.replay.events.push({
    type: "spell_impact",
    tick: state.tick,
    source_spell: "fireball",
    actor,
    impacted_entity_ids: impact.impacted_entity_ids,
    knockback_events: impact.knockback_events,
  });

  return true;
}

export function createEngine({
  seed = 1,
  arena = createArena(),
  fireballConfig,
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

    stepCombat({ entities: state.entities, arena });

    state.entities.sort((a, b) => a.id.localeCompare(b.id));
    for (const entity of state.entities) {
      applyForcedMotion(entity, arena);
    }

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
      match_result: state.match_result,
      entities: state.entities.map((entity) => ({
        id: entity.id,
        hp: entity.hp,
        x: entity.x,
        y: entity.y,
        velocity: entity.velocity,
        target_entity_id: entity.target_entity_id,
        attack_cooldown_ticks_remaining: entity.attack_cooldown_ticks_remaining,
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
