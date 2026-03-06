import { saveReplay } from "../replay/codec.js";
import { stepCombat } from "./combat.js";
import { ElixirTracker } from "./elixir.js";
import { applyForcedMotion } from "./entities.js";
import { MATCH_CONFIG, getMatchPhase } from "./config.js";
import { hashState } from "./hash.js";
import { evaluateMatchResult, getScoreSnapshot, isRegulationTieForOvertime } from "./match.js";
import { createArena } from "./map.js";
import { createRng } from "./random.js";
import { resolveFireballImpact } from "./spells.js";

function cloneEntity(entity) {
  return {
    ...entity,
    forced_motion_vector: { ...entity.forced_motion_vector },
    velocity: { ...(entity.velocity ?? { x: 0, y: 0 }) },
  };
}

function fireballCost(config) {
  return config?.cost ?? 4;
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

export function createEngine({
  seed = 1,
  arena = createArena(),
  fireballConfig,
  initialEntities = [],
  initialOvertime = false,
} = {}) {
  const rng = createRng(seed);

  const state = {
    seed,
    tick: 0,
    isOvertime: initialOvertime,
    overtime_start_tick: initialOvertime ? 0 : null,
    entities: initialEntities.map(cloneEntity),
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
      if (action.type === "CAST_FIREBALL") {
        const actor = action.actor ?? "blue";
        const tracker = state.elixir[actor];
        if (!tracker || !tracker.spend(fireballCost(fireballConfig))) {
          continue;
        }

        const impact = resolveFireballImpact({
          tick: state.tick,
          impactX: action.x,
          impactY: action.y,
          entities: state.entities,
          arena,
          sourceSpell: "fireball",
          fireballConfig,
        });

        state.replay.events.push({
          type: "spell_impact",
          tick: state.tick,
          source_spell: "fireball",
          impacted_entity_ids: impact.impacted_entity_ids,
          knockback_events: impact.knockback_events,
        });
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
    getMatchResult,
    getScore,
    shouldStartOvertime,
    getStateHash,
    exportReplay,
  };
}
