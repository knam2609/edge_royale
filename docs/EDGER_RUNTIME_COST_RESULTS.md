# Edger v2 local runtime-cost measurement — October 17, 2026

The frozen measurement for freeze `75dd33fe…` ran once, complete, on the local
M1. This is the local report the [runtime-cost plan](EDGER_RUNTIME_COST_PLAN.md#2-run-bounded-local-profiling)
asks for. It reports costs; it does **not** accept them. The October 24
[runtime review](EDGER_RUNTIME_REVIEW.md) makes that decision. The existing
p95 ≤5 ms gate is unchanged, and nothing here selects a checkpoint or controller.

- `M` = `~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex/` (frozen stage; raw output in `M/measurement/`, wrapper log `M/out/measurement.log`).
- `A` = `~/edge_royale-runs/20261017-runtime-cost-admission.noindex/` (admission records, launcher, watcher, summary script and results).
- `A/SHA256SUMS-measurement` (`7d8e67a6…`) covers all 6,117 output files; `A/SHA256SUMS` (`3edc3ebb…`) covers the 23 admission/summary files. Both verify.
- `A/measurement-summary.json` (`a6017199…`) and `A/measurement-tables.md` hold every table below in full, derived read-only from the worker records by `A/summarize-measurement.py`.

## Admission

Local date October 17 (UTC October 16). The laptop was rebooted at about 14:27Z,
with only Terminal and Finder plus this one agent session open, on AC, lid open.

- Durable pins, rechecked from `A`: `python3 audit.py` 4,880 checks/zero problems, and `freeze-check.mjs` zero problems (closure `ecb846b0…`). Both outputs are byte-identical to October 13. The audit copy differs from the October 13 copy (`~/edge_royale-runs/20261013-runtime-cost-admission.noindex/`) only in `REPO`, because the repository moved from `~/Documents/GitHub/edge_royale` (iCloud) to `~/Developer/edge_royale`; `host-check.py` differs only in its control-directory date.
- iCloud Drive was not quiet after the reboot. `fileproviderd`, `bird` and `cloudd` used about 2–2.5 cores for about 3 h while applying a leftover `~/Documents/GitHub/project-b` tree (about 58,600 items; the local folder no longer existed). Nothing was paused, closed or touched. The backlog drained to zero pending at 18:31:04Z, and iCloud CPU had been 0% for 6 min by then. Polling `brctl status` itself loads `bird`, so later waits sampled `ps` only. The logs are `A/settle.log`, `quiet-wait.log` and `icloud-drain.log`.
- `host-check.py start/sample/finish` (18:31:17–18:33:18Z, 120.4 s): pressure 1/1/1, swap-in/out deltas 0/0 (61 pageouts), 10.92 GiB free, Spotlight exclusion passes, load 1.0–1.4. Both sentinels were removed. The decision is recorded in `A/admission.json`.

## Run

`python3 A/launch-measurement.py` detached the unchanged reviewed wrapper, run
from `M/out`: `./measure.sh stage measurement full 10800`. It ran from 18:33:38
to 20:26:50Z (6,792.6 s of the 10,800 s cap).

- Worker `complete`/passed; supervisor `worker_complete`, exit 0, cleanup verified, worker reaped.
- Coverage: 15 existing-method invocations, 1,770 complete-path combinations, 12 Node GC windows, 28 rendered conditions and 14 browser GC windows. There were **no incomplete, failed or not-run conditions** and no retries.
- Resources: minimum free disk 10.89 GiB, peak output 105.5 MiB.
- Host: pressure 1 at the start and end, swap-ins 0 and swap-outs unchanged (12). Load was 3.3 at launch and 2.1 at the end.
- Environment: Apple M1 MacBook Air, 8 cores and 8 GiB, macOS 25.5.0, Node v20.20.2, headed Chrome for Testing 145.0.7632.6 (ANGLE Metal). The display was 1440×900 at DPR 2, about 59.9 Hz.
- The agent session's watcher polled about once a minute, and the agent itself was otherwise idle.

## 1. Existing method (unchanged `evaluateTiming`; 100 samples, 10 warmups)

All 15/15 invocations pass the 5 ms budget. These are local diagnostics, not
reference-host gate passes.

| Model | p95 ms (invocations 1–5) | max ms |
|---|---|---|
| r0 | 0.934, 0.937, 0.964, 0.944, 0.947 | 1.013–1.174 |
| r1 | 0.906, 0.884, 0.883, 0.891, 0.905 | 0.956–1.000 |
| r2 | 0.957, 0.924, 0.920, 0.941, 0.960 | 1.001–1.978 |

## 2. Complete decision path (Node; 59 states × 2 actors × 3 models × 2 controllers)

All 1,770/1,770 combinations completed, with zero reference mismatches and no
truncation. Each combination has 10 warmups and 100 samples. Times are
`total_ms` per call, from enumeration through action construction, using
nearest-rank percentiles.

| Path | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| diagnostic (both controllers) | 70,800 | 0.792 | 2.175 | 3.427 | 6.301 |
| observed (diagnostic + collector hook) | 70,800 | 0.792 | 2.175 | 3.431 | 4.676 |
| production learned selector | 35,400 | 0.809 | 2.250 | 3.544 | 4.208 |
| production: play | 5,300 | 2.191 | 3.569 | 3.764 | 4.208 |
| production: elective PASS | 5,200 | 2.089 | 2.288 | 2.337 | 2.784 |
| production: forced PASS | 24,900 | 0.798 | 0.828 | 0.991 | 3.831 |

- Observer overhead (observed minus diagnostic) is ≤0.004 ms at p50/p95/p99.
- The production learned selector runs ten mask builds where the diagnostic learned controller runs two. Per model and actor it adds about 0.003 ms at p50, 0.06–0.09 ms at p95 and about 0.11 ms at p99.
- The fixed every-tick controller is about 0.03 ms cheaper per call than learned at p50, because it has no delay head.
- By category (production), pocket and elective states are slowest (p99 3.65–3.80 ms, max 4.21 ms). Busy-combat blue and forced PASS states are cheapest (p95 0.83 ms).
- Per model and actor, r1 is 0.03–0.04 ms faster than r0 and r2 at p50. No checkpoint differs materially at p99 (3.50–3.59 ms).
- First calls: the very first call in the process was 10.75 ms (r0 diagnostic, cold JIT and cache). The other eight per-path/model first calls took 3.56–4.10 ms (cold model caches, not independent cold JIT starts). First warmups have p99 3.48–3.61 ms; later warmups match the sampled distribution.

## 3. Node GC windows (diagnostic path; 2 warmups, 20 samples; traced timings labelled)

All 12 windows covered 118/118 state/actor items; all six untraced/traced pairs
are complete with equal identities.

- Tracing adds about 0.01 ms at p50 and 0.07–0.10 ms at p95.
- Each traced window recorded 95–97 GC entries, 26.7–30.2 ms in total, with a longest pause of 3.4–4.7 ms. The GC scope includes harness bookkeeping.
- Sampled allocation is about 1.45 GiB per window, roughly 0.56 MiB per call including bookkeeping.
- The largest site, about 53% of sampled bytes, is the legal-action sort comparator (`src/ai/botRuntime.js:269`, `actionSortKey(left).localeCompare(actionSortKey(right))`), which rebuilds both keys on every comparison. Next are `slice` (about 26%), `sort`, legal enumeration and `writeStableHash` (harness state-hash checks).

## 4. Rendered real-time matrix (headed DPR 2 kiosk; collectors on; 20 ticks/s)

All 28/28 conditions are complete and passed every Node-equality check:
schedule, counts, kinds, opponent decisions, stream/state hashes, result,
overtime and delay boundary. There were zero display violations, page errors
and visibility events, and no lower-bound CPU totals. The matrix covers 90.9
minutes of play and 327,311 frames.

| Controller (conditions) | Candidate ms per tick | Chromium tree CPU s per game s | Tick p99 ms (max over conditions) | Render p99 ms |
|---|---|---|---|---|
| learned r0/r1/r2 (12) | 0.079–0.135 | 0.299–0.314 | 11.07 | ≤1.87 |
| fixed every-tick r0/r1/r2 (12) | 1.795–2.078 | 0.315–0.327 | 11.49 | ≤2.34 |
| live v1 baseline (4) | 0.175–0.636 | 0.300–0.303 | 9.36 | ≤1.77 |

- **Calls.** Learned makes 0.014–0.046 calls per tick (50–272 per game); every-tick and v1 make one per tick. In the browser, every-tick forced PASS costs p95 2.38–2.49 ms. v1 forced PASS is 0.20–0.23 ms, because v1 enumerates and stops, while v2 runs observation, encoding and both heads.
- **CPU.** Every-tick adds about 0.01–0.02 Chromium CPU seconds per game second over learned and v1; rendering dominates CPU in every condition.
- **Decision cost.** After each match's first decision, the slowest v2 decision per match was 7.0–13.0 ms. Browser decision times exceed the Node complete path, for example every-tick forced PASS p95 about 2.4 ms against 0.83 ms. The two are separate builds and contexts (browser V8, main thread shared with rendering, collectors on), and no cross-build equivalence is claimed.
- **Frame pacing.** rAF p50 is 16.66 ms and p99 ≤18.7 ms in every condition.
  - 18 intervals exceeded 25 ms: one at frame 3 or 4 in each of 18 of the 24 v2 matches. Each follows that match's first v2 decision at tick 1, a cold play call. Seventeen were one missed refresh (about 33.3 ms), after first calls of 20.2–30.2 ms that made tick 1 take 32–44 ms.
  - The six v2 matches whose first call took ≤17.3 ms, and all four v1 baselines, dropped no frames.
  - The eighteenth, and the only interval over 40 ms (50.0 ms), was the first rendered match's tick-1 frame (cold call 36.4 ms). It is that match's only long task (60 ms, 752 ms after start) and the run's only slow callback; the following frame advanced one tick.
- **Catch-up.** Across all 327,311 frames, zero frames advanced more than one tick and zero ran more than one loop iteration. The maximum pre-drain lag was 68.7 ms, below the 100 ms a two-tick drain needs. **The uncapped catch-up path never fired on this host**, so its overshoot frequency here is zero.
- Long tasks: one in total. Used JS heap stayed between 9.5 and 19.2 MiB. The display monitor took up to 75 ms per check (`ps`/`lsappinfo` round trips, worker-side).

## 5. Browser GC windows (blue portrait, 1,200 ticks each; traced labelled)

All seven untraced/traced pairs reached endpoint 1,200 with equal stream and
state hashes, and recorded zero long tasks. The traced windows (main thread,
per 60 s) show:

| Condition | MinorGC n / ms | "MajorGC" n / ms / max ms | Sampled allocation MiB |
|---|---|---|---|
| learned r0/r1/r2 | 83–113 / 44.6–49.2 | 74–76 / 123.5–126.6 / 2.33–3.55 | 262–409 |
| every-tick r0/r1/r2 | 194–197 / 91.5–94.9 | 75 / 119.2–121.6 / 2.21–2.94 | 575–578 |
| live v1 | 148 / 58.5 | 76 / 128.4 / 3.45 | 839 |

- Major-GC cadence and cost are the same across learned, every-tick and v1, so they are not policy-driven.
- Every-tick roughly doubles minor-GC work relative to learned, to about 0.16% of main-thread time.
- Untraced windows show the same rAF p99 (18.3–18.7 ms).

## Interpretation limits

- One local fanless M1 run on one development seed. Thermal state was not recorded. This is not reference-host, mobile or deployment cost, and it is not a latency certification.
- Timings belong to their stated boundary: the Node complete path, the production selector, the browser candidate decision, the frame or the GC window. Traced and untraced numbers stay separate. No number here changes the existing gate.
- Confirmation scores selected nothing. All three checkpoints and both controllers are reported.

## Candidate follow-ups for the runtime review (not authorized changes)

1. Decide acceptability. The candidate facts are:
   - existing gate p95 ≤0.96 ms locally;
   - every-tick costs about 2 ms of main-thread policy time per tick and about 5% more Chromium CPU than learned;
   - warm decisions stay under the 16.7 ms frame;
   - the cold first decision drops one frame at match start in most v2 matches;
   - catch-up never fired.
2. Possible decision-preserving optimizations, each needing parity/determinism tests and its own review:
   - precompute action sort keys once per enumeration;
   - avoid full inference when only PASS is legal, if the runtime contract allows it;
   - warm the model before the first live decision.
   Any change that alters decisions needs development evidence, a fresh holdout and promotion approval.
3. The timing-only `c7g.4xlarge` packet can now be prepared from this report, but cloud admission stays pending under the A$10/month account budget (see `progress.md`).

## Reproduction

```bash
A=~/edge_royale-runs/20261017-runtime-cost-admission.noindex
M=~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex
N=$HOME/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node
# Admission (from A):
python3 audit.py > audit.log; $N freeze-check.mjs
python3 host-check.py start; python3 host-check.py sample; python3 host-check.py finish
# Measurement, once (refuses an existing M/measurement or log):
python3 "$A/launch-measurement.py"    # runs: cd "$M/out" && ./measure.sh stage measurement full 10800
# Read-only summary and checksum checks:
python3 "$A/summarize-measurement.py"
(cd "$A" && shasum -a 256 -c SHA256SUMS)
(cd "$M" && shasum -a 256 -c "$A/SHA256SUMS-measurement")
```
