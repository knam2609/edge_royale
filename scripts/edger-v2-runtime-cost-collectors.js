// Bounded timing collectors for the Edger v2 runtime-cost browser harness.
//
// Browser-safe and dependency-free so the staged page and the Node worker share
// the same table layout. Collectors only observe: they hold raw samples in
// preallocated Float64Arrays outside engine state, never overwrite a sample and
// flag overflow instead, so the harness can stop with a partial report. Nested
// timings (a tick inside a frame, engine/visual work inside a tick) overlap;
// they are separate measurements, not additive totals.

import {
  EDGER_V1_BASELINE_PHASES,
  EDGER_V2_DIAGNOSTIC_DECISION_KINDS,
  EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES,
  EDGER_V2_DIAGNOSTIC_PHASES,
} from "./edger-v2-runtime-cost-adapter.js";

// v2 adds the live-v1 baseline candidate table (v1_candidate_decisions).
export const RUNTIME_COST_SAMPLES_SCHEMA = "edger_v2_runtime_cost_samples_v2";

const CANDIDATE_PHASES = EDGER_V2_DIAGNOSTIC_PHASES.filter((phase) => phase !== "begin");
const V1_CANDIDATE_PHASES = EDGER_V1_BASELINE_PHASES.filter((phase) => phase !== "begin");
const OPPONENT_PHASES = EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES.filter((phase) => phase !== "begin");

// Column layouts. Durations are milliseconds from performance.now(); a NaN cell
// is a boundary that did not occur (for example the fixed controller's delay
// head, or pre-drain lag in a frame that was not playing).
export const RUNTIME_COST_TABLE_COLUMNS = Object.freeze({
  candidate_decisions: Object.freeze([
    "tick",
    "kind",
    ...CANDIDATE_PHASES.map((phase) => `${phase}_ms`),
    "total_ms",
  ]),
  v1_candidate_decisions: Object.freeze([
    "tick",
    "kind",
    ...V1_CANDIDATE_PHASES.map((phase) => `${phase}_ms`),
    "total_ms",
  ]),
  opponent_decisions: Object.freeze([
    "tick",
    "play",
    ...OPPONENT_PHASES.map((phase) => `${phase}_ms`),
    "total_ms",
  ]),
  ticks: Object.freeze(["tick", "frame", "tick_ms", "driver_ms", "engine_ms", "visual_ms"]),
  frames: Object.freeze([
    "frame",
    "raf_ms",
    "interval_ms",
    "pre_drain_lag_ms",
    "residual_lag_ms",
    "loop_iterations",
    "tick_advances",
    "drain_ms",
    "ticks_ms",
    "driver_ms",
    "engine_ms",
    "visual_ms",
    "render_ms",
    "callback_ms",
    "tick_after",
  ]),
});

export const RUNTIME_COST_TABLE_NAMES = Object.freeze(Object.keys(RUNTIME_COST_TABLE_COLUMNS));

// What each measured boundary includes; copied into every report.
export const RUNTIME_COST_BOUNDARIES = Object.freeze({
  candidate_decisions:
    "driver candidate decision: legal enumeration through scheduling; phases are consecutive " +
    "phaseHook boundaries and include the hook's own clock reads; schedule_ms includes the " +
    "driver's legality check and diagnostic schedule/count bookkeeping",
  v1_candidate_decisions:
    "live-v1 baseline candidate decision: legal enumeration, the unchanged live selectBotDecision " +
    "(delay roll then selection) as decide_ms, and schedule_ms (legality check, bookkeeping and " +
    "action construction); only live-v1 baseline matches have rows, and v2 matches have none",
  opponent_decisions:
    "driver v1 opponent decision: enumeration, selection, delay roll and action construction",
  ticks:
    "tick_ms is one whole stepGameTick call from the frame loop; driver_ms is " +
    "actionsForTick (both sides), engine_ms is engine.step, visual_ms is syncVisualState; " +
    "rows exist only for iterations that advanced state.tick",
  frames:
    "one frame callback: interval_ms is the elapsed time added to lag, pre_drain_lag_ms is lag " +
    "before draining, residual_lag_ms after; loop_iterations counts drain-loop passes and " +
    "tick_advances counts actual state.tick advances; drain_ms is the whole drain loop and " +
    "ticks_ms/driver_ms/engine_ms/visual_ms sum the frame's advancing ticks; render_ms is render(); " +
    "callback_ms runs from callback entry to the end of render",
});

export const RUNTIME_COST_KIND_CODES = Object.freeze(
  Object.fromEntries(EDGER_V2_DIAGNOSTIC_DECISION_KINDS.map((kind, index) => [kind, index])),
);

// Fixed-capacity table of numeric rows. push copies a scratch row; once full it
// refuses further rows and records overflow instead of overwriting.
export function createSampleTable({ name, columns, capacity }) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`table ${name} needs a positive integer capacity`);
  }
  const width = columns.length;
  const data = new Float64Array(capacity * width);
  let length = 0;
  let drained = 0;
  let refused = 0;
  return {
    name,
    columns,
    capacity,
    width,
    get length() {
      return length;
    },
    get overflowed() {
      return refused > 0;
    },
    get refused() {
      return refused;
    },
    push(row) {
      if (length >= capacity) {
        refused += 1;
        return false;
      }
      data.set(row.length === width ? row : row.subarray(0, width), length * width);
      length += 1;
      return true;
    },
    // Rows not yet drained, at most maxRows, as plain arrays (NaN preserved).
    drain(maxRows = Infinity) {
      const end = Math.min(length, drained + maxRows);
      const rows = [];
      for (let row = drained; row < end; row += 1) {
        rows.push(Array.from(data.subarray(row * width, (row + 1) * width)));
      }
      const chunk = { start: drained, rows };
      drained = end;
      return chunk;
    },
    pending() {
      return length - drained;
    },
  };
}

// All tables for one match plus the observers the staged page wires into the
// driver hooks and the frame/tick loop. `now` defaults to performance.now.
export function createRuntimeCostCollectors({ caps, now = () => performance.now() }) {
  const tables = {
    candidate_decisions: createSampleTable({
      name: "candidate_decisions",
      columns: RUNTIME_COST_TABLE_COLUMNS.candidate_decisions,
      capacity: caps.candidate_decisions,
    }),
    v1_candidate_decisions: createSampleTable({
      name: "v1_candidate_decisions",
      columns: RUNTIME_COST_TABLE_COLUMNS.v1_candidate_decisions,
      capacity: caps.v1_candidate_decisions,
    }),
    opponent_decisions: createSampleTable({
      name: "opponent_decisions",
      columns: RUNTIME_COST_TABLE_COLUMNS.opponent_decisions,
      capacity: caps.opponent_decisions,
    }),
    ticks: createSampleTable({ name: "ticks", columns: RUNTIME_COST_TABLE_COLUMNS.ticks, capacity: caps.ticks }),
    frames: createSampleTable({ name: "frames", columns: RUNTIME_COST_TABLE_COLUMNS.frames, capacity: caps.frames }),
  };

  const candidateColumn = Object.fromEntries(CANDIDATE_PHASES.map((phase, index) => [phase, index + 2]));
  const candidateRow = new Float64Array(tables.candidate_decisions.width);
  let candidateStart = null;
  let candidateLast = 0;
  function phaseHook(phase, detail) {
    const time = now();
    if (phase === "begin") {
      candidateRow.fill(Number.NaN);
      candidateStart = time;
      candidateLast = time;
      return;
    }
    const column = candidateColumn[phase];
    if (candidateStart === null || column === undefined) {
      throw new Error(`candidate phase ${phase} outside a decision`);
    }
    candidateRow[column] = time - candidateLast;
    candidateLast = time;
    if (phase === "schedule") {
      candidateRow[0] = detail.tick;
      candidateRow[1] = RUNTIME_COST_KIND_CODES[detail.kind];
      candidateRow[candidateRow.length - 1] = time - candidateStart;
      tables.candidate_decisions.push(candidateRow);
      candidateStart = null;
    }
  }

  const v1Column = Object.fromEntries(V1_CANDIDATE_PHASES.map((phase, index) => [phase, index + 2]));
  const v1Row = new Float64Array(tables.v1_candidate_decisions.width);
  let v1Start = null;
  let v1Last = 0;
  function v1PhaseHook(phase, detail) {
    const time = now();
    if (phase === "begin") {
      v1Row.fill(Number.NaN);
      v1Start = time;
      v1Last = time;
      return;
    }
    const column = v1Column[phase];
    if (v1Start === null || column === undefined) {
      throw new Error(`live-v1 candidate phase ${phase} outside a decision`);
    }
    v1Row[column] = time - v1Last;
    v1Last = time;
    if (phase === "schedule") {
      v1Row[0] = detail.tick;
      v1Row[1] = RUNTIME_COST_KIND_CODES[detail.kind];
      v1Row[v1Row.length - 1] = time - v1Start;
      tables.v1_candidate_decisions.push(v1Row);
      v1Start = null;
    }
  }

  const opponentColumn = Object.fromEntries(OPPONENT_PHASES.map((phase, index) => [phase, index + 2]));
  const opponentRow = new Float64Array(tables.opponent_decisions.width);
  let opponentStart = null;
  let opponentLast = 0;
  function opponentHook(phase, detail) {
    const time = now();
    if (phase === "begin") {
      opponentRow.fill(Number.NaN);
      opponentStart = time;
      opponentLast = time;
      return;
    }
    const column = opponentColumn[phase];
    if (opponentStart === null || column === undefined) {
      throw new Error(`opponent phase ${phase} outside a decision`);
    }
    opponentRow[column] = time - opponentLast;
    opponentLast = time;
    if (phase === "construct") {
      opponentRow[0] = detail.tick;
      opponentRow[1] = detail.play ? 1 : 0;
      opponentRow[opponentRow.length - 1] = time - opponentStart;
      tables.opponent_decisions.push(opponentRow);
      opponentStart = null;
    }
  }

  // stepGameTick reports its internal boundaries; the frame loop then reports
  // the whole call. A call that did not advance state.tick leaves no parts.
  let frameIndex = 0;
  let pendingTick = null;
  let pendingDriver = 0;
  let pendingEngine = 0;
  let pendingVisual = 0;
  let frameTicksMs = 0;
  let frameDriver = 0;
  let frameEngine = 0;
  let frameVisual = 0;
  const tickRow = new Float64Array(tables.ticks.width);
  function tickParts(tick, start, actionsEnd, stepEnd, visualEnd) {
    pendingTick = tick;
    pendingDriver = actionsEnd - start;
    pendingEngine = stepEnd - actionsEnd;
    pendingVisual = visualEnd - stepEnd;
  }
  function tickDone(start, end) {
    if (pendingTick === null) {
      return;
    }
    tickRow[0] = pendingTick;
    tickRow[1] = frameIndex;
    tickRow[2] = end - start;
    tickRow[3] = pendingDriver;
    tickRow[4] = pendingEngine;
    tickRow[5] = pendingVisual;
    tables.ticks.push(tickRow);
    frameTicksMs += end - start;
    frameDriver += pendingDriver;
    frameEngine += pendingEngine;
    frameVisual += pendingVisual;
    pendingTick = null;
  }

  const frameRow = new Float64Array(tables.frames.width);
  function frameDone(
    rafMs,
    intervalMs,
    preDrainLagMs,
    residualLagMs,
    loopIterations,
    tickAdvances,
    drainMs,
    renderMs,
    callbackMs,
    tickAfter,
  ) {
    frameRow[0] = frameIndex;
    frameRow[1] = rafMs;
    frameRow[2] = intervalMs;
    frameRow[3] = preDrainLagMs;
    frameRow[4] = residualLagMs;
    frameRow[5] = loopIterations;
    frameRow[6] = tickAdvances;
    frameRow[7] = drainMs;
    frameRow[8] = frameTicksMs;
    frameRow[9] = frameDriver;
    frameRow[10] = frameEngine;
    frameRow[11] = frameVisual;
    frameRow[12] = renderMs;
    frameRow[13] = callbackMs;
    frameRow[14] = tickAfter;
    tables.frames.push(frameRow);
    frameIndex += 1;
    frameTicksMs = 0;
    frameDriver = 0;
    frameEngine = 0;
    frameVisual = 0;
  }

  return {
    tables,
    phaseHook,
    v1PhaseHook,
    opponentHook,
    tickParts,
    tickDone,
    frameDone,
    overflowed: () => RUNTIME_COST_TABLE_NAMES.some((name) => tables[name].overflowed),
    refused: () => Object.fromEntries(RUNTIME_COST_TABLE_NAMES.map((name) => [name, tables[name].refused])),
    lengths: () => Object.fromEntries(RUNTIME_COST_TABLE_NAMES.map((name) => [name, tables[name].length])),
    drain(maxRows) {
      return Object.fromEntries(RUNTIME_COST_TABLE_NAMES.map((name) => [name, tables[name].drain(maxRows)]));
    },
    pending: () => RUNTIME_COST_TABLE_NAMES.reduce((sum, name) => sum + tables[name].pending(), 0),
  };
}

// Nearest-rank summary of raw samples; non-finite values (unmeasured cells)
// are excluded and counted separately.
export function summarizeSamples(values) {
  const finite = [];
  let missing = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      finite.push(value);
    } else {
      missing += 1;
    }
  }
  if (finite.length === 0) {
    return { count: 0, missing };
  }
  finite.sort((left, right) => left - right);
  const rank = (quantile) => finite[Math.max(0, Math.ceil(quantile * finite.length) - 1)];
  const round = (value) => Math.round(value * 1e4) / 1e4;
  return {
    count: finite.length,
    missing,
    min: round(finite[0]),
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
    p99: round(rank(0.99)),
    max: round(finite[finite.length - 1]),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    sum: round(finite.reduce((sum, value) => sum + value, 0)),
  };
}

function column(rows, columns, name) {
  const index = columns.indexOf(name);
  if (index < 0) {
    throw new Error(`unknown column ${name}`);
  }
  return rows.map((row) => (row[index] === null ? Number.NaN : row[index]));
}

function histogram(values) {
  const counts = {};
  for (const value of values) {
    if (Number.isFinite(value)) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return counts;
}

// Summaries of one match's drained rows (as written by the worker: arrays with
// null for NaN). Computed after the match, outside the page.
export function summarizeRuntimeCostTables(rowsByTable) {
  const columns = RUNTIME_COST_TABLE_COLUMNS;
  const candidate = rowsByTable.candidate_decisions ?? [];
  const v1Candidate = rowsByTable.v1_candidate_decisions ?? [];
  const opponent = rowsByTable.opponent_decisions ?? [];
  const ticks = rowsByTable.ticks ?? [];
  const frames = rowsByTable.frames ?? [];

  const byKind = {};
  EDGER_V2_DIAGNOSTIC_DECISION_KINDS.forEach((kind, code) => {
    const rows = candidate.filter((row) => row[1] === code);
    byKind[kind] = summarizeSamples(column(rows, columns.candidate_decisions, "total_ms"));
  });
  const candidatePhases = Object.fromEntries(
    columns.candidate_decisions.filter((name) => name.endsWith("_ms")).map((name) => [
      name,
      summarizeSamples(column(candidate, columns.candidate_decisions, name)),
    ]),
  );
  const v1ByKind = {};
  EDGER_V2_DIAGNOSTIC_DECISION_KINDS.forEach((kind, code) => {
    const rows = v1Candidate.filter((row) => row[1] === code);
    v1ByKind[kind] = summarizeSamples(column(rows, columns.v1_candidate_decisions, "total_ms"));
  });
  const v1Phases = Object.fromEntries(
    columns.v1_candidate_decisions.filter((name) => name.endsWith("_ms")).map((name) => [
      name,
      summarizeSamples(column(v1Candidate, columns.v1_candidate_decisions, name)),
    ]),
  );
  const opponentPhases = Object.fromEntries(
    columns.opponent_decisions.filter((name) => name.endsWith("_ms")).map((name) => [
      name,
      summarizeSamples(column(opponent, columns.opponent_decisions, name)),
    ]),
  );

  const playing = frames.filter((row) => Number.isFinite(row[3] ?? Number.NaN));
  const iterations = column(playing, columns.frames, "loop_iterations");
  const advances = column(playing, columns.frames, "tick_advances");
  const callbacks = column(frames, columns.frames, "callback_ms");
  // Slow callbacks (at least one tick period) and the next frame's advances.
  const following = [];
  for (let index = 0; index + 1 < frames.length; index += 1) {
    if (frames[index][13] >= 50) {
      following.push(frames[index + 1][6]);
    }
  }
  return {
    candidate_decisions: { count: candidate.length, total_by_kind: byKind, phases: candidatePhases },
    v1_candidate_decisions: { count: v1Candidate.length, total_by_kind: v1ByKind, phases: v1Phases },
    opponent_decisions: {
      count: opponent.length,
      plays: opponent.filter((row) => row[1] === 1).length,
      phases: opponentPhases,
    },
    ticks: Object.fromEntries(["tick_ms", "driver_ms", "engine_ms", "visual_ms"].map((name) => [
      name,
      summarizeSamples(column(ticks, columns.ticks, name)),
    ])),
    frames: {
      count: frames.length,
      playing: playing.length,
      interval_ms: summarizeSamples(column(frames, columns.frames, "interval_ms")),
      pre_drain_lag_ms: summarizeSamples(column(playing, columns.frames, "pre_drain_lag_ms")),
      residual_lag_ms: summarizeSamples(column(playing, columns.frames, "residual_lag_ms")),
      drain_ms: summarizeSamples(column(playing, columns.frames, "drain_ms")),
      render_ms: summarizeSamples(column(frames, columns.frames, "render_ms")),
      callback_ms: summarizeSamples(callbacks),
      tick_advances_histogram: histogram(advances),
      multi_tick_frames: advances.filter((value) => value >= 2).length,
      iterations_exceed_advances_frames: playing.filter((row) => row[5] > row[6]).length,
      max_loop_iterations: iterations.reduce((max, value) => Math.max(max, value), 0),
      slow_callbacks: following.length,
      following_frame_advances_histogram: histogram(following),
    },
  };
}
