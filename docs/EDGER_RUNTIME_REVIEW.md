# Edger v2 runtime review — October 24, 2026

This is the explicit runtime review that the [runtime-cost plan](EDGER_RUNTIME_COST_PLAN.md#completion-and-subsequent-decision)
requires for the October 17 [local results](EDGER_RUNTIME_COST_RESULTS.md).
It covers the three learned-trained checkpoints (r0/r1/r2) under the learned
and fixed every-tick controllers, measured against freeze `75dd33fe…`.

**Decision.** On desktop-class hosts at 60 Hz, the complete-path and warm
frame costs are **accepted** for both controllers. The cold first decision drops
one frame at match start; this is accepted as a **known, non-blocking** defect,
and a decision-preserving fix is proposed below. Mobile, reference-host, 120 Hz
and sustained-thermal costs remain **unmeasured and not accepted**.

The existing p95 ≤5 ms gate is unchanged, and local passes remain diagnostics
rather than reference-host gate passes. This review does not choose a controller
or checkpoint, uses no confirmation scores, clears no parity, tactical or
promotion gate, and leaves live v1 unchanged.

- `R` = `~/edge_royale-runs/20261024-runtime-review.noindex/`: review scripts, outputs, the speed-up evidence in `speedup/` and `SHA256SUMS` (`c535f957…`, 23 files).
- `A` and `M` are as defined in the [local results](EDGER_RUNTIME_COST_RESULTS.md).

## Verification

Everything was read-only against `A` and `M`; nothing in either was rewritten.

- `A/SHA256SUMS` passes 23/23. From `M`, `A/SHA256SUMS-measurement` passes 6,117/6,117. The list hashes are still `3edc3ebb…` and `7d8e67a6…`.
- `summarize-measurement.py`, rerun from a copy in `R/resummary/`, reproduces `measurement-summary.json` (`a6017199…`) and `measurement-tables.md` byte for byte.
- `R/spotcheck.py` recomputes the key numbers independently from raw worker records, with no problems:
  - Complete path: all 177,000 raw samples. Diagnostic, observed and production count/p50/p95/p99/max match the worker summary groups, using the worker's nearest-rank rule. For production by kind (p50/p95/p99/max), play is 2.191/3.569/3.764/4.208 ms, elective PASS 2.089/2.288/2.337/2.785 ms and forced PASS 0.798/0.828/0.991/3.831 ms.
  - Existing method: all 15 records re-read; each p95/max equals the summary, and all pass.
  - Rendered matrix: for each of the 28 matches, from raw chunks:
    - decision count and per-kind counts;
    - total candidate time;
    - frame count and rAF p50/p99/max;
    - play and forced-PASS p95.

    All of them match the summary.

## Decision by cost

| Cost | Evidence (local M1, Chrome for Testing 145, 60 Hz) | Verdict |
|---|---|---|
| Existing method | p95 0.883–0.964 ms, max ≤1.978 ms; 15/15 under 5 ms | Unchanged gate; local diagnostic only |
| Node complete path (production selector) | p50/p95/p99/max 0.809/2.250/3.544/4.208 ms. The worst kind is play, at p99 3.764 ms. | Accepted: below 8.5% of the 50 ms tick and well inside a 16.7 ms frame |
| Warm browser decisions | Slowest v2 decision per match after the first: 7.0–13.0 ms. Live v1 in the same harness: 15.8–20.3 ms. | Accepted: below one frame, and below the shipped v1's own peaks |
| Tick and frame | Tick p99: v2 6.6–11.5 ms, v1 9.1–9.4 ms. Callback p99: v2 4.3–11.3 ms, v1 8.9–9.1 ms. rAF p99: v2 18.35–18.67 ms, v1 18.63–18.68 ms. Render p99 ≤2.34 ms. | Accepted: frame pacing is indistinguishable from v1 |
| Catch-up | Zero multi-tick and multi-iteration frames in 327,311 frames; maximum pre-drain lag 68.7 ms | Accepted on this host. The overshoot path is exercised only synthetically. |
| Policy time and CPU | Every-tick: 1.80–2.08 ms per tick of main-thread policy time (about 4% of each tick); learned 0.08–0.14 ms; v1 0.18–0.64 ms. Chromium CPU, in s per game second: learned 0.299–0.314, every-tick 0.315–0.327, v1 0.300–0.303. | Accepted for both controllers: rendering dominates CPU |
| Cold first decision | One missed refresh at frame 3–4 in 17 of 24 v2 matches, plus one 50.0 ms interval | Known, non-blocking; fix proposed (see below) |

Learned and every-tick are both acceptable on cost. Any choice between them
needs development evidence, a fresh holdout and promotion approval, not this
review.

## Cold first decision

- Every rendered condition opens a fresh browser context and page (`openPage`, `scripts/edger-v2-runtime-cost-browser-worker.mjs:1115`), so every match starts with cold JIT and cold model caches. The harness never ran a second match in the same page.
- The first v2 call took 12.0–36.4 ms, against 7.0–13.0 ms for the slowest later call. Most of it is two phases:
  - Enumeration: 2.8–19.4 ms (the warm median for play decisions is 0.78–4.12 ms).
  - Encoding: 6.6–15.1 ms (warm median 0.90–1.62 ms).

  The card and placement heads take about 0.7–1.2 ms. The first encode includes the `ensureModel` → `validateEdgerV2PolicyModel` pass and the `compileConv` kernel compilation (`src/ai/v2/policy.js:232`, `:373–383`), which run once per model object, plus the first JIT compilation.
- Tick 1 also contains the harness opponent driver's own first decision (5.9–13.1 ms). A human-vs-Edger match has no such cost.
- Observed threshold: tick 1 at or below 28.0 ms dropped no frame (6 v2 matches and all 4 v1 matches). Tick 1 at or above 32.4 ms dropped one refresh (17 matches). The 50.0 ms interval is the first rendered match, whose tick 1 took 48.8 ms; its next frame advanced one tick.
- Estimate by subtraction only, not measured: without the opponent driver, v2 tick 1 would take about 13–38 ms.
  - One match (38 ms) would be clearly above the observed threshold.
  - Four (31.3–32.1 ms) fall in the unobserved 28.0–32.4 ms gap.
- In the live client the model is a module-level object, so these caches and the JIT state should persist across matches within one page load. The hitch is therefore expected once per page load, not once per match. This is not measured.

## Optimization proposals

As reviewed; 1 and 2 have since been [implemented](#implementation-of-proposals-1-and-2--october-24-2026). Each needs its own review. A change under `src/ai` is protected-runtime code
for campaign provenance, so it belongs with the accumulated-diff review and fresh
scaling provenance. None may change a decision without development evidence, a
fresh holdout and promotion approval.

1. **Prepare and warm the model before the first live decision.** This is decision-preserving and is the proposed fix for the cold-start hitch.
   - (a) Run `ensureModel` and compile every conv layer when the model loads. Both caches are pure functions of the weights, keyed by object identity.
   - (b) Run one throwaway decision on a separate engine before the match starts. It must use a separate engine instance, consume no match RNG and leave no state behind. This also warms enumeration and observation.
   - Tests: logits and decisions are identical with and without preparation on the fixture bank and state bank. A full match's action-stream and final-state hashes are identical with warm-up on and off.
   - Then re-measure tick 1 in a fresh page before claiming the hitch is fixed.
2. **Precompute legal-action sort keys once per enumeration** (`src/ai/botRuntime.js:269`). Today the comparator rebuilds both keys on every comparison; this site accounts for about 53% of sampled Node allocation.
   - Keep `localeCompare` on the same key strings, so V8's stable sort makes the same comparisons and returns the same order.
   - The same enumeration serves live v1 (`src/client/webGame.js:777`), so v1 would benefit too.
   - Tests: enumerated lists deep-equal the current implementation across the state bank and fixtures. Replay hashes are unchanged, and `npm run bot:bench` gives the same results.
   - Allocation savings are expected, but any time savings are unmeasured.
3. **Build the production selector's placement mask only for the chosen card** (`selectEdgerV2PolicyDecision`). `computeEdgerV2Logits` reads only `placementByCard[cardIndex]`, so the other eight placement masks are unused. This is decision-preserving, but worth little: the extra mask builds cost about 0.003 ms at p50 and 0.11 ms at p99.
4. **Skipping inference when only PASS is legal is rejected under the current runtime contract.** On a forced PASS, the learned controller still runs the encoder and delay head, and that delay sets the next decision tick (`src/client/webGame.js:788`). A shortcut would change the action stream. It would preserve decisions only under the fixed every-tick controller, which is not the runtime contract.

## Implementation of proposals 1 and 2 — October 24, 2026

Both recommended proposals are implemented in the working tree; proposal 3 was not
implemented, and proposal 4 stays rejected. Neither change alters any decision.

- **Sort keys** (`enumerateLegalCardActions`, `src/ai/botRuntime.js`). Each key is built once per enumeration and sorted with the same `localeCompare`, then unwrapped. The stable sort makes the same comparisons, so the order is identical.
- **Warm-up** (`warmUpBotDecision`, `src/ai/botRuntime.js`). It makes one throwaway enumeration and decision on a disposable engine, with its own constant RNG, and discards the result. This covers proposal 1 (a) and (b) together: the throwaway decision runs `ensureModel` and all three `compileConv` calls itself, so no separate preparation API was added. `src/client/webGame.js` calls it once at module load, with a fresh `createProductionEngine()`, just before the startup block (`hydrateAppState(); resetGame(); …`). The live engine and `appState.botRng` are untouched. Live v1 benefits now, and a future v2 model would too.
- **Runtime-cost harness pin.** The call sits outside the startup block that `WEBGAME_SUBSTITUTIONS` replaces, so every guarded block still matches. The reviewed `LIVE_SOURCE_PINS["src/client/webGame.js"]` in `scripts/edger-v2-runtime-cost-stage.mjs` moves from `ca29cf42…` to `1143352c…`. `index.html` and all block pins are unchanged.
  - The generated diagnostic module differs from the frozen one only by the new import and warm-up call (`R/speedup/generated-vs-frozen.diff`). Future diagnostic pages therefore warm live v1 at load.
  - A v2 condition would also need its driver's model warmed to represent a shipped v2. That is harness work for the browser confirmation, and it needs a freshly validated successor.
  - The frozen stage, freeze `75dd33fe…` and the October 17 evidence are untouched.
- **Tests** (`tests/bot-runtime.test.js`):
  - Across 1,200 ticks of a live production match (both actors), the enumerated keys are unique and strictly increasing. Such keys admit exactly one stable sorted order.
  - For v1 and v2 models, a warmed model object gives decisions, final state hash and the next red random value identical to a cold model object over 400 ticks. Warm-up leaves its disposable engine's hash unchanged.
  - Mutation controls on a scratch copy detect a reversed comparator (1 failure) and a warm-up that steps its engine (2 failures).
- **Local Node 20 timing** (ad-hoc, fresh processes; not a frozen measurement). The scripts and logs are in `R/speedup/`.
  - Enumeration over a full deterministic heuristic match (3 repetitions, 19,164 calls): total 2,413.6 → 731.2 ms (−70%), per-call p95 1.227 → 0.362 ms, p99 1.377 → 0.412 ms. The fingerprint of every enumerated key list plus the final state hash is identical (`e54d9abe…`).
  - First live decision, median of 12 fresh processes per cell:
    - v1: 20.2 ms cold → 5.9 ms after warm-up.
    - r0: 23.5 ms → 4.4 ms.

    The warm-up itself costs about 23 ms at load. Each model made the same first decision across all 48 processes before and after the change.
- **Validation.**
  - `npm test` passes 216/216 (309 s; system Node v25.2.1, run from `~/Developer/edge_royale`). The first run, before the pin update, failed the four pin-guarded stage/freeze tests, as the guard intends.
  - `npm run smoke:browser` passes (4 s).
  - `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` passes: random 1.000 (26-0, 4 draws), aggressive 0.833 (15-3, 12 draws), defender 1.000 (23-0, 7 draws). Its output is byte-identical to the same command on a scratch copy with the original sort.
- **Not yet shown:** the browser tick-1 frame drop is fixed only if a fresh-page browser measurement says so. These Node numbers do not establish it.

## Side check: sort-order locale dependence

`localeCompare` uses the host's default collation, so in principle the order of
legal actions, which drives tie-breaking, could differ between locales. `R/check.mjs`
sorted all 19,240 keys for the fixed deck (8 cards × a 0.5-step grid over x 0–18
and y 0–32). The order was identical in 11 locales (`en-US`, `en-AU`, `vi`, `da`,
`et`, `lt`, `sv`, `tr`, `cs`, `ja`, `de-u-co-phonebk`) and equals plain
code-unit order. There is no hazard for the fixed deck. Expanding the deck or
the key format would need this check again.

## Limits

- The evidence is one fanless M1 run, on one development seed, with thermal state unrecorded, at about 59.9 Hz.
- A 120 Hz display has an 8.3 ms frame. Warm v2 peaks (7–13 ms) and v1 peaks (16–20 ms) would both exceed it there; this is unmeasured.
- Phones, the reference host and low-end desktops are unmeasured. Portrait usability is a product priority, so any claim about mobile cost needs its own measurement.
- Browser and Node timings belong to separate builds and contexts. No cross-build equivalence is claimed.
- The order of the next steps is unchanged. Tactical card/placement work, the parity-contract review, accumulated-diff review and fresh production provenance remain blocking, as does the separately approved timing-only reference-host packet (cloud admission pending the account budget).

## Reproduction

```bash
A=~/edge_royale-runs/20261017-runtime-cost-admission.noindex
M=~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex
R=~/edge_royale-runs/20261024-runtime-review.noindex
N=$HOME/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node
(cd "$A" && shasum -a 256 -c SHA256SUMS)
(cd "$M" && shasum -a 256 -c "$A/SHA256SUMS-measurement")
(cd "$R/resummary" && python3 -I summarize-measurement.py && cmp measurement-summary.json "$A/measurement-summary.json" && cmp measurement-tables.md "$A/measurement-tables.md")
(cd "$R" && python3 -I spotcheck.py && $N check.mjs && shasum -a 256 -c SHA256SUMS)
```
