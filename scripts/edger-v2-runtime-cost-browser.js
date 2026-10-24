// Browser side of the Edger v2 runtime-cost harness.
//
// Loaded only by the generated diagnostic module in a runtime-cost stage
// (src/client/webGameRuntimeCost.js); the live index.html and webGame.js never
// import it. The generated module keeps the production renderer, visual sync,
// stepGameTick order and uncapped 20 Hz drain loop, and calls back here for:
//
// - the match seed and a fresh diagnostic driver per match (onReset);
// - both sides' actions (actionsForTick), recorded in raw driver order before
//   engine.step sorts them, so the stream hash equals the frozen reference's;
// - frame/tick observers, which stay null when collectors are off;
// - whether the frame callback re-arms requestAnimationFrame.
//
// Exactly one clock advances a match: real-time rAF timestamps, or a synthetic
// clock that calls the same frame function with scripted timestamps while rAF is
// disabled (validation fast-forward and the controlled elapsed jump). Synthetic
// results carry frame_pacing_claim: false. Digests and the final record are
// computed in a separate task after the terminal frame, outside its callback.
//
// A match is a v2 condition (model and controller) or, with kind
// "v1_baseline", the live-v1 cost baseline, which drives the candidate with the
// unchanged live selectBotDecision path. With collectors on, the page also
// keeps bounded long-task entries and heap snapshots (performance.memory).

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { selectEdgerV2PolicyDecision, validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  EDGER_V2_DIAGNOSTIC_CONTROLLERS,
  EDGER_V2_DIAGNOSTIC_PHASES,
  createEdgerV1BaselineDriver,
  createEdgerV2DiagnosticDriver,
  decideEdgerV2Diagnostic,
} from "./edger-v2-runtime-cost-adapter.js";
import {
  RUNTIME_COST_BOUNDARIES,
  RUNTIME_COST_SAMPLES_SCHEMA,
  createRuntimeCostCollectors,
} from "./edger-v2-runtime-cost-collectors.js";

// v2 adds live-v1 baseline matches, long tasks and heap snapshots.
export const EDGER_V2_RUNTIME_COST_BROWSER_SCHEMA = "edger_v2_runtime_cost_browser_v2";
export const EDGER_V1_BASELINE_KIND = "v1_baseline";
const MISMATCH_CAP = 50;
const CONTROLLERS = [EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED, EDGER_V2_DIAGNOSTIC_CONTROLLERS.FIXED_ONE_TICK];
const ACTORS = ["blue", "red"];
const DECISION_PHASES = EDGER_V2_DIAGNOSTIC_PHASES.filter((phase) =>
  !["begin", "enumerate", "schedule"].includes(phase));

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// UTF-8 SHA-256, matching Node's createHash("sha256").update(string).
async function sha256Text(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function fetchVerified(url, sha256) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`fetch ${url} failed with ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== sha256) {
    throw new Error(`${url} hashes to ${digest}, expected ${sha256}`);
  }
  return new TextDecoder().decode(bytes);
}

// Smallest observable performance.now() step, bounded in iterations.
function timerResolutionMs() {
  let smallest = Infinity;
  let last = performance.now();
  for (let index = 0; index < 200_000 && smallest > 0.001; index += 1) {
    const time = performance.now();
    if (time > last) {
      smallest = Math.min(smallest, time - last);
      last = time;
    }
  }
  return smallest;
}

const yieldChannel = typeof MessageChannel === "function" ? new MessageChannel() : null;
const yieldQueue = [];
if (yieldChannel) {
  yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
}
function yieldTask() {
  return new Promise((resolve) => {
    if (yieldChannel) {
      yieldQueue.push(resolve);
      yieldChannel.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function decisionKey(decision) {
  return JSON.stringify({ action: decision.action, delayTicks: decision.delayTicks, indices: decision.indices });
}

function expectedPhases(controller) {
  return DECISION_PHASES.filter((phase) =>
    phase !== "delay_head" || controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED);
}

function heapSnapshot() {
  const memory = performance.memory;
  return memory
    ? { at_ms: performance.now(), used_js_heap: memory.usedJSHeapSize, total_js_heap: memory.totalJSHeapSize }
    : null;
}

// Bounded long-task entries ([start, duration] in ms) while a match plays.
function createLongTaskRecorder(cap) {
  const entries = [];
  let refused = 0;
  let observer = null;
  if (typeof PerformanceObserver === "function" &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask")) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entries.length < cap) {
          entries.push([entry.startTime, entry.duration]);
        } else {
          refused += 1;
        }
      }
    });
  }
  return {
    start() {
      observer?.observe({ type: "longtask", buffered: false });
    },
    stop() {
      observer?.disconnect();
      return { supported: observer !== null, cap, count: entries.length, refused, entries };
    },
  };
}

// Same tick loop as the Node core's rebuildEngineAt.
function rebuildEngineAt({ seed, actions, tick }) {
  const engine = createProductionEngine({ seed });
  const byTick = new Map();
  for (const action of actions) {
    const list = byTick.get(action.tick) ?? [];
    list.push(action);
    byTick.set(action.tick, list);
  }
  while (engine.state.tick < tick - 1) {
    if (engine.getMatchResult()) {
      throw new Error(`source seed ${seed} ended before tick ${tick}`);
    }
    engine.step(byTick.get(engine.state.tick + 1) ?? []);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  return engine;
}

export function installEdgerV2RuntimeCostDiagnostic({ appState, resetGame, render, frame }) {
  const params = new URLSearchParams(window.location.search);
  const idleSeed = Number.parseInt(params.get("seed") ?? "1", 10);
  const models = new Map();
  const visibilityEvents = [];
  let pending = null;
  let match = null;
  let rafLoop = false;

  const hooks = {
    frameObserver: null,
    tickObserver: null,
    matchSeed() {
      return pending ? pending.seed : idleSeed;
    },
    onReset(engine) {
      if (!pending) {
        return;
      }
      const config = pending;
      pending = null;
      const collectors = config.collectors ? createRuntimeCostCollectors({ caps: config.caps }) : null;
      const driver = config.kind === EDGER_V1_BASELINE_KIND
        ? createEdgerV1BaselineDriver({
            seed: config.seed,
            candidateActor: config.candidate_actor,
            phaseHook: collectors?.v1PhaseHook ?? null,
            opponentHook: collectors?.opponentHook ?? null,
          })
        : createEdgerV2DiagnosticDriver({
            seed: config.seed,
            candidateActor: config.candidate_actor,
            model: models.get(config.model),
            controller: config.controller,
            phaseHook: collectors?.phaseHook ?? null,
            opponentHook: collectors?.opponentHook ?? null,
          });
      match = {
        config,
        engine,
        collectors,
        driver,
        longTasks: collectors ? createLongTaskRecorder(config.caps.long_tasks) : null,
        heap: { start: null, end: null },
        stream: [],
        status: "configured",
        framesSinceReset: 0,
        startQueued: false,
        configuredAtMs: performance.now(),
        startedAtMs: null,
        terminalAtMs: null,
        stopReason: null,
        error: null,
        visibilityAtStart: document.visibilityState,
        visibilityEvents: [],
        exportStats: { polls: 0, rows: 0, prep_ms_sum: 0, prep_ms_max: 0 },
        final: null,
      };
    },
    actionsForTick(engine, tick) {
      const actions = match.driver.actionsForTick(engine, tick);
      for (const action of actions) {
        match.stream.push(action);
      }
      return actions;
    },
    afterFrame() {
      if (!match) {
        return;
      }
      match.framesSinceReset += 1;
      if (match.status === "warming") {
        if (match.framesSinceReset >= match.config.warm_frames && !match.startQueued) {
          // Start the way the live Start button does: in its own task between
          // frames, zeroing lag so the next frame adds one ordinary interval.
          match.startQueued = true;
          setTimeout(() => beginPlaying(), 0);
        }
        return;
      }
      if (match.status !== "running") {
        return;
      }
      if (appState.mode === "game_over") {
        match.terminalAtMs = performance.now();
        endMatch("complete", null);
      } else if (match.collectors?.overflowed()) {
        stopMatch("sample_cap");
      } else if (appState.engine.state.tick >= match.config.max_ticks) {
        stopMatch("max_ticks");
      }
    },
    rafActive() {
      return rafLoop;
    },
  };

  function beginPlaying() {
    if (match.status !== "warming" && match.status !== "configured") {
      return;
    }
    appState.mode = "playing";
    appState.paused = false;
    appState.lagMs = 0;
    appState.statusMessage = "Runtime-cost diagnostic match running.";
    hooks.frameObserver = match.collectors;
    hooks.tickObserver = match.collectors ? match.collectors.tickParts : null;
    if (match.collectors) {
      match.heap.start = heapSnapshot();
      match.longTasks.start();
    }
    match.startedAtMs = performance.now();
    match.status = "running";
  }

  function endMatch(status, reason) {
    rafLoop = false;
    hooks.frameObserver = null;
    hooks.tickObserver = null;
    if (match.collectors) {
      match.heap.end = heapSnapshot();
      match.longTaskRecord = match.longTasks.stop();
    }
    match.status = status === "complete" ? "finalizing" : "stopping";
    match.stopReason = reason;
    const current = match;
    setTimeout(() => {
      finalize(current, status).catch((error) => {
        current.error = String(error?.stack ?? error);
        current.status = "error";
      });
    }, 0);
  }

  // Pausing keeps an already-requested rAF callback from stepping after the
  // stop; it then renders once and does not re-arm.
  function stopMatch(reason) {
    if (["finalizing", "stopping", "complete", "stopped", "error"].includes(match.status)) {
      return;
    }
    appState.paused = true;
    endMatch("stopped", reason);
  }

  async function finalize(current, status) {
    const started = performance.now();
    const { engine, driver } = current;
    const result = engine.getMatchResult();
    const record = {
      schema_version: EDGER_V2_RUNTIME_COST_BROWSER_SCHEMA,
      id: current.config.id,
      kind: current.config.kind ?? "v2",
      clock: current.config.clock,
      frame_pacing_claim: current.config.clock === "raf",
      collectors: Boolean(current.collectors),
      seed: current.config.seed,
      model: current.config.model,
      controller: current.config.controller,
      candidate_actor: current.config.candidate_actor,
      status,
      stop_reason: current.stopReason,
      result: result ? { winner: result.winner, reason: result.reason, tick: result.tick } : null,
      terminal_tick: engine.state.tick,
      overtime_start_tick: engine.state.overtime_start_tick ?? null,
      counts: { ...driver.counts },
      decision_kinds: { ...driver.decisionKinds },
      opponent_decisions: driver.opponentDecisionTicks.length,
      schedule: driver.schedule,
      schedule_sha256: await sha256Text(JSON.stringify(driver.schedule)),
      stream_actions: current.stream.length,
      action_stream_hash: await sha256Text(JSON.stringify(current.stream)),
      final_state_hash: engine.getStateHash(),
      match_wall_ms: current.startedAtMs === null || current.terminalAtMs === null
        ? null
        : current.terminalAtMs - current.startedAtMs,
      // Reset through the first playing frame: the warm frames on rAF, ~0 on
      // the synthetic clock. Counted in the match deadline, not in match_wall_ms.
      warmup_ms: current.startedAtMs === null ? null : current.startedAtMs - current.configuredAtMs,
      frames_since_reset: current.framesSinceReset,
      collector_lengths: current.collectors?.lengths() ?? null,
      collector_refused: current.collectors?.refused() ?? null,
      long_tasks: current.longTaskRecord ?? null,
      heap: current.collectors ? current.heap : null,
      visibility_at_start: current.visibilityAtStart,
      visibility_events: current.visibilityEvents,
      export: current.exportStats,
      error: current.error,
    };
    record.finalize_ms = performance.now() - started;
    current.final = record;
    current.status = status;
  }

  async function runSynthetic(current) {
    beginPlaying();
    appState.lastFrameTime = 0;
    let now = 0;
    let frames = 0;
    const maxFrames = current.config.caps.frames;
    try {
      for (const step of current.config.synthetic) {
        let count = 0;
        while (current.status === "running") {
          if (step.frames !== undefined && count >= step.frames) {
            break;
          }
          if (step.until_tick !== undefined && appState.engine.state.tick >= step.until_tick) {
            break;
          }
          if (frames >= maxFrames) {
            stopMatch("synthetic_frame_cap");
            break;
          }
          now += step.elapsed_ms;
          frame(now);
          count += 1;
          frames += 1;
          await yieldTask();
        }
        if (current.status !== "running") {
          break;
        }
      }
      if (current.status === "running") {
        stopMatch("synthetic_plan_exhausted");
      }
    } catch (error) {
      current.error = String(error?.stack ?? error);
      if (current.status === "running") {
        stopMatch("page_exception");
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    const event = { at_ms: performance.now(), state: document.visibilityState };
    visibilityEvents.push(event);
    if (match && ["warming", "running"].includes(match.status)) {
      match.visibilityEvents.push(event);
      // A hidden page receives no rAF callbacks, so stop here rather than in a frame.
      if (match.config.clock === "raf" && document.visibilityState !== "visible") {
        stopMatch("page_hidden");
      }
    }
  });

  async function loadModels(specs) {
    const loaded = {};
    for (const spec of specs) {
      const text = await fetchVerified(spec.url, spec.sha256);
      models.set(spec.run, validateEdgerV2PolicyModel(JSON.parse(text)));
      loaded[spec.run] = spec.sha256;
    }
    return loaded;
  }

  // Replay-rebuild every bank state and compare the adapter (hook off and on),
  // its phase sequence and, for the learned controller, the production selector
  // against the Node reference decisions.
  async function bankCheck({ bankUrl, bankSha256, expectationsUrl, expectationsSha256 }) {
    const started = performance.now();
    const bank = JSON.parse(await fetchVerified(bankUrl, bankSha256));
    const expectations = JSON.parse(await fetchVerified(expectationsUrl, expectationsSha256));
    const expected = new Map(expectations.bank_decisions.map((entry) =>
      [`${entry.state}|${entry.actor}|${entry.model}|${entry.controller}`, entry.decision]));
    const sources = new Map(bank.sources.map((source) => [source.id, source]));
    const mismatches = [];
    let decisions = 0;
    let statesChecked = 0;
    let productionChecked = 0;
    for (const state of bank.states) {
      const source = sources.get(state.source_id);
      const engine = rebuildEngineAt({ seed: source.seed, actions: source.actions, tick: state.tick });
      if (engine.getStateHash() !== state.state_hash) {
        mismatches.push({ state: state.id, check: "state_hash" });
        continue;
      }
      statesChecked += 1;
      for (const actor of ACTORS) {
        const legalActions = enumerateLegalCardActions({ engine, actor });
        for (const run of models.keys()) {
          const model = models.get(run);
          for (const controller of CONTROLLERS) {
            const where = { state: state.id, actor, model: run, controller };
            const reference = expected.get(`${state.id}|${actor}|${run}|${controller}`);
            const off = decideEdgerV2Diagnostic({ model, engine, actor, legalActions, controller });
            const phases = [];
            const on = decideEdgerV2Diagnostic({
              model, engine, actor, legalActions, controller, phaseHook: (phase) => phases.push(phase),
            });
            if (!reference) {
              mismatches.push({ ...where, check: "missing_expectation" });
            } else if (decisionKey(off) !== JSON.stringify(reference)) {
              mismatches.push({ ...where, check: "adapter_vs_reference" });
            }
            if (decisionKey(on) !== decisionKey(off)) {
              mismatches.push({ ...where, check: "hook_on_vs_off" });
            }
            if (JSON.stringify(phases) !== JSON.stringify(expectedPhases(controller))) {
              mismatches.push({ ...where, check: "phase_sequence" });
            }
            if (controller === EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED) {
              const production = selectEdgerV2PolicyDecision({ model, engine, actor, legalActions });
              productionChecked += 1;
              if (decisionKey(production) !== decisionKey(off)) {
                mismatches.push({ ...where, check: "adapter_vs_production" });
              }
            } else if (off.delayTicks !== 1 || off.indices.delay_index !== 0) {
              mismatches.push({ ...where, check: "fixed_delay" });
            }
            decisions += 1;
          }
        }
        if (engine.getStateHash() !== state.state_hash) {
          mismatches.push({ state: state.id, actor, check: "engine_mutated" });
        }
      }
      await yieldTask();
    }
    return {
      states: bank.states.length,
      states_checked: statesChecked,
      decisions,
      expected_decisions: expectations.bank_decisions.length,
      production_checked: productionChecked,
      mismatch_count: mismatches.length,
      mismatches: mismatches.slice(0, MISMATCH_CAP),
      wall_ms: performance.now() - started,
    };
  }

  function startMatch(config) {
    if (match && !["complete", "stopped", "error"].includes(match.status)) {
      throw new Error(`match ${match.config.id} is still ${match.status}`);
    }
    if (config.kind === EDGER_V1_BASELINE_KIND ? config.model !== "v1" : !models.has(config.model)) {
      throw new Error(`model ${config.model} is not loaded`);
    }
    if (config.clock !== "raf" && config.clock !== "synthetic") {
      throw new Error(`unknown clock ${config.clock}`);
    }
    if (config.clock === "raf" && document.visibilityState !== "visible") {
      throw new Error("real-time matches require a visible page");
    }
    pending = { ...config };
    resetGame();
    if (pending !== null || match?.config.id !== config.id || match.status !== "configured") {
      throw new Error("resetGame did not create the diagnostic match");
    }
    if (config.clock === "raf") {
      match.status = "warming";
      rafLoop = true;
      requestAnimationFrame(frame);
    } else {
      runSynthetic(match);
    }
    return { id: config.id, seed: appState.engine.state.seed };
  }

  function poll(maxRows) {
    const started = performance.now();
    const snapshot = {
      status: match?.status ?? "idle",
      id: match?.config.id ?? null,
      tick: appState.engine?.state.tick ?? null,
      mode: appState.mode,
      visibility: document.visibilityState,
      device_pixel_ratio: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      frames_since_reset: match?.framesSinceReset ?? 0,
      chunks: null,
    };
    if (match?.collectors) {
      snapshot.chunks = match.collectors.drain(maxRows);
      const rows = Object.values(snapshot.chunks).reduce((sum, chunk) => sum + chunk.rows.length, 0);
      const prep = performance.now() - started;
      match.exportStats.polls += 1;
      match.exportStats.rows += rows;
      match.exportStats.prep_ms_sum += prep;
      match.exportStats.prep_ms_max = Math.max(match.exportStats.prep_ms_max, prep);
      snapshot.pending_rows = match.collectors.pending();
    }
    return snapshot;
  }

  window.__edgerRuntimeCost = {
    schema_version: EDGER_V2_RUNTIME_COST_BROWSER_SCHEMA,
    samples_schema: RUNTIME_COST_SAMPLES_SCHEMA,
    boundaries: RUNTIME_COST_BOUNDARIES,
    info: () => ({
      cross_origin_isolated: window.crossOriginIsolated === true,
      timer_resolution_ms: timerResolutionMs(),
      user_agent: navigator.userAgent,
      device_pixel_ratio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      visibility: document.visibilityState,
      hardware_concurrency: navigator.hardwareConcurrency ?? null,
      visibility_events: visibilityEvents.slice(0, 100),
    }),
    loadModels,
    bankCheck,
    startMatch,
    poll,
    stop(reason) {
      if (match) {
        stopMatch(reason);
      }
      return match?.status ?? "idle";
    },
    result: () => match?.final ?? null,
    renderIdle: () => render(),
  };
  return hooks;
}
