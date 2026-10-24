# Edger runtime-cost review and plan — October 1, 2026

The September 29 confirmation supports reviewing every-tick inference for the
three saved learned-trained checkpoints. The next task is to measure its cost
with unchanged weights and controllers. Live v1 stays in place; parity,
tactical, provenance and promotion requirements remain blocking.

## Confirmation review

Read alongside the [confirmation record](EDGER_REPLICATION_REVIEW.md#confirmation-run--september-29-03450646-utc-13451646-aest).
The October 1 review independently checked the durable evidence outside iCloud:

- `SHA256SUMS`: all 153 entries verified. Its full hash is
  `099346cb75eab5c0f3d4f50466fe985a519492360fa7f6f25e4115bed81b4b9a`.
- Frozen plan: SHA-256
  `9e6b6da2985b65d5e175da03cb7833f2303d87ef1ce987b876a058e3ec3b0d50`.
- Saved reports: 24 complete conditions, 9,600 matrix games, both sides for
  every reserved seed, and zero illegal attempts. All 240 cross-process games
  match their original action-stream and final-state hashes. Both sets of
  reports record two in-process repeat specs per condition: 96 extra games,
  giving 336 repeat games overall.
- Run log: one completed session, 48 successful single-attempt steps, empty
  process groups, no stops, acknowledgements or missing conditions. Step time
  sums to 10,664.390 seconds.
- Independent subtraction of saved condition scores reproduces C1 means:
  v1 `0.1583333333333333`, aggressive `0.0616666666666667`, heuristic `0.0975`.
  The saved intervals and four frozen rule checks support the stated verdict.
  The frozen analysis was read, not rerun or overwritten.
- The current live v1 JSON still hashes to
  `895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa`.
  The staged Node still hashes to
  `38de4fc456c0c439bac48c727d378f749abb4e31f4116703bb1ee9a746fccbb6`.
- Current repository comparison: 29 closure files, four model pins, six frozen
  scripts and five principal plan/report files match the frozen evidence:
  44 checks, zero mismatches.

No blocking defect was found in this confirmation evidence. This review does
not certify the entire accumulated code diff or independently establish the
operator's no-peeking history. The intervals remain conditional on three fixed
checkpoints, rather than future training runs. Aggressive r1 remains uncertain,
and trained-over-parent at learned cadence remains inconsistent against
aggressive. The confirmation holdout is spent and the frozen plan is immutable.

Verification command, from the durable evidence directory:

```bash
cd ~/edge_royale-runs/20260929T0346Z-cadence-confirmation-evidence
shasum -a 256 -c SHA256SUMS
```

## Measurement boundaries found in code

| Path | Boundary and qualification |
| --- | --- |
| Confirmation `runEdgerV2CadenceMatch` | Enumerates legal actions before the timer. `decideEdgerV2WithCadence` builds observation and card/selected-placement masks; learned cadence also evaluates delay. Means under six-worker contention cannot establish single-call p95. |
| Existing promotion `evaluateTiming` | Five static scenario fixtures, legal actions pre-enumerated, 10 warmup calls and 100 timed calls in v2 preflight, using the production selector. Preserve this method and the p95 ≤5 ms threshold. |
| Production `selectEdgerV2PolicyDecision` | Makes ten mask builds: one initial build, then one for each of nine card branches. Each scans legal actions for the card mask; only the eight non-PASS branches also scan for placement, giving 18 full-list passes. The cadence diagnostic makes two builds: two full-list passes for PASS or three for a play. Identical actions alone do not establish identical cost. |
| Browser `buildBotActions` / `stepGameTick` / `frame` | Enumeration, selection, scheduling and action construction run synchronously before the engine step. The rAF loop drains accumulated time in 50 ms ticks without a lag clamp or a per-frame tick limit. Slow decisions can cause bursts of catch-up ticks before rendering. Measure decision work, tick work, render work and frame intervals separately. |

The cadence module imports `node:crypto` and cannot be imported directly into
the browser. A browser adapter therefore needs explicit equivalence checks.
Measure the production learned selector separately even if the adapter is
action-equivalent. Do not introduce a forced-PASS shortcut, mask optimization,
precision change or new controller in the first measurement pass.

Slow work in one callback contributes to the next callback's elapsed time.
Catch-up ticks can therefore amplify later frame work even when individual
decision durations appear small. A briefly hidden tab can produce the same
backlog on return; hidden-page conditions remain incomplete. Do not clamp lag,
drop ticks or cap ticks/frame to improve the diagnostic result.

## 1. Build and validate a diagnostic profiling harness

Keep profiling isolated from the shipped entry point. Use a staged copy outside
iCloud that reuses the production engine, policy math, client renderer and tick
loop, replacing only the bot/input adapters for the experiment. No model or
controller selector belongs in the player UI. Keep measurements outside engine
state and exclude them from replay hashes.

Pin the source closure, including untracked files, adapter, harness, models,
state bank, inputs, analysis, package/lock files and tool versions by SHA-256.
Record HEAD plus the tracked diff hash; HEAD alone cannot identify this dirty
tree. Read the original confirmation bundle without changing it. The three
model hashes are:

| Run | Model SHA-256 |
| --- | --- |
| r0 | `dfc76358ad46b3f8be411dd6ac876927f2fcb571c835ce9a14d4c97d05956d1b` |
| r1 | `07accf4073e142d951f3a6f2545854f945695978fc52d7dbc31afd38302432e9` |
| r2 | `2852f7c41974a472591b49871c962b3fb4978a1ef7903ffd1c7d2479082248fb` |

Use only already-open development seeds. Start the browser matrix with the
first base-plan development seed, `1836353410`; use additional base-plan
development states for coverage. Verify disjointness from the confirmation
array. This is a cost study, not a new quality confirmation or model ranking.

Before timing:

- Check every model under both controllers and both actors on the same saved
  states. Require exact action, card/placement indices and scheduling agreement
  with the frozen cadence implementation. The learned adapter must also match
  `selectEdgerV2PolicyDecision`. Fixed cadence must keep PASS and skip delay.
- Replay deterministic development matches in Node and the staged browser;
  require identical action-stream and final-state hashes. Instrumentation on
  and off must produce the same stream. Compare independent page/process runs.
- Cover affordable PASS, forced PASS, spell targeting, busy combat, pockets and
  overtime. Preserve stable legal argmax and ties. These adapter checks do not
  resolve the existing PyTorch/JS parity failure.
- Add meaningful tests for adapter equivalence, timing boundaries, controller
  scheduling and bounded report output. Run `npm test`, the targeted cadence
  suite (`node --test tests/edger-v2-cadence.test.js`) and
  `npm run smoke:browser`. Include the unchanged live entry point in the smoke;
  diagnostic-page validation is an additional check.

### Immediate implementation slice

Build and validate the harness before starting the measurement matrix:

1. Add a browser-safe diagnostic adapter using the existing exported observation,
   mask, policy-head and decode functions. Keep the frozen cadence module as the
   Node reference; leave its implementation and production selectors unchanged.
   Preserve both mask builds, placement work on PASS, stable ties and the
   fixed controller's omission of the delay head.
2. Generate a reproducible development state bank with the coverage above. Run
   r0/r1/r2 × both controllers × both actors against the frozen reference, and
   compare the learned path with the production selector. Match full-match
   initialization, RNG salts, candidate/opponent action order, next-decision
   ticks, overtime and terminal handling before comparing stream/state hashes.
3. Stage a diagnostic entry point that reuses the client renderer and tick/frame
   loop. Record every staged substitution and its source/output hashes; fail
   on an unexpected source shape. Add timing collectors outside engine state,
   bounded output and an external supervisor for resource stops. Fast-forward
   may validate deterministic behavior, but cannot supply frame-pacing results.
4. Deliver equivalence results, instrumentation-on/off checks, meaningful unit
   tests, unchanged-live and diagnostic browser smoke, and a dry-run report
   showing timing boundaries and stop reasons. Only then freeze the measurement
   bundle, condition order, report schema and limits for step 2.

The entire pre-existing accumulated diff still needs the separate publication
review already recorded in `progress.md`.

### Slice status — October 2, 2026

The Node half of items 1–2 is complete; items 3–4 remain open. Node success
does not validate the browser harness.

- **Adapter.** `scripts/edger-v2-runtime-cost-adapter.js` is a plain `.js`
  module, because the dev server serves `.mjs` as `octet-stream`. It imports
  only `src/ai` and `src/sim`, and nothing in `src/client` loads it. It
  provides:
  - `decideEdgerV2Diagnostic`, the deterministic decision;
  - `createEdgerV2DiagnosticDriver`, which runs candidate then opponent, uses
    opponent salt `0x5f3759df` and selects before rolling the delay, exactly as
    the reference does;
  - `createEdgerV2PhaseAccumulator`, which is bounded.

  Its phase boundaries are: enumeration, observation, encoding, card mask,
  card head, selected masks, placement head, delay head (learned only), decode,
  and scheduling/action construction. The frozen cadence core and the
  production selectors are unchanged.
- **Browser differences the stage must handle.** The live client builds
  `[blue player, red bot]`. Its `selectBotDecision` rolls the delay before
  selecting, while the reference selects first. Engine state is unaffected
  because `step` sorts actions, and v1 consumes no selection RNG. The stream
  hash, however, uses the reference order. The staged page must therefore take
  both sides' actions from the driver.
- **Bank.** The state rules are `edger_v2_runtime_cost_state_rules_v1`, read
  from the board, legal actions and overtime only:
  - forced PASS;
  - elective;
  - spell target (a legal spell and at least 2 living enemy troops);
  - busy combat (at least 6 troops, at least 2 per side);
  - pocket (a legal troop play inside an unlocked pocket);
  - overtime.

  Every 10th pre-step state is a candidate. Candidates come from reference
  matches against live v1 for r0/r1/r2 × both controllers × both actors, on
  the first two base-plan development seeds. Five states per category per actor
  are chosen in SHA-256 order. Construction fails on missing coverage and
  stores no outcomes.

  Result: 59 states from 9,185 candidates (21 of 24 sources), with all twelve
  slots filled on the first build. Bank SHA-256:
  `792c23d026ae8deffcb6714298f88eb350595d764597c5be9bf86f2f44c5f6df`.
- **State equivalence.** Every state was rebuilt by replay and its hash
  checked. The check covered 708 decisions (59 states × 2 actors × 3 models × 2
  controllers):
  - the adapter equals the frozen reference;
  - hook-on output equals hook-off output;
  - the phase sequence is as expected;
  - the learned path equals `selectEdgerV2PolicyDecision`;
  - the fixed controller uses delay 1 / index 0.

  There were zero mismatches and the engine was not mutated. The real
  checkpoints made 14–19 elective PASS decisions each and one tied placement
  each.
- **Full matches** on `1836353410` covered 12 conditions. For each, the
  candidate's per-decision schedule (tick, card, placement, delay index and
  ticks), the counts, the action-stream and final-state hashes, and the result
  all equal the reference with the hook off and on. The hook counted every
  decision. Decisions per match ranged from 50 to 5,817, five matches reached
  overtime, and there were zero illegal attempts. Run durations are validation
  wall time, not cost measurements.
- **Unit tests.** `tests/edger-v2-runtime-cost.test.js` uses in-test models: a
  PASS-preferring bootstrap actor for guaranteed affordable PASS, a poisoned
  delay head, zero-weight ties, rule fixtures, bounded accumulation,
  full-match/negative controls and bank determinism and coverage failure.
- **Evidence** is outside iCloud in
  `~/edge_royale-runs/20261001T1641Z-runtime-cost-node-validation/`. It holds
  the staged closure, `out/` and `SHA256SUMS` (`a0423cfa…`; 40 files verified).
  Provenance:
  - Node v20.20.2, `38de4fc4…`;
  - HEAD `0270d828…`, tracked diff `19bef727…`;
  - closure `c18e36c8…`.

Commands, run from the staged copy with the pinned Node, where `PINS` is
`~/edge_royale-runs/20260929T0346Z-cadence-confirmation-evidence/artifacts/edger-training/experiments/20260928-cadence-confirmation/pins/`:

```bash
node scripts/edger-v2-runtime-cost.mjs bank --model-dir "$PINS" \
  --base-plan "$PINS/base-seed-plan.json" --replication-plan "$PINS/replication-seed-plan.json" \
  --seeds 2 --stride 10 --per-category 5 --git-root <repo> --out "$RUN/out/state-bank.json"
node scripts/edger-v2-runtime-cost.mjs verify --model-dir "$PINS" \
  --base-plan "$PINS/base-seed-plan.json" --replication-plan "$PINS/replication-seed-plan.json" \
  --bank "$RUN/out/state-bank.json" \
  --bank-sha256 792c23d026ae8deffcb6714298f88eb350595d764597c5be9bf86f2f44c5f6df \
  --match-seeds 1836353410 --git-root <repo> --out "$RUN/out/node-equivalence.json"
```

Still pending, before freezing (all done October 3; see the
[browser slice status](#browser-slice-status--october-3-2026)):

- the staged browser entry point, with recorded substitutions and source-shape
  guards;
- frame/tick collectors (pre-drain/residual lag, ticks per frame, callback
  durations) and the external supervisor;
- Node/browser stream/state equivalence, in fast-forward and real time, across
  independent pages;
- unchanged-live and diagnostic smoke;
- the dry-run report.

### Browser slice implementation contract — October 3, 2026

The Node-slice review found no blocking adapter or match-driver defect. All 40
evidence checksums passed, all 36 files in the report's source closure matched
the current repository, and all three model/two seed-plan files matched the
bank's recorded hashes. The pinned Node v20.20.2 reran the cadence and
runtime-cost suites: 24/24 passed. The saved report records **five** overtime
conditions (r1 learned blue, r1 fixed blue, r2 learned blue/red, r2 fixed red);
the earlier prose count of four was incorrect. Real-checkpoint `bank`/`verify`
was inspected, not rerun. The accumulated learner/evaluator diff remains a
separate review.

Implement this slice in the following order. It delivers the validated browser
harness; the 28-match profiling matrix follows only after its freeze.

1. **Guarded stage.** Add a Node staging command and browser `.js` module.
   Preserve an untouched live `index.html` and `src/client/webGame.js` in a new
   stage outside iCloud; generate a diagnostic HTML/module beside them only in
   that stage. Reuse the production canvas, layout, renderer, visual sync and
   uncapped 20 Hz frame loop. Guard every replacement with an expected source
   hash and exactly one matching source block; reject an unexpected shape.
   Record each substitution, source/output hashes and the complete manifest,
   including HTML, lockfile, browser/Playwright versions, tests, configuration,
   Node reference expectations, bank and unchanged model/seed-plan bytes.
   Fail before launch on missing or changed pins. Do not rewrite the frozen
   cadence implementation or production selectors.

   Replace the profile-derived seed with the configured development seed,
   create a fresh driver for every match, and replace the entire player/bot
   action assembly with `driver.actionsForTick(engine, nextTick)`. Keep engine
   stepping, visual sync, overtime and terminal behavior in their existing
   order. Use a fresh browser context and an empty local profile; disable
   diagnostic user input/reset, profile writes and the forced-finish smoke
   hook. Keep normal live smoke available through the untouched entry point.
   Initialize before starting rAF, and permit exactly one source of ticks:
   validation fast-forward with rAF advancement disabled, or real-time rAF.
   Fast-forward results must explicitly have no frame-pacing claim.

2. **Collectors and serialization.** Keep observers outside engine state.
   The current phase accumulator is bounded but retains only count/sum/max:
   add capped raw samples for decision and frame distributions rather than
   trying to derive percentiles from those summaries. Record candidate and v1
   opponent costs separately with optional observer boundaries in the driver;
   preserve select-then-roll order. Record forced PASS, elective PASS and play
   using the already-enumerated legal list, without adding enumeration to the
   decision. Label schedule timing as including the driver's legality check
   and diagnostic schedule/count bookkeeping. Retain a hook-off run to expose
   observer overhead; equal hashes certify behavior, not equal timings.

   For each frame retain its rAF timestamp/interval, pre-drain lag, residual
   lag, loop iterations, actual `state.tick` advances, whole tick duration,
   engine-step duration, visual-sync duration, render duration and callback
   duration. Treat nested timings as overlapping measurements, not additive
   totals. Preserve lag subtraction even after terminal no-op iterations.
   Keep frame order so slow callbacks can be linked to subsequent catch-up
   bursts. Declare sample/byte caps before launch and stop with a partial
   report on overflow; do not silently overwrite samples or drop frames.

   Capture the driver's raw action list **before** `engine.step` sorts it.
   Match the reference SHA-256 of `JSON.stringify(actions)` and the schedule
   field order exactly; do not hash `engine.state.replay.actions` instead.
   Use `engine.getStateHash()` for the final state. Compute JSON/digests and
   percentile summaries after the measured match, outside its frame callback.
   Persist result, counts, terminal tick and overtime-start tick alongside the
   hashes. Export bounded partial chunks during the run, with export overhead
   identified, so a killed page does not erase all observed data.

3. **Independent supervisor.** Give the browser worker its own owned process
   group and bounded browser-control calls. A separate parent must enforce
   elapsed time, free disk, output bytes and worker liveness while the page's
   main thread is blocked. Write atomic progress/stop records outside the page.
   Stop admission on failure, retain partial output, send TERM to the owned
   group, escalate to KILL after a bounded grace period, reap it and verify that
   the server/browser descendants are gone. The installed Playwright launcher
   uses `detached: true` on macOS: track Chromium's separate owned process group
   as well as the worker/server, and test that cleanup case too. Do not target
   unrelated processes.
   On macOS, handle group creation explicitly; reuse the documented fork-before-
   `setsid` approach if needed. The current `browser-smoke.mjs` kills only its
   worker with TERM and buffers all output; it is not this supervisor.

   Apply the plan's proposed reserves/caps to the dry run: one active match,
   6,040 ticks, 360 wall seconds per real-time condition, 3 GiB free on admission,
   2 GiB running reserve, and 1 GiB aggregate output ceiling. Give browser
   validation a separate 90-minute cap, no automatic retries, and the coverage
   below; retain incomplete conditions if it stops. The three-hour profiling
   budget starts only after validation and freeze.
   Test timeout, main-thread stall, worker crash, low disk, output overflow,
   TERM resistance and supervisor interruption using disposable owned workers.
   CPU accounting must identify whether it covers the worker, Chromium tree
   or both; parent Node CPU alone is not browser CPU/game.

4. **Equivalence and smoke.** Emit checksummed Node reference decisions and
   match expectations for the existing bank/seed, without new seed selection.
   Replay-rebuild all 59 browser bank states and check their hashes; require
   all 708 decisions to match the frozen reference, with learned decisions
   also matching the production selector. Run all 12 full-match conditions in
   fast-forward with collectors off/on, repeated in two fresh contexts at
   portrait `390×844` and desktop `1280×800`. Compare schedules, counts, raw
   action-stream/final-state hashes, result and overtime-start tick.

   Predeclare real-time validation separately: r1 learned blue in portrait
   and r2 fixed red in desktop, both overtime cases from the existing
   development report. Run each with collectors off/on in two independent
   pages (eight full matches), with visibility required throughout. Report
   that coverage explicitly; the later profiling conditions must each also
   match their Node expectations. Run the unchanged live smoke and diagnostic
   smoke, check page errors and capture both viewport screenshots. A
   deterministic controlled elapsed jump must exercise a multi-tick frame,
   following-frame catch-up and a terminal frame whose loop iterations exceed
   actual tick advances. Keep the jump outside primary measurements.

5. **Exit gate.** Run `npm test`,
   `node --test tests/edger-v2-cadence.test.js`, the new collector/staging/
   supervisor tests and `npm run smoke:browser`, plus the explicit diagnostic
   browser validation command added by this slice. Deliver a dry-run report
   with boundaries, coverage, exact commands, checksums, environment, limits
   and incomplete/stop reasons. Freeze the measurement configuration, order,
   schema and source closure only after all required checks pass. Production
   selector timing, live-v1 baselines and detailed GC traces retain their
   separate paths; no model/controller choice follows from this validation.

Review validation commands:

```bash
cd ~/edge_royale-runs/20261001T1641Z-runtime-cost-node-validation
shasum -a 256 -c SHA256SUMS
cd ~/Developer/edge_royale
/private/tmp/edger-confirmation-review-y_4hw1gg/node --test \
  tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js
git diff --check
df -k ~/edge_royale-runs
```

No browser harness, profiling, cloud, training, Git staging or commit was
performed by this review. Full `npm test` and browser smoke were not rerun;
this pass changes documentation only and adds targeted review validation.

### Browser slice status — October 3, 2026

The browser slice of the contract above is implemented and validated. The
rendered profiling matrix is frozen. No profiling, cloud, training, Git staging
or commit was performed. Evidence lives outside iCloud in
`~/edge_royale-runs/20261003T0213Z-runtime-cost-browser-validation/`. Its
`SHA256SUMS` (`c2ba1687…`) verifies 2,259 files; the stage has its own
`SHA256SUMS`.

**Results (October 3, 03:02–03:47Z).** The full supervised validation used
the pinned Node v20.20.2 and Chrome Headless Shell 145.0.7632.6. It passed with
nothing not run and no failures.

- Stage closure `98ed6c0e…`, manifest `a3362252…`, config `299a4b21…`,
  from HEAD `0270d828…` with tracked diff `17c31b27…`.
- Node expectations `74c6ce33…`. All 12 conditions equal the October 2 saved
  report's hashes, schedules, counts, results and overtime starts, and the same
  five conditions reach overtime.
- Smoke in both viewports passed every check:
  - the untouched live entry starts and plays;
  - the diagnostic page has no smoke hooks, ignores input and writes no
    profile;
  - preview runs advance only from the synthetic clock;
  - pages are cross-origin isolated, with no page errors.

  Six screenshots were captured.
- Bank replay ran in four fresh contexts. Each rebuilt all 59 states with
  matching hashes and compared 708 decisions with the frozen reference, plus
  354 learned decisions with the production selector: zero mismatches.
- Fast-forward: 96/96 matches. That is 12 conditions with collectors off/on,
  in two fresh contexts per viewport (`390×844`, `1280×800`). Each matched its
  schedule, schedule hash, counts, decision kinds, opponent decisions, raw
  stream and final-state hashes, result and overtime start; 40 reached
  overtime. With collectors on, the run also matched row coverage and the
  delay-head boundary (present only when learned).
- Controlled elapsed jump (synthetic clock; r1 learned blue, overtime at 3600,
  terminal 6000), with hashes matching off and on:

  | Frame | Pre-drain lag | Iterations | Advances | Residual |
  | --- | --- | --- | --- | --- |
  | 16 ms | 16 | 0 | 0 | 16 |
  | 400 ms, multi-tick | 416 | 8 | 8 | 16 |
  | Following 130 ms catch-up | 146 | 2 | 2 | 46 |
  | Terminal 500 ms | 546 | 10 | 3 | 46 |

  Advances summed to 6000, and the terminal frame was last.
- Real-time rAF: 8/8, each in a fresh context and visible throughout. r1
  learned blue portrait ran 6,000 ticks in 300.0 s; r2 fixed red desktop ran
  5,817 ticks in 290.9 s. Every check matched Node, both with collectors off
  and on.
- Supervisor: `worker_complete` after 2,700.8 s of the 5,400 s cap.
  - Admission had 3.49 GiB free (3 GiB required); the minimum was 3.44 GiB and
    output reached 57.1 MiB.
  - Ownership covered the worker group and Chromium's separate group (24
    members observed).
  - Cleanup was verified with no TERM or KILL needed, and Chromium exited.
- Gates on the final code:
  - `npm test`: 187/187.
  - Pinned-Node targeted suites (runtime-cost, cadence and the new browser
    file): 40/40.
  - Unchanged `npm run smoke:browser` from the stage: passed.
- Negative preflight: a stage copy with one changed engine byte was refused
  before launch, naming `src/sim/engine.js`.
- Timer check: the unchanged dev server (no isolation) gives a 100 µs step;
  the stage server gives 5 µs.
- Freeze `out/profiling-freeze.json` (`bed6ff1e…`) fixes:
  - the 24 rendered conditions: r0/r1/r2 × learned/every-tick × both sides ×
    both viewports, on seed `1836353410`, in recorded order;
  - schemas, caps, the 6,040-tick and 360 s match limits, and 30 warm frames;
  - the 3 h / 1 GiB / 3 GiB / 2 GiB limits and no retries;
  - the stage closure.

  It explicitly leaves four items unfrozen: live-v1 baselines, existing-method
  timing, complete-path bank timing and GC traces.

Host conditions during the run make its timings validation-only. Load rose from
2.1 to about 8 as Spotlight (`mds`, `mds_stores`, `mdworker_shared`) indexed
the new run files, and swap was 7.2–7.7 GiB of 8 GiB.

Commands (`N` is the pinned Node; `RUN` is the run directory; `PINS` and
`NODE_OUT` are the confirmation pins and the October 2 Node `out/`):

```bash
$N scripts/edger-v2-runtime-cost.mjs expect --model-dir "$PINS" \
  --base-plan "$PINS/base-seed-plan.json" --replication-plan "$PINS/replication-seed-plan.json" \
  --bank "$NODE_OUT/state-bank.json" --bank-sha256 792c23d026ae8deffcb6714298f88eb350595d764597c5be9bf86f2f44c5f6df \
  --match-seeds 1836353410 --git-root <repo> --out "$RUN/out/node-expectations.json"
$N scripts/edger-v2-runtime-cost-stage.mjs stage --out "$RUN/stage" --model-dir "$PINS" \
  --base-plan "$PINS/base-seed-plan.json" --replication-plan "$PINS/replication-seed-plan.json" \
  --bank "$NODE_OUT/state-bank.json" --bank-sha256 792c23d0… \
  --expectations "$RUN/out/node-expectations.json" --expectations-sha256 74c6ce33… \
  --playwright-modules ~/edge_royale-runs/toolchains/playwright-1.58.2/node_modules --git-root <repo>
(cd "$RUN/stage" && npm run smoke:browser)
(cd "$RUN/stage" && caffeinate -s -i $N scripts/edger-v2-runtime-cost-supervisor.mjs \
  --out "$RUN/validation" --wall-cap-s 5400 --admission-free-gib 3 --reserve-free-gib 2 \
  --output-cap-gib 1 --heartbeat-timeout-s 120 --grace-ms 5000 --poll-ms 1000 \
  -- $N scripts/edger-v2-runtime-cost-browser-worker.mjs)
$N scripts/edger-v2-runtime-cost-stage.mjs freeze --stage "$RUN/stage" \
  --validation "$RUN/validation/worker/report.json" --supervisor "$RUN/validation/supervisor/final.json" \
  --gates "$RUN/out/gates.json" --out "$RUN/out/profiling-freeze.json"
```

`EDGER_RUNTIME_COST_ONLY=<phase|item,...>` runs a filtered debugging plan. Its
report is `partial` and can never pass or be frozen; the run directory's
`debug1/` and `debug2-rt/` came from it. `out/restage.sh` and
`out/validate.sh` are the wrappers used.

**Before the profiling run** (Next Tasks in `progress.md`):

- Use a pinned headed Chromium build for the rendered study and validate it.
- Keep and define the four live-v1 baselines.
- ~~Repair the freeze admission checks and the external per-match deadline.~~
  Done October 3 ([repairs](#freeze-and-deadline-repairs--october-3-2026)).
- Implement and validate the existing-method timing, complete-path bank timing
  and bounded GC-trace paths, then extend the freeze.
- Stage and write outputs under a `.noindex` directory outside iCloud; verify
  exclusion before admission and use Spotlight Privacy if needed. (October 3:
  one sentinel check passed; repeat it for the measurement run directory.)
- Recheck the 3 GiB admission reserve.

These choices are settled by the review below. The saved headless freeze remains
immutable; a successor measurement freeze is required.

**Components.** All are new except the adapter/core/CLI edits. None is
imported by `index.html`, `src/client` or any production path.

- `scripts/edger-v2-runtime-cost-adapter.js`: the driver now takes an optional
  `opponentHook` (boundaries `begin`, `enumerate`, `select`, `delay`,
  `construct`; select-then-roll order unchanged). It keeps
  `decisionKinds` (`play`, `elective_pass`, `forced_pass`, `illegal`) beside
  the unchanged reference-shaped `counts`. These are classified from the
  already-enumerated legal list inside the `schedule` phase, whose timing is
  labelled as including the legality check and bookkeeping.
- `scripts/edger-v2-runtime-cost.mjs expect` (with `buildNodeExpectations` in
  the core): it emits the frozen reference's 708 bank decisions and the 12
  full-match expectations (schedule, counts, kinds, opponent decisions, raw
  stream/state hashes, result and overtime start). Any adapter disagreement
  aborts emission. It reuses the existing bank and seed; it selects no seeds.
- `scripts/edger-v2-runtime-cost-stage.mjs stage` makes a new stage outside
  iCloud. It refuses iCloud paths and existing directories, and checks every
  pin before writing anything: models, bank, expectations, seed plans,
  lockfile-matched Playwright and the headless-shell binary.
  - It copies `index.html`, `src/**`, the served harness scripts, the unchanged
    live smoke scripts, Playwright packages and data.
  - It generates `runtime-cost.html` and `src/client/webGameRuntimeCost.js`
    from 10 guarded substitutions. Each requires the whole source's SHA-256 pin
    and exactly one occurrence of a block with its pinned hash, with no
    overlap. The webGame.js substitutions cover imports, profile writes, the
    seed/fresh driver, both sides' actions, the frame loop, user input, the
    smoke hooks and startup.
  - It writes `config.json`, which predeclares the plan, caps and limits.
    `MANIFEST.json` records HEAD, the tracked diff, the status hash, Node, the
    Playwright/shell hashes, every substitution and all 605 file hashes.
    `SHA256SUMS` covers the stage.
- `scripts/edger-v2-runtime-cost-browser.js` (page side) loads models with
  SHA-256 checks and replays the bank. Matches run with exactly one clock:
  real-time rAF, or a synthetic clock that calls the same frame function with
  scripted timestamps while rAF is disabled. It records driver actions before
  `engine.step` and computes UTF-8 SHA-256 digests in a separate task after
  the terminal frame. Pausing on stop prevents a pending rAF callback from
  stepping.
- `scripts/edger-v2-runtime-cost-collectors.js`: four preallocated
  `Float64Array` tables cover candidate decisions, v1 opponent decisions,
  ticks and frames. Overflow is refused and flagged, never overwritten. Rows
  are drained in bounded chunks with page-side export time recorded;
  nearest-rank summaries are computed in the worker after the match.
- `scripts/edger-v2-runtime-cost-supervisor.mjs` and `-process.mjs`: the
  external supervisor described below.
- `scripts/edger-v2-runtime-cost-browser-worker.mjs` runs the predeclared plan
  from the stage. Every control call is bounded, failure stops admission, and
  partial reports, item records and chunk files are written as it goes.
- Tests: `tests/edger-v2-runtime-cost-browser.test.js` (16) plus the fixture
  `tests/fixtures/runtime-cost-fake-worker.mjs`.

**Generated frame loop.** It keeps the live drain exactly: no lag clamp, no
per-frame tick limit, and lag still subtracted on terminal no-op iterations.
Overtime and terminal order in `stepGameTick` are unchanged. Observers stay
`null` when collectors are off. Recorded per frame:

- rAF timestamp and interval;
- pre-drain and residual lag;
- loop iterations and actual `state.tick` advances;
- whole drain;
- summed tick, driver, engine and visual time;
- render and callback durations.

Per tick it records whole `stepGameTick`, driver, engine-step and visual-sync
time. These nested timings overlap.

**Supervisor.** Node's `detached: true` puts the worker in its own process
group, so no fork-before-`setsid` step is needed. The supervisor enforces the
following from outside the page:

- admission free space, a running reserve and aggregate output bytes;
- total and per-condition wall time;
- worker exit, a first heartbeat within the startup timeout, and heartbeat
  freshness afterwards.

Ownership is recorded by pid plus start time for the worker and every
descendant it observes. That includes Chromium's separate group and
Playwright's transient `system_profiler` display probe, which runs in its own
group. On stop it writes `stop.json`, TERMs owned groups, KILLs after the grace
period, waits for the reap and verifies that nothing owned remains. It never
signals a group without a live member of known identity. The worker exits on
its own if the supervisor disappears (reparenting).

CPU accounting is labelled: `chromium_tree_cpu_s` is `ps` cputime over the
Chromium browser tree; `worker_cpu_s` is the worker's own Node process.
Neither includes the other or the supervisor.

**Review findings and decisions in this slice.**

- *Timer resolution.* Without cross-origin isolation Chromium coarsens
  `performance.now()` to 100 µs, while candidate phases run 5 µs–1 ms. The
  stage server sends COOP/COEP headers. Pages report `crossOriginIsolated:
  true` and a measured 5 µs step.
- *iCloud.* The repository's `node_modules/playwright*` files stay
  `dataless` even after a full read pass. Every launch refetches them, and
  `npm run smoke:browser` from the repository exceeded its 120 s watchdog
  twice with no output. The stage carries byte-identical Playwright packages
  and live-smoke scripts. Run the unchanged command from the stage.
- *Browser.* Playwright 1.58.2 needs Chrome Headless Shell 145.0.7632.6
  (revision 1208). It was not installed. `npx playwright install
  chromium-headless-shell` added about 190 MiB under
  `~/Library/Caches/ms-playwright`. Headless rAF is paced by Chromium's
  internal 60 Hz begin-frame source, and headless-shell canvas raster need not
  match a headed GPU browser. Cross-build decision/engine timing equivalence
  has not been established; the correctness hashes establish behavior only.
  Frame-pacing results are headless-shell results. Running headed would need
  the full Chromium build (a further download) and its own validation.
- *Decision mix.* Node expectations show the v1 opponent deciding on every
  tick (opponent decisions equal terminal ticks). Every-tick candidates are
  88–99% forced PASS. Report decision kinds separately; never pool them.
- *Live-v1 baselines.* The four rendered live-v1 baselines need a v1-candidate
  driver. No frozen reference defines its RNG salts, and it has no Node
  expectations. They are not frozen here; defining them is a separate decision.
- *Supervisor startup.* A test that flaked under full-suite load showed that
  "no first heartbeat yet" must not count as a stall. Startup now has its own
  timeout and stop reason.

### Browser slice review and profiling decisions — October 3, 2026

Accept the saved correctness validation. Do not admit profiling yet. This review
read the browser stage, adapter, page, collectors, worker, supervisor, process
helpers and tests; it does not close the accumulated learner/runtime diff review.

Independent checks verified all 2,259 evidence checksums (`c2ba16878c06ac518a6144dbd29b26833ed2865aed61728a2a145549be800443`),
43 served/script/package files and seven provenance files against the current
repository, with zero differences. All 106 saved match records (96 fast-forward,
eight real-time, two jump) match Node on schedule hash, counts, decision kinds,
opponent decisions, action/state hashes, result and overtime start. The four
bank records each contain 59 rebuilt states, 708 decisions, 354 production
checks and zero mismatches. The saved supervisor reports a zero worker exit,
verified cleanup/reap, no remaining processes and 2,700.842 s elapsed.

Two implementation findings must be repaired before the successor freeze:

1. **Freeze admission fails open (P1).** `freezeCommand` trusts the manifest's
   closure string and the validation's `passed` flag without rehashing staged
   files/configuration, checking the validation's manifest/config pins, or
   requiring the named gates. `gates.gates ?? []` accepts an empty gate set.
   Disposable negative checks both exited zero and wrote a freeze: one with
   no gates; another with only stale manifest metadata and a changed config
   seed of `999`, with the served closure missing. Worker preflight would refuse
   that stage, but the frozen conditions have already changed. Require complete
   schemas/coverage/gates, matching closure/config/manifest pins, an admitted
   successful/reaped supervisor run and an immutable output path. Add negative
   tests for changed/missing files, missing gates and mismatched report pins.
   The actual saved stage and reports passed the independent audit; this finding
   does not invalidate their correctness results.
2. **The independent match deadline is 450 s, not 360 s (P2).** `driveMatch`
   publishes `wallCapMs + 60_000`; the supervisor adds another 30 s of
   `conditionSlackMs`. The worker's ordinary 360 s check waits on browser
   control, so it is not the promised independent bound. Publish the actual
   match deadline and enforce it externally without those extensions. Record
   warmup/control/export and bounded TERM/KILL cleanup separately, and retain
   partial output. Test a condition whose page/control cannot answer while the
   worker continues heartbeating; total-wall and stale-heartbeat tests do not
   test this boundary.

**Decisions for the next harness slice:**

- **Browser:** use the full Chromium build matched to Playwright 1.58.2, with
  `headless: false`, for the 24 primary rendered conditions and four v1
  baselines. Pin its executable/build, record GPU/compositor status, display
  refresh and device scale, and keep the window visible and unobscured. Validate
  the new build against the existing smoke/bank/jump/fast-forward/real-time
  contract, plus the new v1 expectations, before freezing. Retain the headless
  shell for correctness/smoke; no second headless profiling matrix is required.
  Playwright documents separate headed and headless-shell builds
  ([browser documentation](https://playwright.dev/docs/browsers)); the choice of
  headed measurement follows this study's display/frame question. Desktop
  Chromium at a portrait viewport still does not certify iPhone performance.
  Keep COOP/COEP for fine phase timers and label these as isolated diagnostic
  measurements, since the live dev server does not send those headers.
- **v1 baselines:** keep all four, on seed `1836353410` and both sides/viewports.
  Add a diagnostic v1 candidate using the unchanged live `selectBotDecision`
  path after legal enumeration, including its delay-before-select order,
  scheduling and action construction. Use candidate RNG `seed ^ 0xa5a5a5a5`
  (the existing evaluator convention), opponent RNG `seed ^ 0x5f3759df`, both
  next-decision ticks initially 1, candidate-first raw action order and the
  existing opponent select-before-delay path. Pin the live generated v1
  module/artifact and assert the current one-tick v1 delay. This defines an
  automated v1-vs-v1 cost reference, not human-match behavior. Produce Node
  expectations and instrumentation-off/on browser equivalence first. Report
  candidate/opponent costs separately and classify PASS/play from their
  already-enumerated legal lists. No player-facing mirror mode is added.
- **Spotlight/host:** use `~/edge_royale-runs/<run-id>.noindex/` for the stage,
  outputs and traces. Verify exclusion with a disposable sentinel before
  measurement; if it is not effective, use the documented folder exclusion in
  [Spotlight Privacy](https://support.apple.com/en-au/guide/mac-help/mchl1bb43b84/mac).
  Do not disable indexing globally. Observe a quiet host before admission and
  record load, memory pressure and swap activity, not just swap occupancy.
  This review read 9.35 GiB free and 6.06 GiB swap used; neither is future
  admission evidence. Recheck disk after installing/staging the headed build.
- **Missing measurements:** implement the unchanged five independent 100/10
  production-selector invocations per checkpoint; complete-path timings on all
  59 frozen states, both actors, all models/controllers (10 warmups/100 samples)
  with the production learned selector separate; and bounded, separately
  labelled GC/allocation runs with paired untraced behavior checks. Freeze the
  trace windows/order before observing timings, within the existing 60 s per
  model/controller and aggregate resource caps. Keep first-call costs, raw
  samples, forced/elective PASS and play distributions, observer/export overhead
  and incomplete conditions. Do not present differences of live `ps` tree sums
  as exact CPU/game if child processes exit between snapshots; retain identity
  accounting or label the result's missing-process limitation.
- **Freeze/run:** preserve `bed6ff1e…` as the validated headless partial freeze.
  Write a new, linked freeze after repairs and validation; retain the original
  24 v2 conditions/order and append the four declared v1 conditions. Bind all
  measurement paths, report/analysis code, binaries, overhead controls and
  limits. The 3 h/1 GiB/3 GiB admission/2 GiB running reserve/no-retry policy
  remains unchanged. No profiling, browser download, training, cloud dispatch,
  Git staging or commit is part of this review.

Review validation:

```bash
/private/tmp/edger-confirmation-review-y_4hw1gg/node --test \
  tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
git diff --check
df -k ~/edge_royale-runs
sysctl -n vm.swapusage
uptime
```

The targeted suites passed 40/40 in 58.163 s. SHA-256/file/report comparisons and
the two disposable negative freeze checks used inline Python, without writing
to the frozen evidence. Full `npm test` and browser smoke were not rerun: this
review changes documentation only and rechecks the saved passing evidence.

### Freeze and deadline repairs — October 3, 2026

Both review findings are repaired, with negative tests. Nothing was profiled.
The saved freeze `bed6ff1e…` and its evidence directory are unchanged.

**Freeze admission (P1).** `freeze` now runs `freezeStage`. It writes nothing
unless `checkFreezeInputs` returns no problems.

- *Stage rehash* (`verifyStageClosure`):
  - every manifest file is present and unchanged, with no unlisted files;
  - the closure is recomputed and `SHA256SUMS` matches exactly;
  - the config, live-source and generated-module pins, and the manifest's
    stage path, all match;
  - the pinned Node and headless-shell binaries are rehashed;
  - the config is bound to the model, bank and expectation pins and to the
    expectations' seed, and declares the item, bank and preview deadlines.
- *Validation report:*
  - schema `complete` and passed, with no filter, failures or not-run items;
  - bound to the stage directory, recomputed closure, manifest and config
    hashes, and git record;
  - limits, caps, browser, Node and Playwright pins equal, and Chromium exited;
  - planned coverage equals the plan rebuilt from the staged config and
    expectations, with every item (in order) and every planned match passed.
- *Supervisor record:*
  - admitted, `worker_complete` with exit 0, cleanup verified, worker reaped,
    nothing remaining and the worker's last phase `complete`;
  - its output directory holds the report;
  - it ran this stage's worker with the pinned Node, under limits equal to the
    config and with no deadline slack;
  - the report was written inside its run.
- *Gates:*
  - schema;
  - `npm test`, the targeted suites, live browser smoke and the supervised
    validation each recorded exactly once;
  - every gate passed, with a result and an existing log;
  - recorded after the supervised run ended;
  - log files hashed into the freeze.
- *Output:*
  - refused if the file exists or would sit inside the stage or validation
    output;
  - written by hard-linking a private temporary file, so it can never
    overwrite, then made read-only;
  - records the freeze tool hash, rehashed file count, gate-file/log hashes
    and declared deadlines.

The repaired checker ran read-only against the saved evidence. It reported
exactly two problems: the saved config declares no item/bank/preview deadlines,
and the supervisor added 30,000 ms condition slack. All 605 files, the report
bindings and the gates passed. As already decided, the successor freeze needs a
new validation.

**Independent deadline (P2).**

- The worker publishes `deadlines`:
  - always the item's (config `deadlines.item_s`, 3,600 s);
  - inside it, either a match's or a bank check's (`bank_check_s`, 600 s).
  - A match deadline is its `match_wall_cap_s`: real-time 360 s, jump and
    fast-forward 240 s, smoke preview 60 s. It runs from `startMatch` through
    the final result, with nothing added.
  - Page setup, recording and context cleanup fall under the item deadline once
    the match deadline is withdrawn.
- The supervisor enforces every published deadline exactly
  (`condition_deadline`):
  - `--condition-slack-s` is removed, and unknown flags are refused;
  - it records detection lateness (bounded by the poll), `stop_elapsed_ms` and
    TERM/KILL/reap `cleanup.duration_ms` separately.
- The worker no longer soft-stops a match at its deadline, which would race the
  supervisor. On TERM it records the in-flight item and its active deadlines as
  `incomplete`, and later items as `not_run`. Written chunks remain.
- Recorded separately:
  - match records add `timing`: start, poll, stop and result control round
    trips, chunk-write time and condition time;
  - the page adds `warmup_ms` beside `match_wall_ms`, `finalize_ms` and export
    preparation.
- Tests:
  - a fake worker publishes a 700 ms match deadline and keeps heartbeating, and
    the supervisor stops it with `condition_deadline` (the old code ran on to
    the 30 s total cap);
  - a handoff case charges teardown after a finished match to the item.

**Browser check (disposable, not evidence).** A fresh stage was built from the
repaired code under
`~/edge_royale-runs/20261003T0521Z-runtime-cost-repair-check.noindex/`: 605
files, closure `6564a0ef…`. It used the October 2 bank and the saved `74c6ce33…`
expectations. The real stage command exposed a summary-print bug from the
refactor; it was fixed before this stage was built. Filtered runs are `partial`
and can never be frozen.

- `debug-paths/` (smoke, both jumps, `ff-portrait-ctx1` with its bank check, and
  the collectors-on r1 learned portrait real-time page 1) passed every check it
  ran:
  - 2 smoke, 2 jump, 1 bank check, 24 fast-forward and 1 real-time match, all
    equal to Node;
  - supervisor `worker_complete`, cleanup verified, no slack in its limits.
  - The real-time condition took 301.1 s of its exact 360 s deadline:
    warmup 0.49 s, page match 300.0 s, poll round trips 2.3 s total, chunk
    writes 0.17 s.
- `debug-stop/` ran one real-time item under a 45 s total cap:
  - the supervisor stopped at 45.2 s and TERMed the worker and Chromium groups;
    cleanup took 256 ms, was verified, and left no headless-shell process;
  - the worker exited 143 and recorded the in-flight item and both active
    deadlines (item 3,600 s, match 360 s) as `incomplete`;
  - all 42 chunk files written before the stop were kept.

This exercises the TERM path, not a real-browser `condition_deadline` stop.
After these runs, the worker's chunk-drain block was re-indented (whitespace
only), so the repository worker differs from the disposable stage's copy only
in whitespace.
That reason shares the same stop/cleanup code and is covered by the
fake-worker test.

**Spotlight.** Sentinels written at the same time: one inside the `.noindex`
run directory, a control in a sibling ordinary directory. After about three
minutes, `mdfind` found the control by content and name, but not the `.noindex`
sentinel. The control was then deleted. During the debug runs, `mds` and
`mds_stores` stayed near 0% CPU. Repeat the check for the measurement run
directory before admission.

Validation commands (`N` is the pinned Node v20.20.2 copy; `RUN` the directory
above):

```bash
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
"$RUN/out/restage.sh" stage
"$RUN/out/validate.sh" stage debug-paths 1200 \
  "smoke,jump,ff-portrait-ctx1,rt-1836353410-r1-learned-blue-portrait-on-page1"
"$RUN/out/validate.sh" stage debug-stop 45 "rt-1836353410-r2-fixed_one_tick-red-desktop-on-page1"
npm test
```

Results: targeted suites 44/44 (92.1 s; 62.4 s on the rerun after the re-indent),
filtered runs as above, `npm test` 191/191 (system Node v25.2.1, 7m56s). Not run: full unfiltered validation, `npm run smoke:browser`
and a real freeze. The freeze needs the successor stage and its new validation.

### Freeze repair review — October 4, 2026

The original ordinary-file freeze controls and deadline repair pass independent
review. Two path cases remained open before the successor freeze (both
[repaired](#symlink-admission-repair--october-4-2026) later the same day):

- **Unlisted symlinks (P2).** `listFiles` enumerates only regular files and
  directories. A new symlink under `stage/src/` is invisible to the extra-file
  check, even though the stage server can serve its target. In a fresh,
  internally consistent synthetic fixture, adding `src/extra.js` as a symlink
  leaves `checkFreezeInputs.problems` empty. Reject unsupported entries when
  inventorying the stage; do not follow mutable targets outside the closure.
  Cover file, directory and dangling links in negative controls.
- **Output aliases (P2).** `freezeStage` compares lexical paths. A sibling
  directory symlink pointing to the stage passes containment, and `freeze`
  successfully writes a read-only output inside the stage after checking its
  closure. The same comparison guards validation output. Resolve the existing
  output parent and protected directories before containment checks, and test
  both stage and validation aliases. Keep once-only atomic creation.

The reproduction uses the existing synthetic fixture builder without changing
repository tests. Its temporary fixtures were removed. Script and output:
`~/edge_royale-runs/20261004-runtime-cost-repair-review.noindex/`
(`edge-royale-20261004-freeze-review.mjs`, `freeze-review.log`). Run with:

```bash
/private/tmp/edger-confirmation-review-y_4hw1gg/node \
  ~/edge_royale-runs/20261004-runtime-cost-repair-review.noindex/edge-royale-20261004-freeze-review.mjs
/private/tmp/edger-confirmation-review-y_4hw1gg/node --test \
  tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
```

Targeted suites passed 44/44 in 137.992 s. Saved evidence checksums again passed
2,259/2,259; `bed6ff1ed33062c60729c856bdb81503109966312ab69400b9cf32a122f038f9`
is unchanged. Read-only admission of the saved run reports only its missing
declared deadlines and old 30,000 ms slack. No new deadline defect was found.
Full `npm test`, browser smoke/full validation, streaming suite and bot benchmark
were not repeated: this review changes documentation only. No profiling,
browser download, cloud action, Git staging or commit ran.

### Symlink admission repair — October 4, 2026

Both review gaps are repaired, with negative tests. Nothing was profiled. The
saved evidence and `bed6ff1e…` are unchanged.

- **Stage inventory.**
  - `inventoryFiles` walks the stage without following links. It returns the
    regular files and, separately, every other entry: a symbolic link (to a
    file, a directory or nothing), FIFO, socket or device.
  - `verifyStageClosure` reports each as `unsupported <kind> <path>`. A listed
    file replaced by a link to identical bytes is reported as both unsupported
    and missing.
  - Staging uses the strict `listFiles`, so `stage` and `writeStageManifest`
    stop on such an entry instead of omitting it. The headless-shell lookup
    still uses the non-strict list; the binary it finds is hash-pinned.
  - No current input contains a link. Repository `src/`, the copied Playwright
    1.58.2 toolchain, the headless-shell cache and the saved stage were checked.
- **Output containment.**
  - `freezeStage` resolves the output directory with `realpath`. It compares
    that physical path with the resolved stage and supervisor output
    directories.
  - It refuses an output directory that is missing, dangling or not a
    directory. It also refuses a name already taken, including by a dangling
    link (`lstat`).
  - It writes to the resolved path and returns it. Once-only hard-link creation
    and the read-only mode are unchanged.
- **Tests.** One new test (targeted suites now 45):
  - unlisted file, directory and dangling links;
  - a listed file replaced by an identical link;
  - a manifest write over a link;
  - output through aliases to the stage, `stage/src` and the validation output;
  - a dangling alias, a missing directory, a file in the parent chain and a
    dangling link at the output name.
  - Afterwards the fixture still admits and nothing was written in a protected
    directory. An alias to an unprotected directory freezes at its resolved
    path.
- **Residual at this repair.** Worker preflight and the stage server still
  followed links. This is addressed by the [worker repair](#worker-link-repair--october-4-2026)
  below, before building the successor stage. These admission checks do not
  protect against arbitrary concurrent filesystem tampering.

The review's reproduction script, rerun unchanged against the repaired code, now
reports `unsupported symbolic link src/extra.js`. It also refuses the alias
output ("cannot be written inside the stage"), with nothing written. Files are in
`~/edge_royale-runs/20261004-runtime-cost-symlink-repair.noindex/`. `N` is the
pinned Node v20.20.2 copy `/private/tmp/edger-confirmation-review-y_4hw1gg/node`.

```bash
$N ~/edge_royale-runs/20261004-runtime-cost-symlink-repair.noindex/edge-royale-20261004-freeze-review.mjs
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
$N ~/edge_royale-runs/20261004-runtime-cost-symlink-repair.noindex/saved-evidence-check.mjs
(cd ~/edge_royale-runs/20261003T0213Z-runtime-cost-browser-validation && shasum -a 256 -c SHA256SUMS)
npm test
```

Results:

- Targeted suites: 45/45 in 108.9 s.
- Read-only admission of the saved run rehashed 605 files. It reports only the
  known undeclared deadlines and 30,000 ms slack, so the stricter inventory
  found no link there.
- Checksums: 2,259/2,259 OK; the freeze is still
  `bed6ff1ed33062c60729c856bdb81503109966312ab69400b9cf32a122f038f9`.
- `npm test`: 192/192 in 455 s (system Node v25.2.1).

Not run: browser smoke, a full validation and a real freeze (they need the
successor stage). The bot benchmark and streaming suite were not run either. No
profiling, browser download, cloud action, Git staging or commit.

### Worker link repair — October 4, 2026

Close the worker-side link gap before building the successor stage. The strict
`inventoryFiles` implementation now lives in the existing browser worker module;
staging and freeze admission import it, so all three checks use the same walk.
Worker preflight inventories before reading the manifest or hashing listed
files. It refuses unsupported entries, listed files replaced by links, linked
manifest metadata and unlisted regular files before launching Chromium. A linked
manifest produces a normal failed preflight report.

The stage server resolves its root, checks every requested path component with
`lstat`, and refuses links and special files on each request, including entries
added after preflight. It opens the leaf with `O_NOFOLLOW | O_NONBLOCK`, verifies
that the descriptor is a regular file, then streams that same descriptor. Links
to targets inside the stage are also refused. Negative tests cover file,
directory and dangling links, an identical-byte replacement, linked metadata,
unlisted files and FIFOs; ordinary files still serve normally after restoration.
This does not claim protection against a concurrent parent-directory replacement
between the checks and open. Keep the staged tree unchanged during validation.

This changes the staged worker and stager provenance, so the successor needs a
fresh stage and full validation. The saved October 3 evidence remains immutable.
Disposable validation files and exact wrapper commands are in
`~/edge_royale-runs/20261004-runtime-cost-worker-links.noindex/`; these are
debugging checks, not profiling evidence.

Validation (`R` is that directory; `N` is the pinned v20.20.2 Node copy):

```bash
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
"$R/out/restage.sh" stage
python3 "$R/out/preflight-negatives.py"
# From "$R/stage", with pinned Node on PATH:
npm run smoke:browser
"$R/out/validate.sh" stage debug-browser 600 "smoke,jump,ff-portrait-ctx1"
$N ~/edge_royale-runs/20261004-runtime-cost-symlink-repair.noindex/edge-royale-20261004-freeze-review.mjs
$N ~/edge_royale-runs/20261004-runtime-cost-symlink-repair.noindex/saved-evidence-check.mjs
(cd ~/edge_royale-runs/20261003T0213Z-runtime-cost-browser-validation && shasum -a 256 -c SHA256SUMS)
npm test
```

- Targeted suites: 47/47 in 108.771 s, including two worker/server tests.
- Disposable stage: 605 files, closure
  `5951abe290418f476781c0b3107529b76ee45b24b7b579d6373ceb4927f55649`.
- Both supervised preflight controls (unlisted link and linked manifest) exit 1
  before browser launch, with failed reports and verified cleanup. The script
  restores the stage after each control.
- Live `npm run smoke:browser` passes from this stage. The filtered browser run
  passes 2 smoke, 2 jump, 1 bank check and 24 fast-forward matches; status
  `partial`, supervisor `worker_complete`, exit 0, cleanup/reap verified in
  97.703 s (cleanup 109 ms).
- The unchanged freeze reproduction refuses both cases and writes nothing.
  Read-only saved-stage admission rehashes 605 files and reports only undeclared
  deadlines and 30,000 ms slack. Saved checksums pass 2,259/2,259 and the freeze
  hash is unchanged (`bed6ff1ed33062c60729c856bdb81503109966312ab69400b9cf32a122f038f9`).
- Full `npm test`: 194/194 in 441.338 s (system Node v25.2.1). Current worker,
  stager and tests match the disposable stage, 3/3; `out/source-record.json`
  records those source hashes and the stage pins.
- Not run: full browser validation, real-time browser checks, a successor freeze,
  bot benchmark or streaming suite. No gameplay/policy changes, profiling,
  browser download, cloud action, Git staging or commit.

### Worker link repair review — October 4, 2026

An independent review accepts the worker link repair, with no blocking defect.

- **Code.** Staging, freeze and worker preflight share one `inventoryFiles`.
  Preflight inventories before reading `MANIFEST.json` and adds the
  unlisted-entry check it previously lacked. The server checks every component
  with `lstat`, opens the leaf with `O_NOFOLLOW`, checks it with `fstat` and
  streams that descriptor. The October 4 freeze containment is intact.
- **Evidence.**
  - The recorded logs show 47/47 targeted and 194/194 `npm test`.
  - The worker, stager and browser test equal their disposable-stage copies.
  - After the smoke and filtered supervised runs, both the worker preflight and
    `verifyStageClosure` report no problems on that stage, so neither run
    leaves files that the new unlisted check would refuse.
- **Probes** (disposable, outside the repository tests):
  - refused: a regular file or FIFO as a parent, a FIFO leaf (no hang),
    `HEAD`, and encoded traversal;
  - still served: a root passed through an alias, and 200 parallel requests.
  - A hard link to an outside file is served as a regular file. That is
    outside the contract; staging never creates hard links.
- **Pre-existing, not regressions** (both predate this repair; P3):
  - Each client abort mid-response leaves one file descriptor open. Twenty
    aborts left 20 descriptors with both the old path stream and the new
    descriptor stream; `stream.pipeline` leaves none.
  - A malformed percent-escape (`/src/%E0%A4%A`) throws `URIError` from
    `decodeURIComponent` inside the request handler and exits the worker. Under
    the supervisor that fails closed (`worker_exit`). The diagnostic page never
    sends such a URL.
  - Fixing either changes the staged worker, so decide before building the
    successor stage.

Files: `~/edge_royale-runs/20261004-runtime-cost-worker-link-review.noindex/`
(`server-probe.mjs`, `fd-compare.mjs`, `verify-disposable.mjs` and their logs,
`targeted-review.log`). Commands (`V` is that directory):

```bash
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
(cd "$V" && $N server-probe.mjs "$V" && $N fd-compare.mjs "$V" && $N verify-disposable.mjs)
```

Results: targeted suites 47/47 in 51.6 s; probes as above. Not rerun: `npm
test`, browser smoke, the filtered browser run and the saved-evidence checksums
(their logs were inspected). Review changed documentation only.

### Server robustness repair — October 4, 2026

Fix both accepted P3 findings before building the successor stage. The stage
server uses `stream.pipeline` to stream the same checked, opened descriptor;
client disconnects and stream failures now destroy the source stream and close
that descriptor. URL construction and pathname percent-decoding are guarded;
malformed requests return HTTP 400 (`Bad request`) before opening a file, and
subsequent valid requests still serve normally. The page closure, isolation
headers and link/special-file refusal remain unchanged.

Two repository regressions cover malformed percent-escapes, an invalid absolute
request URL, a valid encoded filename after each refusal, and 20 sequential
mid-download aborts. The abort test identifies the served file by device/inode,
verifies its descriptor is open when the response starts, and waits for it to
close after each abort; the large fixture is sparse. Before the repair, the
abort control fails on the first leaked descriptor and the malformed control
reports the uncaught `URIError` (its stalled test process was terminated).

This changes the staged worker again. A fresh disposable stage validates the
repair; it does not replace the immutable October 3 evidence or admit profiling.
The successor stage still requires the headed/v1/measurement prerequisites and
full validation. Checks and exact wrappers live in
`~/edge_royale-runs/20261004-runtime-cost-server-robustness.noindex/out/`.

Validation (`R` is that directory's parent; `N` is the pinned v20.20.2 copy):

```bash
$N --test --test-name-pattern 'stage server' tests/edger-v2-runtime-cost-browser.test.js
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
npm test
node "$R/out/supervisor-probe.mjs"
python3 "$R/out/copy-tests.py"
# From "$R/test-copy", with "$R/out/bin" first on PATH (pinned Node 20):
npm test
"$R/out/restage.sh" stage
$N "$R/out/check-stage.mjs"
# From "$R/stage", with the same pinned Node on PATH:
npm run smoke:browser
"$R/out/validate.sh" stage debug-browser 600 "smoke,jump,ff-portrait-ctx1"
```

- Server checks: 4/4, 1.278 s. Targeted suites: 49/49, 44.723 s.
- First `npm test` from the iCloud repository, system Node v25.2.1: 193/196,
  415.818 s. Both new server regressions pass; three existing supervisor tests
  fail (two startup timeouts and a worker exit before the output-cap check).
  All three modes then pass in isolation under Node 25, with empty worker logs
  and verified cleanup. The process helper was observed `compressed,dataless`.
  This is consistent with the existing iCloud import/startup problem; no
  supervisor change or timeout relaxation was made.
- The repeat runs from an outside-iCloud copy using pinned Node 20. Its 138
  files / 1,718,243 bytes were copied and SHA-256 verified by `copy-tests.py`;
  `test-copy-sha256.json` records each copied source. Full `npm test` passes
  196/196 in 312.497 s, including all supervisor cases.
- Fresh disposable stage: 605 files, closure
  `3309f51ce5081c8704b11291b4cb958d2c65d4ad8acafb1da67a872493f207c5`.
  Worker preflight and freeze inventory checks have zero problems; worker,
  stager and browser-test copies match their current sources, 3/3, both before
  and after browser checks. Live browser smoke passes from that stage. The
  filtered run passes 2 smoke/2 jump/1 bank/24 fast-forward checks, with no
  failures; status `partial`, supervisor `worker_complete`, exit 0, cleanup/reap
  verified in 106.772 s (cleanup 133 ms). It is not full freeze evidence.
- These validation runs can overlap other tests and are not cost measurements.
  No full browser validation, real-time browser check, successor freeze, bot
  benchmark or streaming suite has been run for this server-only repair.
  Saved-evidence admission/checksums were not repeated; no saved evidence was
  written. No gameplay/policy change, profiling, browser download, cloud action,
  Git staging or commit.

### Server robustness repair review — October 4, 2026

An independent review accepts both P3 fixes, with no new defect.

- **Scope.** Against the byte-verified copies in the worker-link stage:
  - the worker differs only by the decode guard (400) and `stream.pipeline`;
  - the browser test gains only the malformed-URL and abort tests;
  - the supervisor, process helper, fake worker and stager are byte-identical
    to the versions that passed earlier full suites.
- **Probes.** The worker-link review's server probe was rerun with four extra
  cases:
  - 20 aborts now leave 0 descriptors (previously 20);
  - `/src/%E0%A4%A` returns 400 and the next request is served, also in a
    separate process;
  - a NUL byte (`%00`) returns 404 without a crash;
  - an encoded slash resolves to the same component-checked file;
  - all earlier link, special-file and traversal refusals still hold.
- **Evidence.** The recorded logs match the report: 49/49 targeted, 4/4
  server, 196/196 in the copied suite (all six supervisor tests pass), smoke,
  and the filtered browser run with verified cleanup. The three sources equal
  their copies in stage `3309f51c…`.
- **The earlier 193/196 run.** The cause is unconfirmed.
  - This review reran `npm test` from the iCloud repository under system Node
    v25.2.1 and got 196/196 in 507 s. The supervisor, process helper and fake
    worker were `dataless` before and after that run, so the failure did not
    reproduce under the same eviction state.
  - `write_big` never exits on its own. Its `worker_exit` therefore means the
    fake worker died early. Together with the two 20 s startup timeouts, that
    fits a stalled or failed module load from evicted files, but the failing
    assertions record only the stop reason. The test's temporary `worker.log`
    and the exit code are deleted.
  - Recommendation (P3, test diagnosability): on a failed supervisor assertion,
    include `worker_exit` and the worker log in the message, so the next
    intermittent failure can be attributed.
  - Until then, run the freeze's `npm test` gate from a verified copy outside
    iCloud, as this repair did, and record that location.

Files: `~/edge_royale-runs/20261004-runtime-cost-server-robustness-review.noindex/`
(`server-probe.mjs`, `server-probe.log`, `npm-test-repo-node25.log`). Commands
(`W` is that directory):

```bash
(cd "$W" && $N server-probe.mjs "$W")
npm test   # repository, system Node v25.2.1
```

Not rerun: the targeted suites, browser smoke, the filtered browser run and the
copied suite (their logs were inspected). Review changed documentation only.

### Supervisor test diagnostics — October 5, 2026

Implement the review's P3 test-diagnosability suggestion. Tests that start a
supervised worker or supervisor CLI now wrap their assertions to append the
available final record (or progress snapshot), including `worker_exit`, stop
reason, command, limits, cleanup and last worker progress, plus Node identity
and the captured worker log. Evidence is read before temporary-directory
cleanup and stored in the original assertion's message. Empty logs and
unavailable logs remain distinguishable. Passing tests add no diagnostic
output. Existing expectations and deadlines are unchanged.

A new regression deliberately fails after an early exit (code 23, stdout and
stderr markers) and after a no-heartbeat startup timeout (SIGTERM and a stderr
marker). It deletes each temporary directory before checking the retained
message and original `ERR_ASSERTION` code. A separate disposable negative
control substitutes an unknown fake-worker mode in the first existing
supervisor test; Node exits 1 and the TAP failure retains worker exit code 1
and the worker's error stack after the directory is removed. That control is
not a repository test failure.

Only the browser-test file changes. The worker, supervisor, process helper,
fake worker and stager match the accepted `3309f51c…` stage byte for byte.
Changed test provenance must be included in the successor stage. The original
193/196 run remains unexplained: iCloud eviction is plausible, unconfirmed,
and does not reproduce reliably. Continue to run the freeze's full `npm test`
gate from a verified copy outside iCloud and record the path, runtime and
source manifest. These targeted checks do not replace that full gate.

Checks are in `~/edge_royale-runs/20261005-supervisor-test-diagnostics.noindex/`
(`R` below; `N` = `/private/tmp/edger-confirmation-review-y_4hw1gg/node`,
v20.20.2):

```bash
$N --test --test-name-pattern 'supervisor diagnostics' tests/edger-v2-runtime-cost-browser.test.js
python3 "$R/out/copy-tests.py"
# From "$R/test-copy":
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js \
  tests/edger-v2-runtime-cost-browser.test.js
# Expected failure, only from the disposable negative-copy with one mode changed:
$N --test --test-name-pattern 'supervisor: completion' tests/edger-v2-runtime-cost-browser.test.js
```

- Repository diagnostic regression: 1/1 (25 skipped), 46.655 s, including both
  deliberate failure paths.
- Verified copy: 138 files / 1,727,417 bytes; `out/test-copy-sha256.json` pins
  them. Targeted suites pass 50/50, 47.859 s, including all supervised-worker
  checks and the new regression.
- `out/negative-emission.log` contains the expected failed assertion and
  worker log; `out/negative-emission-check.json` confirms evidence remains
  after cleanup. `out/runtime-source-record.json` binds the unchanged runtime
  files and the changed test to its verified copy.
- Not rerun: full `npm test`, browser smoke/filtered/full browser validation,
  saved-evidence checksums, bot benchmark or streaming suite. This changes
  assertion diagnostics only; runtime behavior is unchanged. No profiling,
  browser download, successor stage/freeze, cloud action, Git staging or commit.

### Supervisor test diagnostics review — October 5, 2026

An independent review accepts the diagnostics, with one P3 test-strength fix.

- **Unchanged runtime and expectations.** Before this session's headed work,
  the worker, supervisor, process helper, stager, fake worker and
  `tests/edger-v2-runtime-cost.test.js` equalled their October 4 verified
  copies (`20261004-runtime-cost-server-robustness.noindex/test-copy`) byte for
  byte. The browser test differs from its October 4 copy by 88 insertions and
  5 deletions. The five deletions only rename `test(` to `supervisorTest(` on the
  five existing supervisor tests; their bodies, assertions, limits and
  deadlines are unchanged. The insertions are the wrapper and one new
  regression. Every `superviseWorker` call and supervisor CLI spawn sits
  inside a wrapped test.
- **Cleanup order.** Temporary directories are removed only in the file-level
  `test.after`, so the wrapper reads `final.json`/`progress.json` and
  `worker.log` (the supervisor's own paths) long before deletion. Slicing the
  shared `tempDirs` is safe because the file's top-level tests run
  sequentially. Passing tests add no output.
- **Saved controls.** `out/negative-emission-check.json`,
  `out/negative-injection.txt` and `out/targeted-copy.log` (50/50) match the
  report.
- **Fix (P3).** The regression accepted any `ERR_ASSERTION`, so a failed
  `cleanup.verified` check could have satisfied it. It now also requires
  `failure.expected === "worker_complete"`, so the deliberate assertion is the
  one that failed.

### Headed Chromium pin — October 5, 2026

This implements the review's headed-browser prerequisite and checks it against
the existing browser contract. It does not profile, add v1 baselines or
measurement paths, run a full validation, or write a successor freeze. The
October 3 evidence and freeze `bed6ff1e…` were not written to.

- **Install.** Chrome for Testing 145.0.7632.6 (Playwright 1.58.2 `chromium`
  revision 1208, 162.3 MiB download) was installed from the outside-iCloud CLI
  with `install --no-shell chromium`, into
  `~/Library/Caches/ms-playwright/chromium-1208` (333 MiB). `df -k` on
  `~/edge_royale-runs` read 12.96 GiB free at 05:06Z (the October 5 snapshot
  had read 2.84 GiB). It read 14.95 GiB just before the install and 14.63 GiB
  after it (05:13Z), then 17.4–18.4 GiB during staging and the runs. The 3 GiB
  starting reserve held throughout. Most of the swing comes from other host
  activity, not from this work.
- **Stage.** `stage --browser chromium` pins headed Chrome for Testing. The
  default, `chromium-headless-shell`, pins the headless shell, so earlier
  commands are unchanged. `MANIFEST.json` now records `playwright.browser`
  (it replaces `headless_shell`): the engine, revision, version, install
  directory, executable hash, and a hash over the whole install tree. Files
  are hashed, links are recorded by target and never followed, and any other
  entry is refused. A headed `.app` launcher is a small stub, so its hash alone
  does not pin the build. `config.browser` records the engine, `headless`,
  `device_scale_factor: 1` and `display_probe_frames: 120`. Worker preflight
  and freeze admission recheck the executable, the full tree, and that the
  config's engine is the pinned engine.
- **Worker.**
  - It launches the pinned `executablePath` and identifies the browser
    process by that path.
  - Before any item it records `environment.gpu`: CDP `SystemInfo` feature
    status, GPU devices and machine model.
  - It also records `environment.display`, from one page without
    viewport/scale emulation: native device scale, screen and window size,
    visibility/focus, nearest-rank rAF intervals and a refresh estimate.
  - A probe failure stops admission (`environment_probe`).
  - The existing favicon filter tested only the message text. Headed Chrome
    requests the undeclared `/favicon.ico`, and the resulting 404 names that
    URL only in the message location. The filter now matches that exact URL,
    and other retained console errors carry their source URL. The first headed smoke
    failed on exactly this 404 before the fix.
- **Recorded host status (headed).**
  - GPU: ANGLE Metal on Apple M1 (driver 26.5.2), on a MacBook Air 10.1.
    `gpu_compositing`, `2d_canvas`, `rasterization` and `webgl` are enabled,
    and Skia Graphite is on.
  - Display: native device scale 2; screen 1440×900, with 1440×807 available;
    the probe window was visible and focused. rAF intervals were p50 16.7 ms
    and p95 18.4 ms, about 59.9 Hz. Pages still emulate device scale 1.
  - The headless shell reports `gpu_compositing: disabled_software`.
- **Open for the successor freeze.**
  - Decide whether rendered measurement keeps the emulated device scale 1 or
    uses the native 2.
  - The desktop 1280×800 viewport plus window chrome is taller than the
    807 px of available screen. Decide how to keep that window fully visible,
    and record the per-page window bounds.
  - Headed fast-forward contexts took 109–200 s, against about 75 s headless.
    Those are validation timings, not cost evidence.

Checks are in `~/edge_royale-runs/20261005-headed-chromium.noindex/` (`R`). `N` is
`$R/out/bin/node`, a link to the durable staged v20.20.2 (SHA-256 `38de4fc4…`).
The earlier `/private/tmp` copy is gone after a reboot.

```bash
$N ~/edge_royale-runs/toolchains/playwright-1.58.2/node_modules/playwright/cli.js install --no-shell chromium
$N --test tests/edger-v2-runtime-cost-browser.test.js           # repository
"$R/out/restage.sh" stage-headed2 chromium
"$R/out/validate.sh" stage-headed2 filtered-contract 1800 \
  smoke,jump,fast_forward,rt-1836353410-r1-learned-blue-portrait-on-page1,rt-1836353410-r2-fixed_one_tick-red-desktop-on-page1
(cd "$R/out" && $N check-stage.mjs stage-headed2 stage-headed2-record.json)
"$R/out/restage.sh" stage-headless chromium-headless-shell
"$R/out/validate.sh" stage-headless debug-headless 600 smoke,jump
# From "$R/stage-headless", with "$R/out/bin" first on PATH:
npm run smoke:browser
python3 "$R/out/copy-tests.py"
# From "$R/test-copy", with "$R/out/bin" first on PATH (the freeze's full-suite gate location):
npm test
```

- Browser test file: 27/27, 53.5 s, including the new browser-pin regression
  (engine choice, unknown engine, link/target/special-entry tree behavior) and
  four freeze refusals: changed executable, changed library, retargeted link,
  and a config naming the other engine.
- Headed stage `stage-headed2`: 605 files, closure `870d970d…`. The Chrome tree
  `11cdbcd1…` covers 336 files and 5 links. Worker preflight and freeze inventory
  both report zero problems after the run, and the install tree is unchanged.
  The worker, supervisor, process helper, stager, browser test and fake worker
  match their staged copies (`out/stage-headed2-record.json`).
- Headed filtered run: 2 smoke, 2 jump, 4 bank checks, 96 fast-forward and two
  real-time matches (one per declared condition, collectors on, page 1). All
  pass and are Node-equal, with no failures. Both real-time pages stayed visible
  throughout (316.5 s and 293.7 s). Status is `partial` (filtered). The supervisor
  recorded `worker_complete`, exit 0, cleanup/reap verified (103 ms) and
  1,228.5 s elapsed. Load rose from 3.8 to about 5 and swap held 1.7–2.2 GiB;
  these are not measurement conditions.
- Headless default `stage-headless`: closure `17762d1a…`. The shell executable
  `a46b3b1e…` equals the October 4 pin, and its tree holds 19 files. Preflight
  and freeze checks report zero problems. Filtered smoke/jump passed 4/4, and
  live `npm run smoke:browser` passes from the stage in 2.2 s.
- Full-suite gate, from the verified copy `$R/test-copy`: 138 files / 1,744,415
  bytes, copied with SHA-256 checks. `out/test-copy-sha256.json` pins them;
  that record itself hashes to `95c220d4…`. Under Node v20.20.2, `npm test` passed
  198/198 in 517.7 s (`out/npm-test-copy.log`), including all supervisor tests
  and the diagnostics regression. Load was about 4.4–5 during the run. Afterwards
  the only copied file that differed from the repository was this document,
  which no test reads (`out/test-copy-recheck.json`).
- Not run: the full unfiltered validation (headed or headless), the six other
  real-time matches, v1 baselines, measurement paths, the saved-evidence
  checksum audit, the bot benchmark and the streaming suite. This filtered
  check does not admit profiling.

### Headed review and display decisions — October 6, 2026

Accept the supervisor diagnostics and headed Chromium pin. Profiling remains
unadmitted. This review covers the October 5 harness changes, not the entire
accumulated learner/runtime diff.

Independent checks found:

- Six current worker/stager/test sources match the saved headed-stage record.
  The supervisor, process helper, fake worker and Node runtime-cost test still
  match the accepted October 4 copy. The diagnostics retain the original
  assertion and now identify the deliberate failure by its expected value.
- All 138 files in the outside-iCloud test copy still match its manifest
  `95c220d4…`. Its saved `npm test` log records 198/198, zero failures, in
  517.744 s. This review did not rerun that full gate.
- The filtered report has the declared 2 smoke, 2 jump, 4 bank, 96 fast-forward
  and 2 real-time completions, every item/match passing and no failures. Its
  supervisor records exit 0 and verified cleanup. Status remains `partial`;
  it cannot satisfy the full-validation freeze gate.
- The current live v1 and original freeze still hash to `895d5541…` and
  `bed6ff1e…`. Saved evidence was read, not changed. The full 2,259-file evidence
  checksum audit was not repeated.

**Display decisions for the successor:**

- Use `device_scale_factor: 2` for all 24 primary headed conditions and four
  v1 baselines. It matches the recorded native display. The production renderer
  sizes its canvas backing store from `devicePixelRatio`; scale 1 therefore
  omits the native pixel workload. Keep the CSS viewports `390×844` and
  `1280×800`, weights, controllers, seed and original v2 condition order. Leave
  the headless correctness/smoke default at scale 1. Do not add another profiling
  matrix. Playwright's default scale is 1, so set this explicitly
  ([context options](https://playwright.dev/docs/api/class-browser#browser-new-context-option-device-scale-factor)).
- Use the pinned headed build with launch argument `--kiosk`, then explicitly
  put **each newly created page window** into fullscreen with CDP
  `Browser.setWindowBounds`. Freeze those launch arguments and the per-page
  setup. This is browser-window setup; do not invoke the game's fullscreen
  control or alter the renderer/layout to fit the display.
- Both viewports need this treatment: portrait's 844 px already exceeds the
  native available height of 807 px. A geometry-only probe found ordinary
  fullscreen still leaves browser chrome: CDP reports a 1440×900 fullscreen
  window, but the page reports an 87 px top inset and 813 px outer height; the
  native visible-content capture clips the portrait bottom. Fullscreen state
  alone is insufficient admission evidence.
- With `--kiosk` plus per-page fullscreen, both probe windows report bounds
  `(0, 0, 1440, 900)`, no top inset, and exact CSS viewports at DPR 2. Native
  visible-content captures show each complete border and bottom-right marker.
  Canvas backing sizes are `780×1688` and `2560×1600`. Both workers exited 0,
  owned-process cleanup was verified, and browser-tree pins matched before
  and after. This establishes feasibility, not game or timing validation.
- Before freeze, integrate the setup into the harness and record per-page
  window identity/state/bounds, actual DPR, CSS/visual viewport, content inset,
  focus and visibility. Keep the native unemulated screen probe separate:
  emulated pages report emulated `screen` dimensions. Full validation must
  capture the physically visible content in both viewports, retain exact
  viewport/scale checks, and cover all eight real-time matches. Before each
  rendered match, verify settled fullscreen geometry and focus/visibility;
  monitor them with bounded worker-side checks and retain their overhead. A
  lost fullscreen state, clipping, changed geometry/DPR, loss of focus/visibility
  or interrupted playback stops that rendered condition as incomplete.

One non-blocking P3 follow-up: the console filter now matches the exact local
favicon URL, but retains the pre-existing `/favicon/i` message-text exemption.
That can suppress unrelated errors mentioning favicon, despite their different
source URL. When touching the worker for display setup, narrow the exemption
to the known missing-resource error at the exact local `/favicon.ico` URL and
add a control proving unrelated console errors are retained.

Finish the display integration, four v1 baselines, existing-method timing,
all-state complete-path timing and bounded paired GC/untraced paths before one
fresh successor stage and full validation. Bind the unchanged 24 v2 conditions,
four appended v1 conditions, all measurement/analysis paths, display setup and
limits into a linked successor freeze. Reuse an earlier full-suite result only
while its tested source closure is unchanged; worker/stager/baseline changes
require a new verified outside-iCloud full-suite gate. Keep the existing method,
5 ms threshold, resource caps and no-retry policy. No profiling is admitted by
the successful geometry probes.

Review artifacts are in `~/edge_royale-runs/20261006-headed-review.noindex/`
(`R`); `N` is the hash-checked durable v20.20.2 executable:

```bash
N=~/edge_royale-runs/20260929T0346Z-cadence-confirmation/node-v20.20.2/bin/node
R=~/edge_royale-runs/20261006-headed-review.noindex
python3 "$R/audit.py"
$N "$R/run-geometry.mjs"
$N "$R/run-geometry-kiosk.mjs"
# From ~/edge_royale-runs/20261005-headed-chromium.noindex/test-copy:
$N --test --test-name-pattern 'browser pins:|freeze: the reviewed negative controls|supervisor diagnostics' \
  tests/edger-v2-runtime-cost-browser.test.js
git diff --check
```

Targeted checks pass 3/3 (24 skipped), 4.534 s. The geometry probes used the
accepted external supervisor with a 60 s wall cap, 16 MiB output cap and the
unchanged 3 GiB admission/2 GiB running reserves. Their stop reason is
`worker_exit`, code 0, since these geometry workers do not publish the game
worker's completion phase; both cleanup records are verified. They are not
freeze evidence. Reports, native visible-content captures and supervisor logs
are retained. Only docs changed in the repository. No full game validation,
full-suite rerun, bot benchmark, streaming suite, profiling, successor freeze,
browser install, cloud action, Git staging or commit ran.

### Successor harness: display, v1 baselines and measurement paths — October 6, 2026

This implements the [October 6 decisions](#headed-review-and-display-decisions--october-6-2026)
and the remaining pre-freeze harness items. Profiling is still not admitted:
the successor freeze binds the plan, and the measurement run needs its own
admission (quiet host, fresh Spotlight sentinel, fresh free-space check).

**Display (headed only; the headless default is unchanged at scale 1).**

- `config.browser` for `chromium` records `device_scale_factor: 2`,
  `launch_args: ["--kiosk"]` and a `window` block
  (`cdp_fullscreen_per_page`; 12 s settle timeout, request repeated every
  2 s, 250 ms poll, 1 s hold, 1 s close settle). The CSS viewports stay
  `390×844` and `1280×800`. Staging and freeze refuse a config whose display
  settings differ from the engine's decision.
- Every new headed page is brought to the front and put in fullscreen with CDP
  `Browser.setWindowBounds`. The first headed check showed macOS ignoring a
  request made while the previous window was still leaving its fullscreen
  space (the window stayed `normal` for 9 s). The request is now repeated, and
  each closed headed window gets a 1 s settle.
- `checkDisplayGeometry` admits a page only when the window is fullscreen at
  the native screen bounds (from the unemulated probe), the page has no content
  inset (`screenX/Y` 0, outer size = screen), the CSS and visual viewports and
  device scale are exact, the page is visible, the canvas backing store follows
  the scale, and the macOS frontmost application is the pinned Chromium
  process. Playwright emulates `document.hasFocus()`, so focus comes from
  `lsappinfo` (about 30 ms), not the page. The unemulated screen probe is kept
  separate and must report the configured device scale.
- Smoke checks both pages in both viewports and saves a native
  visible-content capture (`Page.captureScreenshot`, `fromSurface: false`) of
  the diagnostic page. The capture must cover the viewport at the configured
  scale.
- Each real-time match (validation or measurement) first passes the settled
  admission; a failed admission starts no match. While it plays, the worker
  checks window bounds, frontmost process, visibility, device scale and
  viewport at every poll and records the overhead
  (`display.monitor`). Any violation stops the match (`display_lost`) and the
  condition is incomplete.
- The favicon exemption now drops only `FAVICON_MISSING_RESOURCE` (the exact
  404 text) at the exact local `/favicon.ico` URL. A unit control retains
  unrelated errors, including ones that mention a favicon, a 404 at another
  URL or port, and a 500 at the favicon URL.

**Live-v1 baselines.**

- `createEdgerV1BaselineDriver` runs the unchanged live `selectBotDecision`
  (delay roll, then selection) after legal enumeration, with candidate RNG
  `seed ^ 0xa5a5a5a5`, the shared opponent (`seed ^ 0x5f3759df`,
  select-then-roll), both first decisions at tick 1 and candidate-first raw
  order. `assertLiveV1Baseline` refuses a v2 live module or a delay other
  than one tick. The v2 driver now shares the opponent and candidate
  bookkeeping helpers; its expectations are unchanged (below).
- `runV1BaselineReference` is an independent evaluation-worker-style loop
  (select-then-roll for both sides). `expect` requires the driver, with hooks
  off and on, to equal it in schedule, counts, kinds, opponent decisions,
  stream/state hashes, result and overtime start. It records the generated
  module (`69333cd5…`) and checks that it holds the promoted JSON
  (`895d5541…`); staging and freeze pin both.
- Results on `1836353410`: both sides end at tick 3,600
  (`tower_advantage_regulation`, blue wins), 3,600 decisions per side, no
  illegal attempts. Blue: 29 plays, 252 elective and 3,319 forced PASS. Red:
  30 plays, 0 elective and 3,570 forced PASS.
- The page drives `kind: "v1_baseline"` matches with their own sample table
  (`v1_candidate_decisions`: enumerate, decide, schedule, total). Validation
  adds both baselines, collectors off/on, to every fast-forward context
  (16 matches).

**Measurement paths** (`scripts/edger-v2-runtime-cost-measure.mjs`, and the
worker's `--measure full|dry_run`). Node paths run first as bounded child
processes with no browser open; then the rendered matrix; then paired browser
GC windows. Measurement records an incomplete condition and continues; there
are no retries. The worker refuses measurement unless the stage and output are
inside a `.noindex` directory.

- *Existing method:* five separate processes per checkpoint, invocation-major
  (`r0, r1, r2` per invocation), each one unchanged `evaluateTiming` call
  (100 samples, 10 warmups, 5 ms budget). That method reports only p95/max;
  every invocation is kept.
- *Complete path:* all 59 bank states × both actors × r0/r1/r2 × both
  controllers, 10 warmups and 100 samples each, state-major, timing
  enumeration through decision, schedule row, legality check and action
  construction (`enumerate_ms`, `decide_ms`, `total_ms`). The production
  learned selector is a separate path; the same diagnostic path with the
  browser collector hook attached measures observer overhead. Every
  combination is checked against its Node reference decision before timing,
  and a mismatch aborts. States are rebuilt before timing starts (59 states,
  about 6 MB, 4.6 s), so replay work never interleaves with timed calls.
  The report labels each path's first call per model as cold-cache, but the
  paths currently share model objects; the independent review below identifies
  that implementation gap. All warmups are kept.
- *Node GC:* for each model/controller, an untraced window and then a traced
  window of the diagnostic path on all states/actors (2 warmups, 20 samples,
  at most 60 s). The traced child records GC performance entries and V8
  sampling-heap allocation, including objects already collected by minor and
  major GC.
- *Rendered matrix:* the 24 original v2 conditions in their frozen order,
  then the four v1 baselines (`<seed>-v1-<side>-<viewport>`), each a full
  real-time match in a fresh context with collectors on. The match deadline
  is 360 s, and every condition is compared with its Node expectation.
- *Browser GC:* seven conditions (each model/controller, plus v1; blue
  portrait), untraced and then traced, each a 1,200-tick (60 s) rendered window.
  The traced window records a Chromium trace (`v8`,
  `disabled-by-default-v8.gc`) summarized into main-thread and other GC
  events, and sampled heap allocation. A gzip'd trace is kept up to 64 MiB.
  Windows must follow the Node schedule up to the tick reached. Equal-length
  pairs must match stream and state hashes.
- *Accounting:* Chromium tree CPU is now sampled at match start, every
  real-time poll and the end. Processes that appear count from zero; an exit
  between samples marks the total `lower_bound`. Collector-on pages keep
  bounded long-task entries and `performance.memory` snapshots. Host snapshots
  add swap-in/out counters and the memory-pressure level. Display-monitor,
  `ps`, poll, chunk-write and export overheads are recorded separately.
- Planned duration: about 79 min of v2 play, 12 min of v1 play, about 16 min
  of GC windows and about 7 min of Node paths, under the 3 h cap.

**Successor freeze.** `freeze` now requires the validation run and a supervised
measurement dry run (`--measure dry_run`, 1,800 s cap) on the same stage,
both bound to its closure, manifest, config and pins, with the dry-run items
equal to the configured dry-run plan. It also requires a fifth gate
(`supervised_measurement_dry_run`), the predecessor `bed6ff1e…` by hash, the
live-v1 pin and the tool's own measurement plan. The output records the 28
rendered conditions (the first 24 equal `profilingMatrix`), the measurement
plan, display setup, schemas and the run arguments (`--measure full`).

**Validation (October 6, 2026 local date; October 5 UTC timestamps).** `R` is
`~/edge_royale-runs/20261006-runtime-cost-successor.noindex`. `N` is
`$R/out/bin/node`, a link to the durable v20.20.2 (`38de4fc4…`). The wrappers
are `R/out/expect.sh`, `restage.sh`, `validate.sh`, `measure.sh`,
`copy-tests.py` and `write-gates.py`.

```bash
"$R/out/expect.sh"                                   # repository; Node expectations
"$R/out/restage.sh" stage chromium d0c0d9f0d938ad6d0798432abc56574434f86ee209d76aef80ebb546cda04078
python3 "$R/out/copy-tests.py"
# From "$R/test-copy", with "$R/out/bin" first on PATH:
npm test
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js tests/edger-v2-runtime-cost-browser.test.js
# From "$R/stage", with "$R/out/bin" first on PATH:
npm run smoke:browser
"$R/out/validate.sh" stage validation 5400
"$R/out/measure.sh" stage dry-run dry_run 1800
python3 "$R/out/write-gates.py"
$N scripts/edger-v2-runtime-cost-stage.mjs freeze --stage "$R/stage" \
  --validation "$R/validation/worker/report.json" --supervisor "$R/validation/supervisor/final.json" \
  --dry-run "$R/dry-run/worker/report.json" --dry-run-supervisor "$R/dry-run/supervisor/final.json" \
  --gates "$R/out/gates.json" \
  --predecessor ~/edge_royale-runs/20261003T0213Z-runtime-cost-browser-validation/out/profiling-freeze.json \
  --out "$R/out/profiling-freeze.json"
```

- Node expectations `d0c0d9f0…` (90 s): 708 bank decisions, 12 full matches and
  the two live-v1 baselines. The bank decisions and full matches are
  byte-identical to the accepted `74c6ce33…` (same five overtime conditions).
- Final stage `R/stage`: 607 files, closure `1408313b…`, manifest
  `af021601…`. After the smoke and both supervised runs, worker preflight and
  freeze inventory report zero problems.
- Full-suite gate, from the verified copy `R/test-copy` (139 files, manifest
  `030a4c3c…`): `npm test` 209/209 in 629.6 s; targeted suites 62/62 in
  61.5 s. The repository differs from the copy only in this document, which no
  test reads. Live `npm run smoke:browser` from the stage passed in 3.2 s.
- Full unfiltered headed validation (15:14:23–16:04:28Z, 3,004.6 s of the
  5,400 s cap): `complete` and passed, with no failures. It covered 2 smoke,
  2 jump, 4 bank checks (708 decisions/354 production checks each, zero
  mismatches) and 112 fast-forward matches, including 16 live-v1 baselines.
  All eight real-time matches passed and are Node-equal:
  - r1 learned blue portrait: 6,000 ticks in 300.0 s;
  - r2 every-tick red desktop: 5,817 ticks in 290.9 s.
  All 12 headed windows went fullscreen on the first request. Every real-time
  admission passed, with 273–283 monitor checks per match (52–59 ms each,
  mostly the `ps` sample) and no violations. No match's CPU total was a lower
  bound. Both native captures cover their viewports (780×1688 and 2560×1600)
  and were inspected. The supervisor recorded `worker_complete`, exit 0, and
  verified cleanup. Host: GPU compositing enabled; DPR 2; 1440×900 at about
  60 Hz; load about 2.2–3.3; swap 3.3–3.4 GiB of 4 GiB, with memory-pressure
  level 2 at the start. These are validation timings, not cost evidence.
- Measurement dry run on the same stage (19:01:49–19:02:52Z): `dry_run_complete`,
  8/8 items, zero mismatches and no incomplete conditions. The traced and
  untraced 200-tick browser windows have equal stream/state hashes.
- Earlier disposable checks on `R/stage-check1` and `R/stage-check2` exposed
  and then verified the fullscreen retry. `stage-check2` has the same closure as
  the final stage; its filtered smoke/real-time run and dry run passed.
- Gates `R/out/gates.json` record all five gates. Freeze
  `R/out/profiling-freeze.json` is read-only, SHA-256
  `800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5`, with
  28 conditions. The predecessor `bed6ff1e…` and live v1 `895d5541…` are
  unchanged.
- Development checks timed the complete path on two bank states with small
  sample counts. No measurement setting was chosen or changed from those
  timings.
- Not run: profiling, the Spotlight sentinel for this directory, a quiet-host
  admission, an independent review, the bot benchmark, the streaming suite, the
  saved-evidence checksum audit, a cloud action, Git staging or a commit.

### Successor harness review — October 6, 2026

Accept the saved correctness evidence and the prior favicon/display/v1 fixes.
Do not admit measurement on successor freeze `800e6dc5…`: three P2 findings
remain in measurement semantics. This review does not cover the entire
accumulated learner/runtime/evaluator diff or change the frozen evidence.

**Independent evidence checks.** All 607 staged files match their manifest,
and 47 matching repository source paths are byte-identical. The 139-file test
copy still matches its own manifest; current source differences are confined to
the runtime-cost plan and backlog, neither read by tests. The freeze's bound
reports, supervisors and gate logs hash correctly; `checkFreezeInputs` returns
zero problems, including binary/browser pin checks. Both supervisors record
zero exits, completion, verified cleanup and worker reap. The original 24
conditions/order and the v2 bank/full-match expectations are unchanged. All 122
saved match records (112 fast-forward, two jump and eight real-time) match Node
on schedule, counts, decision kinds, opponent decisions, stream/state hashes,
result and overtime start. Each of the four banks has 59 states, 708 decisions,
354 production checks and zero mismatches. Both native visible captures show
the whole viewport. The dry run passed its declared eight steps; its two
browser GC windows both end at tick 200 with equal hashes. Predecessor
`bed6ff1e…` and live v1 `895d5541…` are unchanged. These passing records do not
exercise the failure cases below.

**Findings and proposed repairs:**

1. **P2 — first calls share a warmed model cache.**
   `completePathCommand` parses one object per model, and
   `measureCompletePath` uses `models[entry.model]` for diagnostic, production
   and observed paths. `src/ai/v2/policy.js` caches validation by model identity
   and convolution kernels by layer identity. The diagnostic path runs first;
   the later paths' `first_calls` therefore lack the promised cold model-cache
   work. A one-state control with a synthetic clock reports three first-call
   paths, but all schema reads occur during the first diagnostic call.
   Parse a separate object per path/model before any calls, preserving the
   state-major order, then reuse it within that path. Test object/layer identity
   and cache admission rather than asserting a latency difference. Label this
   as cold model-cache work; one process does not provide cold JIT startup for
   every path/controller. Keep process startup costs distinct.
2. **P2 — unequal browser GC endpoints bypass the behavior control.**
   `runBrowserGc` compares hashes only if the partner's terminal tick equals
   the current tick; otherwise both items can remain passed without
   `pair_equal`. `checkWindowAgainstExpectation` checks the candidate schedule
   at whatever tick was reached, without validating the requested endpoint.
   The generated renderer checks `max_ticks` after draining the whole frame,
   so a catch-up burst can overshoot the target. An actual-code control admits
   tick-1200/tick-1201 partners with different stream/state hashes. Require a
   successful partner, an explicitly admitted common endpoint and equal hashes;
   missing/unequal endpoints must be an incomplete pair. Preserve the live
   uncapped drain loop. Either flag full-frame overshoot as incomplete or
   separately freeze a method for comparing a common captured prefix; do not
   silently change the renderer to force equal endpoints. Add missing-partner,
   unequal-tick, hash-mismatch and catch-up-burst controls.
3. **P2 — truncated Node GC coverage is reported as passed.**
   `runNodeGc` requires only a result with zero mismatches. A result with
   `planned: 118`, `completed: 0`, `truncated: true`, and no mismatches passes
   its actual return predicate. The child exits zero on truncation, so a slow
   host can omit later states while the run reports no incomplete item. Require
   full planned coverage and no truncation for completion, retaining bounded
   partial output as an incomplete condition. Compare traced/untraced coverage
   identities explicitly before treating them as paired allocation evidence.
   Add zero-coverage, partial-coverage and unequal-prefix controls; retain the
   60 s cap and no-retry policy.

One smaller boundary follow-up: the observed path starts its outer timer after
`hook("begin")`, omitting the collector's opening clock/read/row reset from
the observer-overhead difference. It also performs `kindOf` only on the
observed path. Use the same decision bookkeeping/classification on both paths
and bracket the entire hook lifecycle to isolate observer overhead. Node heap
sampling currently includes harness bookkeeping and per-combination state
hash checks; label that scope explicitly or collect those checks outside a
separately declared trace window. Do not interpret allocation-site totals as
candidate-only allocations without that distinction.

**Next admission.** Repair the measurement code and controls first, then build
a fresh successor stage, run its verified-copy full/targeted tests, live smoke,
full headed validation and dry run, and write a new linked freeze. Preserve
`800e6dc5…` as the reviewed predecessor; the current stager's fixed predecessor
pin must be updated through that reviewed successor process. Keep weights,
controllers, the 28-condition matrix/order, existing timing method/threshold
and resource limits. No selective timing reruns.

After review, perform the fresh Spotlight sentinel and disk checks. For the
quiet host, close competing heavy workloads and observe memory pressure and
swap-in/out deltas over a short quiet interval; occupied swap alone cannot
establish current contention. If warning pressure or active swapping persists,
prepare a clean host session/reboot and recheck the durable toolchain/stage.
Record the observation and reserve about two uninterrupted hours on AC with
the lid open. The once-per-poll frontmost check is sampled evidence; a brief
focus excursion entirely between polls is not detectable by this mechanism.
Do not claim continuous focus certification.

**Review validation.** Artifacts are in
`~/edge_royale-runs/20261006-runtime-cost-successor-review.noindex/` (`Q`);
`R` is the successor run above and `N` is its pinned `out/bin/node`:

```bash
python3 "$Q/audit.py"
$N "$Q/controls.mjs"
$N "$Q/freeze-check.mjs"
# From "$R/test-copy":
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js tests/edger-v2-runtime-cost-browser.test.js
git diff --check
```

The audit passes 2,184 checks; targeted suites pass 62/62 in 63.160 s. Controls
use a synthetic clock and execute the original admission blocks with synthetic
records; no actual measurement durations are retained or interpreted. The
saved freeze admission check is retained as `Q/freeze-input-check.json` (zero
problems); review files are checksummed in `Q/SHA256SUMS`. Full `npm test`, live
smoke and headed validation were not rerun:
this session changes review documentation only and independently verifies their
saved evidence. No profiling, fresh host/Spotlight admission, cloud action,
Git staging or commit ran. The full October 3 checksum bundle audit was not
repeated; its predecessor freeze hash was verified.

### Measurement repair — October 6, 2026

All three P2 findings and the observer-boundary follow-up from the
[successor review](#successor-harness-review--october-6-2026) are repaired in
the harness code, with regression and mutation controls. No stage, headed
validation, dry run, freeze or profiling ran. Measurement stays unadmitted
until the fresh stage, gates, headed validation, dry run, linked freeze and
review below pass. Stage/freeze `800e6dc5…` and its run directory are
unchanged.

**Repairs:**

1. **Path-isolated model caches** (`edger-v2-runtime-cost-measure.mjs`).
   - `loadPathModels` parses one model object per path and model before any
     call, in path order and then run order.
   - `measureCompletePath` now takes `modelsByPath` (path → run → model). It
     refuses, before rebuilding states, any model, layer or array object that
     is reachable from two path/model entries (`modelIdentityProblems`).
   - The state-major plan order is unchanged.
   - `first_calls` is labelled as cold model-validation and convolution-kernel
     cache work. It does not include cold JIT or process startup: one process
     serves every path and controller, and process costs stay separate.
2. **Browser GC endpoints and pairs** (`-browser-worker.mjs`).
   - `checkWindowAgainstExpectation` requires `windowTicks`. It adds an
     `endpoint` check: the terminal tick must equal the admitted endpoint,
     `min(window_ticks, expected match end)`. A completed status is required
     exactly when the expected end falls within the window.
   - A full-frame catch-up overshoot is therefore incomplete. The renderer
     and its uncapped drain loop are unchanged. The dry run's windowed
     rendered conditions use the same check.
   - `admitBrowserGcPair` decides each pair when the later window of the
     frozen order finishes. It requires a present, passed partner, its own
     passed window, both windows at the one admitted endpoint, and equal
     non-null action-stream and final-state hashes. Problems are recorded as
     `missing_partner`, `partner_incomplete`, `window_incomplete`,
     `unequal_endpoint` and `hash_mismatch`.
   - The pair record is written on both report entries. The later item fails
     as `pair_incomplete` (its window passed) or `condition_incomplete`.
3. **Node GC coverage**.
   - Complete-path results carry `plan_sha256` and `coverage_sha256`: SHA-256
     over the ordered state/path/model/controller/actor identities.
   - `completePathCoverageProblems` requires no mismatches, `truncated: false`,
     at least one planned combination, `completed === planned` and equal
     identities. It gates both the complete-path item and each Node GC item.
   - `admitNodeGcPair`, on the later window, requires both windows complete,
     with equal plan and coverage identities.
   - A truncated window keeps its result file (`file`) and is recorded as
     `coverage_incomplete`. The 60 s window, 150 s cap and no-retry policy are
     unchanged.
4. **Observer boundary**.
   - The timer starts before `hook("begin")` and stops after
     `hook("schedule")`.
   - Every path classifies its decision (`kindOf`) inside the timer, as the
     browser driver does; only the observed path calls hooks. Observed minus
     diagnostic is now the observer overhead.
   - `gc_trace.scope` labels the traced window: the whole timed loop,
     including harness bookkeeping and per-combination state-hash checks. Its
     allocation sites are not candidate-only allocations.

**Schemas and freeze linkage.**
- Complete-path results are `edger_v2_runtime_cost_complete_path_v2`;
  measurement reports are `edger_v2_runtime_cost_measurement_v2`. The freeze
  takes both, and the existing-method schema, from the scripts.
- The stager's predecessor pin is now `800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5`,
  checked against `$R/out/profiling-freeze.json`. Its relation text names the
  repairs.
- Unchanged: the freeze schema, the measurement config, the 28 conditions and
  their order, weights, controllers, the existing timing method and its
  threshold, and all limits.

**Controls** (`tests/edger-v2-runtime-cost-browser.test.js`):
- Window endpoint: a two-tick catch-up burst that matches its own schedule
  prefix still fails `endpoint`. Stopping short fails. A window past the match
  end admits only completion.
- Pairs: the review's tick-1200/1201 reproduction, plus missing,
  incomplete, unequal-endpoint, hash-mismatch and null-hash partners.
- Cache identity: a synthetic clock counts cold validation reads for each path
  object; each path's reads finish before the next path's begin. Shared and
  shallow-copied models and shared layers are refused, and the CLI loader
  returns disjoint objects.
- Observer boundary: a recording hook and counting clock show the timer
  brackets `begin` through `schedule`, and that every path classifies.
- Coverage: zero coverage (including the review's 118/0 shape), partial
  coverage, a forged identity, unequal plans and unequal prefixes of the same
  plan are all incomplete.

Eight mutation controls each revert one repair in a disposable copy. All
eight make the matching test fail; the unmutated copy passes the same tests.

**Validation.** `M` = `~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex`;
`N` = `~/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node`
(v20.20.2). `M/test-copy` holds 139 files copied from the repository by
`M/out/copy-tests.py` with the predecessor's file list, each verified by
SHA-256 (`M/out/test-copy-sha256.json`, `1c87c620…`).

```bash
cd "$M/out" && python3 copy-tests.py
# From "$M/test-copy":
$N --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js tests/edger-v2-runtime-cost-browser.test.js
PATH="$(dirname "$N"):$PATH" npm test
# From "$M/out":
python3 mutation-controls.py "$N"
```

- Targeted suites: 66/66 in 122.3 s (`M/out/targeted-tests.log`). Host load
  was about 4, with 6.9 of 8 GiB swap in use. The slowest tests are the
  pre-existing match suites; these timings are not cost evidence.
- `npm test`: 213/213 in 534.7 s, exit 0 (`M/out/npm-test-copy.log`). That is the
  prior 209 plus four new tests.
- Mutation controls: 8/8 detected, all baselines pass (`M/out/mutation-controls.json`).
- Not run: the stage, live smoke, headed validation, dry run, freeze, bot
  benchmark and profiling. No cloud action, Git staging or commit.

**Next admission (unchanged path).** `M/out` already holds wrappers retargeted
to `M`: `expect.sh`, `restage.sh`, `validate.sh`, `measure.sh` and
`write-gates.py`. Then:

1. Regenerate expectations with `expect.sh`, confirm their deterministic
   results and bindings equal `d0c0d9f0…`'s, and pin the fresh file's own
   SHA-256 (its timestamp and Git provenance differ; corrected by the
   [repair review](EDGER_MEASUREMENT_REPAIR_REVIEW.md)).
2. Stage with `restage.sh stage chromium <sha256>`.
3. Rerun the verified-copy gates and the live smoke from the new stage.
4. Run the full headed validation (`validate.sh stage validation 5400`;
   about 50 minutes of kiosk display) and the dry run
   (`measure.sh stage dry-run dry_run 1800`).
5. Write `gates.json` and freeze with `--predecessor` set to the
   `800e6dc5…` file.
6. Get an independent review of the freeze, then the Spotlight, disk and
   quiet-host admission.

### Fresh stage and pre-display gates — October 6, 2026

The [repair review](EDGER_MEASUREMENT_REPAIR_REVIEW.md) approved steps 1–3.
They now pass. Steps 4–6 wait until the owner reserves the display. No
headed validation, dry run, freeze or profiling has run on this stage, and
measurement remains unadmitted.

```bash
# M, N as above. From "$M/out":
python3 compare-copy.py                 # reviewed copy vs manifest and repository
./expect.sh > expect.log 2>&1
python3 compare-expectations.py > expectations-comparison.json
./restage.sh stage chromium 5d313a3ad1c9857f8454cad627663239b9c0dba03abf5a8d93cf6eaeedebe5ce > restage.log 2>&1
python3 verify-stage-sources.py > stage-source-check.json
caffeinate -s -i ./gates.sh             # targeted, npm test (test copy); smoke (stage)
python3 verify-stage-sources.py > stage-source-check-after-smoke.json
```

- Reviewed copy: all 139 files still match `1c87c620…`. The repository
  differs only in this plan and the backlog, which no test reads.
- Expectations `5d313a3a…` (331 s on a loaded host). Compared with
  `d0c0d9f0…`, only `source.generated_at` and the Git tracked-diff hash
  differ. Bank decisions, the 12 full matches, both v1 baselines, live v1,
  bank, seeds, model hashes, seed plans, closure and HEAD are equal. The
  fresh hash is pinned; provenance was not rewritten.
- Stage `M/stage`: 607 files, closure `ecb846b0…`, manifest `a80cfabd…`.
  Every file matches its manifest with nothing unlisted. All 47 sources shared
  with the reviewed copy, both live sources and all five provenance copies are
  byte-identical to it. Compared with predecessor stage `1408313b…`, only the
  config, expectations, measure/worker scripts and stager/browser-test
  provenance changed. The check repeated after the smoke is unchanged.
- Gates (pinned Node 20 first on `PATH`): from `M/test-copy`, targeted suites
  66/66 in 167.2 s and `npm test` 213/213 in 733.5 s; from `M/stage`, the
  headless `npm run smoke:browser` passed in 6.4 s. These are new
  `out/targeted-gate.log`, `out/npm-test-gate.log` and `out/live-smoke.log`.
  The repair-session logs the review audited are unchanged, and
  `write-gates.py` now reads the fresh logs (`write-gates.prepared.py` keeps
  the original).
- Host during the gates: load rose from about 3.4 to 10–12, swap grew to
  about 10.5 of 11 GiB, memory pressure level 2. These timings are not cost
  evidence, and the host is not quiet.
- `out/SHA256SUMS-fresh-gates` (`136d2db6…`) checksums the 15 new files.
- The headed steps that followed are in the next section.

### Headed validation, dry run and successor freeze — October 7, 2026

Steps 4–5 ran on the owner-reserved display (local date October 7; UTC
timestamps October 6). Successor freeze `75dd33fe…` links `800e6dc5…`. It is
**not yet reviewed**, and measurement remains unadmitted until step 6.

```bash
# M, N as above; R = ~/edge_royale-runs/20261006-runtime-cost-successor.noindex. From "$M/out":
python3 verify-stage-sources.py > stage-source-check-before-validation.json
./validate.sh stage validation 5400 > validation.log 2>&1
python3 summarize-validation.py validation > validation-summary.json
python3 verify-stage-sources.py > stage-source-check-after-validation.json
./measure.sh stage dry-run dry_run 1800 > dry-run.log 2>&1
python3 write-gates.py > write-gates.log
# From "$M/test-copy" (stager byte-identical to the repository and the stage's provenance copy):
$N scripts/edger-v2-runtime-cost-stage.mjs freeze --stage "$M/stage" \
  --validation "$M/validation/worker/report.json" --supervisor "$M/validation/supervisor/final.json" \
  --dry-run "$M/dry-run/worker/report.json" --dry-run-supervisor "$M/dry-run/supervisor/final.json" \
  --gates "$M/out/gates.json" --predecessor "$R/out/profiling-freeze.json" \
  --out "$M/out/profiling-freeze.json" > freeze.log
python3 compare-freeze.py > freeze-comparison.json
```

- Pre-checks (13:15Z): AC power, lid open, 13.75 GiB free, durable Node
  `38de4fc4…`. The stage had zero problems before validation, after it and
  again at freeze.
- Full unfiltered headed validation (13:15:10–14:02:18Z, 2,828.0 s of the
  5,400 s cap): `complete` and passed, with no failures.
  - Coverage: 2 smoke, 2 jump, 112 fast-forward matches (16 live v1) and all
    8 real-time matches; all 122 match records passed.
  - Bank checks: four, each with 59 states, 708 decisions, 354 production
    checks and zero mismatches.
  - Real time: r1 learned blue portrait ended at tick 6,000 in 300.0–300.1 s;
    r2 every-tick red desktop at tick 5,817 in 290.9–291.0 s.
  - Display: every window went fullscreen on its first request. All
    admissions passed. Each match had 252–280 monitor checks and no
    violations, page errors or visibility events. No CPU total was a lower
    bound.
  - Monitor checks averaged 51–70 ms, except 164.5 ms in the first real-time
    match, on a loaded host.
  - Both native visible captures (2560×1600, 780×1688) cover their viewports;
    both were inspected.
  - The supervisor recorded `worker_complete`, exit 0, verified cleanup and
    a reaped worker.
  - Host: load about 5–6 at the start and 2.1 at the end; memory pressure
    level 2 throughout. Swap total varied between 5 and 10 GiB. These are
    validation timings, not cost evidence.
- Measurement dry run (14:03:26–14:04:43Z): `dry_run_complete`, schema
  `edger_v2_runtime_cost_measurement_v2`, 8/8 items, no failures, incomplete
  or unrun conditions. This was the first end-to-end run of the repaired pair
  recording.
  - The complete path covered 60/60 combinations, untruncated, with equal
    plan/coverage identities.
  - The Node GC pair is `complete`: 4/4 coverage in both windows and equal
    identities. The traced window's `gc_trace.scope` is labelled.
  - The browser GC pair is `complete`: both windows end at admitted
    endpoint 200 with equal stream/state hashes.
  - Both windowed rendered conditions stopped at `max_ticks` 200 with no
    display violations.
  - None of these durations are cost evidence.
- `gates.json` records all five gates; its full-suite and targeted gates are
  the fresh `*-gate.log` files. Freeze `M/out/profiling-freeze.json` is
  read-only, SHA-256
  `75dd33fe645a02721ce14aea69d0241d2016a2bca8127aa56e0f43a59c5f212c`, with
  28 conditions.
  - The predecessor link is `800e6dc5…` (unchanged).
  - Compared with the predecessor, the measurement plan, rendered matrix and
    order, run arguments, live v1, limits and deadlines are equal.
  - Only the freeze-tool hash, stage, gates, reports, v2 schemas and
    predecessor link differ.
- `M/out/SHA256SUMS-headed-freeze` (`ddde90fb…`) covers all 1,920 new
  validation, dry-run and freeze files; all verify. Afterwards 17.69 GiB was
  free.
- Not run: the independent freeze review, the Spotlight sentinel, a
  quiet-host admission, profiling, the bot benchmark, a cloud action, Git
  staging or a commit.

**Next (step 6).** An independent review of freeze `75dd33fe…` and its bound
evidence. After that, a fresh Spotlight sentinel for `M`, at least 3 GiB
free, and a quiet host: record load, memory pressure and swap-in/out deltas
over a quiet interval. Pressure stayed at level 2 through these runs, so
prepare a clean host session or reboot if it persists. Then run only the
reviewed freeze's command, with about 2 h of reserved display, a 3 h cap and
no retries.

### Repaired successor freeze review — October 8, 2026

The [independent review](EDGER_FREEZE_REVIEW.md) accepts freeze `75dd33fe…`
and its bound evidence, with no blocking code or evidence defect. It verifies
all 1,920 headed/freezing checksums, 15 fresh-gate checksums, 607 stage files,
139 test-copy files, the 47 shared sources, all 122 Node-equal matches and four
banks. Freeze admission returns zero problems; both generated pages reproduce,
both visible captures show their whole viewports, 11 focused tests and nine
synthetic worker controls pass. The measurement plan, 28-condition order,
weights/controllers, live v1, resource limits and deadlines are unchanged.

Fresh admission observations pass Spotlight exclusion and disk (15.54 GiB),
but the host is **not admitted**: pressure stays at level 2, swap-in/out rise
425.9/412.6 MiB over 94.4 seconds, and the laptop is on battery. No user workload
was closed. Prepare AC power and a clean session/reboot, recheck all durable
pins, and repeat the host/Spotlight/disk checks immediately before reserving
about two hours of uninterrupted display for the one bounded measurement.
No new freeze or headed revalidation is required if the pins remain unchanged.
The exact reviewed command and audit/observation records are in the review.
Profiling, reboot, cloud action, Git staging and commit were not performed.

### Local measurement — October 17, 2026

After a reboot, a drained iCloud backlog and a fresh admission, the reviewed
frozen command ran once. Pins were unchanged, with 4,880 audit checks/zero
problems. The host showed pressure 1/1/1, zero swap-in/out over 120.4 s,
10.92 GiB free, Spotlight exclusion, AC and the lid open. The run used 6,792.6 s
of the 10,800 s cap and completed with no incomplete, failed or not-run
conditions. It covered:

- 15 existing-method invocations;
- 1,770 complete-path combinations with zero mismatches;
- 12 Node GC windows;
- 28 rendered conditions;
- 14 browser GC windows.

Cleanup was verified. The full numbers, admission record, checksums and limits
are in the [local results](EDGER_RUNTIME_COST_RESULTS.md).

### Runtime review — October 24, 2026

The [runtime review](EDGER_RUNTIME_REVIEW.md) re-verified both checksum lists,
reproduced the summary byte for byte and recomputed key numbers from raw records
with no problems. For desktop-class hosts at 60 Hz, it **accepts** the
complete-path and warm frame costs for both controllers. The cold first decision
drops one frame at match start; it is accepted as a known, non-blocking defect,
with a proposed decision-preserving model warm-up. Mobile, reference-host, 120 Hz
and sustained-thermal costs remain unmeasured and not accepted.

The existing gate is unchanged. The review chooses no controller or checkpoint.
It rejects a forced-PASS shortcut under the learned-delay contract. Following the
completion rule below, tactical card/placement work comes next.

## 2. Run bounded local profiling

Freeze the cost plan and report format after harness validation, before its
measurement run. Run one browser/process at a time, on AC with the lid open,
without other heavy work. Record hardware, OS, browser/Node versions, browser
visibility, display refresh, viewport/device scale, CPU load and swap. Stop a
rendered measurement if the page becomes hidden or real-time playback is
interrupted; retain the reason and mark its condition incomplete.

Measure three distinct things:

1. **Existing-method timing.** For each checkpoint, report five independent
   invocations of the unchanged 100-sample/10-warmup production selector test.
   Keep every result. Local runs are diagnostics, not reference-host gate passes.
2. **Complete decision path on a common state bank.** Use at least five states
   per category (busy combat, spell opportunity, forced PASS and overtime), per
   actor: at least 40 states. Freeze their selection without inspecting match
   scores. Time enumeration through observation, masks, encoding, card and
   placement heads, optional delay, decode, scheduling and action construction.
   Use 10 warmups and 100 samples per state/model/controller, plus the production
   learned selector as a separate path. Report p50/p95/p99/max per state,
   category, actor and model, including first-call costs and warmed cache reuse.
3. **Rendered real-time matches.** Run r0/r1/r2 × learned/every-tick × both sides
   × portrait `390×844` / desktop `1280×800`, on the predeclared development
   seed: 24 matches. Add four live-v1 cost baselines on the same seed/sides/
   viewports. Use a deterministic v1 input driver for the other side, with its
   cost recorded separately. Run at 20 ticks/s through the actual renderer and
   rAF loop; `advanceTime` and headless fast-forward cannot measure frame pacing.

For rendered matches retain calls/tick and calls/game; forced versus elective
PASS and play counts; complete-decision distributions; total candidate policy
time and process CPU/game; engine/visual-sync/render durations; rAF intervals;
ticks/frame and maximum accumulated simulation lag; long tasks and memory/GC
evidence. Report elapsed time and CPU time with their distinct boundaries.
Record frame intervals against the observed refresh period without inventing
a new promotion threshold. Avoid pooled PASS-heavy averages hiding costly play
decisions or dense states.

For each frame, retain elapsed rAF time, lag immediately after adding elapsed
time and before draining ticks, residual lag after draining, actual simulation
ticks advanced, and tick/visual-sync/render/callback durations. Define maximum
accumulated lag using the pre-drain value: residual lag alone normally falls
below 50 ms and hides the backlog. Correlate slow callbacks with catch-up bursts
in following frames. Count actual tick advances separately from loop iterations,
including a match that ends during a burst. Validate these boundaries with a
controlled elapsed-time jump outside the primary timing runs.

Collect detailed allocation/GC traces in separate, bounded runs so profiler
overhead does not contaminate the primary frame/latency measurements. Compare
traced and untraced behavior and label their timings separately. A lack of GC
events in a short trace is not proof of zero allocation cost.

Proposed measurement limits to freeze: 3 hours total, one active match, 6,040
simulation ticks and 360 wall seconds per rendered match, at most 1 GiB total
outputs/traces, at least 3 GiB free before admission and a 2 GiB running reserve.
Check cap/reserve during work, terminate owned processes and mark missing
conditions if a limit is reached. Do not rerun selectively to obtain favorable
timings. Trace windows are capped at 60 seconds per model/controller. Recheck
disk on the staging filesystem; September 29's free-space figure is historical.
Enforce wall time and resource checks from a supervisor outside the browser
main thread; an in-page timer can be delayed by the same catch-up work it must
stop. Bound browser-control waits and retain partial outputs on forced stops.
October 2 checks observed 2.37 GiB and then 4.38 GiB free on that filesystem;
admission must use a fresh check against the 3 GiB minimum, not either snapshot.

## 3. Prepare the reference-host request from the validated harness

After the local report, prepare a concrete timing-only approval packet. It must
contain the exact launch/SSM/download/termination commands and checksummed
bundle, rather than reusing a training or full-evaluation dispatch:

The owner budget recorded in `progress.md` is A$10/month for the whole AWS
account, GST included. The recorded Project B staging spend already exceeds
that allowance; a small Edger-only ceiling does not establish available account
headroom. Keep execution local and leave cloud admission pending until the
account budget can accommodate it. This review did not check current billing
or prices.

- One on-demand `c7g.4xlarge` in `ap-southeast-2`, encrypted gp3 with
  delete-on-termination, no inbound access, existing approved SSM/IAM boundaries,
  and a fresh immutable timing prefix. Verify allowed storage/IAM parameters
  against infrastructure before specifying them.
- Pinned Amazon Linux/arm64 Node, one timing process and no evaluation workers,
  training, corpus writes or promotion. Reuse the exact frozen state bank and
  all three checkpoints/controllers. Run the unchanged production timing method
  and complete-path harness as separately labeled measurements.
- Three predeclared independent timing blocks; retain each block, warmup and
  cold-start results. No repeated-until-pass policy. The existing p95 ≤5 ms
  gate stays unchanged; full-path and browser metrics do not replace it, and
  this packet cannot certify an unreviewed every-tick production implementation.
- A maximum 60-minute instance lifetime, workload timeout, independent safety
  shutdown, owned-process cleanup, verified instance termination and absence of
  attached/orphan gp3 volumes. Keep logs if cleanup fails and report it.
- Current official AWS rates, an explicit dollar ceiling including compute,
  storage and transfer, and a runtime/storage bound that fits it. Freeze these
  numbers and commands before requesting approval. No cloud spend is authorized
  by this review; the pricing/launch packet is still work to prepare.

## Completion and subsequent decision

Deliver checksummed raw timings, summaries, state/adapter equivalence checks,
environment metadata, bounded traces, test/smoke results and incomplete/error
records. Explain which measured costs belong to the diagnostic controller,
production selector and browser frame. Report all checkpoints; choose none from
confirmation scores. Complete-path and frame-budget acceptance require an
explicit runtime review, not a retroactive change to the existing timing gate.

If cost is acceptable, continue tactical card/placement investigation, then
parity-contract/precision review, accumulated-diff review and fresh production
provenance/scaling. If cost is unacceptable, propose optimizations or controller
work separately using development evidence and a fresh holdout. Either outcome
keeps live v1 unchanged until a reviewed production candidate passes every gate
and receives separate runtime/promotion approval.

The October 1 pass ran the checksum/report review above. An October 2 review
clarified the mask and catch-up timing boundaries, scoped the first harness
deliverable and added a Python-cache ignore rule. A later October 2 pass
implemented and validated the Node slice recorded above, running `npm test`,
the cadence suite, the new suite and the staged bank/verify commands. It did
not run profiling, browser smoke, bot benchmarks, `npm run test:edger-streaming`,
training or cloud work, and it did not repeat the evidence audit. An October
3 pass implemented and validated the browser slice and froze the rendered
matrix, as recorded in its status section. It ran `npm test`, the targeted
suites, the unchanged browser smoke from the stage and the supervised browser
validation; it did not profile, benchmark, train or use the cloud.
