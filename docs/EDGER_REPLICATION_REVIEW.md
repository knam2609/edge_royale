# Cadence replication review and next experiment — September 28, 2026

The saved results support continuing with learned-delay training and testing
faster inference. They do not support switching the shipped bot, promoting a
diagnostic model, or weakening a gate. Read this alongside the September 27
replication and audits in [the diagnosis](EDGER_EVALUATION_DIAGNOSIS.md).

The confirmation is now complete. The [October 1 runtime-cost review and
plan](EDGER_RUNTIME_COST_PLAN.md) verifies the saved evidence and specifies the
next local browser profiling task and later timing-only reference-host request.

## Review findings

### The improvement is credible, with limited generalization

The three fixed-trained gains against the parent at the same cadence are
+0.2425, +0.175 and +0.20875 against v1. Learned-trained weights evaluated every
tick average 0.79875 against v1, 0.94667 against aggressive and 0.91667 against
the heuristic. Keep learned-delay training as the working research default:
every-tick training has not justified its greater cost. This is a practical
choice supported by the measured results, not a claim of equivalence.

The pre-registered labels are applied consistently. In particular E3 is not
"replicated positive" under the all-runs rule even though its average is
+0.075 with a positive interval. That interval resamples evaluation seed pairs
after averaging over the three fixed checkpoints; it does not estimate
uncertainty over future training runs. The nine run/opponent estimates are
also not nine independent training replications. Preserve the per-run results
and scope the reliability claim to this parent, budget and opponent mixture.

### Actor attribution needs a precise boundary

The implemented critic-only control removes both policy loss and actor
entropy. The value-detached control prevents value-loss gradients entering
the shared trunk. Together they support the registered actor-driven result
for the **fixed-cadence, two-run controls**.

They do not identify card-head versus placement-head improvements separately,
or isolate policy-gradient effects from entropy and actor-driven trunk
changes. Value-detached still computes values, V-trace targets and advantages
using the critic. It is not a critic-free algorithm. The controls also do not
directly establish the mechanism of the preferred learned-trained pipeline.
No additional mechanism experiment is needed before confirmation, but avoid
the stronger claim that the critic is irrelevant or that individual heads
have been causally identified.

### Repair the tactical audit helper before deeper attribution

The ignored `20260927-tactical-audit/audit.mjs` has two errors in its auxiliary
`best_play_if_forced` diagnostic:

- `engine.getHand("red")[cardIndex - 1]` decodes a global v2 card index as a
  hand slot. In the spell-cluster fixture, index 1 means Giant, but the audit
  labels it Arrows. Use `EDGER_V2_CARD_ACTIONS` or the production decoder.
- `cardMasks.card` is a `Uint8Array`. Its `.map()` converts the returned
  placement arrays into scalar byte values, producing nine zeros instead of
  per-card masks. Build an ordinary array as the production selector does.

The immediate actions/aggregate scores come from `evaluateScenarioLeague`,
and horizon probes use `selectEdgerV2PolicyDecision`; those paths do not use
the broken auxiliary decoder. Thus v1's 0.451, v2's 0.37–0.39 and the actual
Giant-over-Fireball choices remain supported. The auxiliary card labels,
placement indices and score ranges should not be used until repaired and
recomputed into a new audit artifact. Preserve the original files.

V1 failing the suite does not justify lowering the floors. A successor may
reasonably have to meet a stronger tactical standard. Fix the lenient defense
and punishment scoring in a separately reviewed proposal, and investigate
the actual spell weakness through legal masks, card logits, forced-Fireball
placement and corpus/teacher frequencies. Do not add a handcrafted spell
override to the learned policy.

### Parity needs a numerical contract, not a blanket exoneration

The saved parent isolation report confirms that float64 evaluation still
differs from PyTorch float32 beyond `1e-5` on 45/56 fixtures. That supports the
tolerance/scale diagnosis. It does not make the JS precision differences
irrelevant: the audit itself finds sequential float32 pooling dominates the
JS-side error for the fixed-trained models.

Prepare a separate proposal comparing mixed absolute/relative or ULP-aware
error bounds, probability/log-probability differences, and action margins.
Retain exact legal argmax agreement and deterministic ties, broaden coverage
to near ties and both sides, and keep PyTorch float64 as diagnostic evidence
rather than silently replacing the training reference. Evaluate runtime
precision corrections separately from tolerance changes. Do not pick a new
tolerance solely because these candidates would pass it.

### Provenance and timing need two qualifications

The frozen plan declares `frozen_at_utc: 2026-09-27T06:15:00Z`, while the runner
starts at `06:14:06.776Z` and its first collection result is logged at
`06:14:07.194Z`. The plan's local modification time precedes the run, so this
could be a manually entered timestamp error; it is not evidence of outcome
peeking. However, the recorded UTC chronology does not by itself establish
"fixed before any match." Reconcile it in a supplemental provenance note
from available evidence; do not rewrite the original plan or assert a
verification that the records cannot support. Future runs should write actual
freeze timestamps and checksum the plan, runner and analysis before dispatch.

The reported local p95 below 1 ms is a static five-fixture measurement.
`evaluateTiming` constructs legal actions before timing; the match diagnostic
also starts its timer after legal-action enumeration. Neither measures the
complete browser decision/frame cost. The game runs at 20 simulation ticks/s,
so every tick means up to 20 decisions/s during real-time play, not one call
per rendered frame. Costs must be measured on the actual controller and full
decision path, including masks, observations, allocations and enumeration.

## Next task: confirmation and runtime-cost evidence

This is a proposed diagnostic execution plan, not an executed experiment or
authorization for cloud spending, a gate change or a shipped runtime switch.

1. **Prepare and freeze the evidence.** Pin the original parent, the three
   final learned-trained exports, live v1, controller code, source files
   including untracked files, opponent settings and reserved seed plan by
   SHA-256. Resolve the provenance note above. Add an explicit confirmation
   seed selector with count/disjointness tests: the current `evaluate`
   command always reads `plan.development`, so passing the replication plan
   alone will not evaluate its `confirmation` array. Assert the actual seed,
   side and model identity in every report. Store evidence outside iCloud in
   a bounded scratch workspace and preserve a durable review bundle.

2. **Measure cost before choosing a new controller.** Use development states
   and games for local browser profiling and a reproducible reference-host
   harness. Record hardware, OS/browser/Node versions, model/source hashes,
   warmup, p50/p95/p99 complete decision latency, CPU time per match, calls per
   match, allocations/GC and frame-time distributions during rendered play.
   Include busy combat, spell targeting, forced-PASS and overtime states.
   Measure all three learned-trained checkpoints under both controllers.
   Retain the existing reference-host p95 ≤5 ms gate and report full-path
   metrics separately. Prepare an exact, bounded `c7g.4xlarge` timing-only
   request with cost/time ceiling and cleanup before asking for cloud
   approval; it must not dispatch or resume the failed campaign. Browser
   results on one local machine are evidence for that machine only.

3. **Run one locked confirmation matrix.** Use all 200 reserved seeds, each
   on both sides, against v1, aggressive and heuristic. Evaluate four models
   (parent plus r0/r1/r2 learned-trained) at both learned and every-tick
   cadence: **4 × 2 × 3 × 200 × 2 = 9,600 games**, plus repeatability checks.
   Rerun the parent on these same seeds; development parent scores are not a
   confirmation baseline. Use final checkpoints without selecting the best
   run or retraining. Freeze runtime/disk budgets from existing step timings;
   stop only for predeclared engineering failures, non-finite/illegal output,
   repeat mismatches or resource limits, never interim win rates.

4. **Separate the decisions in the analysis.** The primary runtime contrast
   is every-tick minus learned inference for the same learned-trained weights
   against v1, averaged per seed over r0–r2. Also report each run separately,
   improvement against the original learned-cadence parent, and transfer on
   the two secondary opponents. Use whole seed-pair bootstrap resampling
   (10,000 draws), preserving all paired conditions. The pooled interval
   remains conditional on the three checkpoints. A proposed research rule
   to freeze before running is: primary mean gain ≥0.05 and lower 95% bound
   >0, pooled secondary-opponent lower bounds >−0.05, and no per-run cadence
   point estimate below −0.05 on any opponent. Report parent contrasts
   separately, with intervals, so a cadence gain cannot conceal a weak model.
   These proposed margins are a practical research decision rule, not a
   modification of promotion gates or proof about future training runs.

5. **Return a decision packet.** Deliver checksummed reports, per-run results,
   cost measurements, engineering failures and unchanged preflight outcomes.
   Recommend whether every-tick inference merits a later production change.
   Confirmation alone cannot clear parity, tactical or provenance blockers.
   Keep live v1 in place until a new production candidate passes the full
   existing promotion process.

If cost motivates fixed 2/4/8/16-tick or delay-capped controllers, select and
freeze those on development seeds **before** opening the confirmation set,
and update the matrix/budget explicitly. The simplest next experiment is the
two-controller matrix above. After confirmation results are opened, further
controller tuning requires a fresh holdout to support a new confirmation
claim. The matrix does not reconfirm training-cadence superiority, because
fixed-trained checkpoints are deliberately outside its scope.

## Step 1 preparation — September 28

Local preparation only: no confirmation game, training, cloud job, runtime
change or gate change. Intermediate cadences are excluded from this round.

### Provenance reconciliation

This supplements the September 27 record without modifying it. Times are
UTC from local filesystem metadata (birth and modification times) and the
run's own logs. File metadata is not tamper-evident; it is the only evidence
available here.

Verified:

- `pins/` inputs were written 06:08:28–06:08:56, the three seed plans
  06:09:09, and `reports/frozen-plan.json` at 06:10:14. The plan's birth and
  modification times are equal, so it was not rewritten afterwards.
  `scripts/run.mjs` was written at 06:10:57 and `scripts/preflight.mjs` at
  06:11:14.
- The runner started at 06:14:06.776. The first sampled training game
  finished at 06:14:07.194, and iteration 0 of `r1-learned-full` completed
  its 64 games and update by 06:14:35.
- `scripts/analyze.mjs` was created at 06:15:43 and last modified at 06:15:57.
  That is after the first training games, but before any evaluation game:
  the first evaluation step started at 07:35:39. It was not modified after
  any evaluation result existed.
- The plan pins four tool checksums but not `run.mjs`, `preflight.mjs` or
  `analyze.mjs`. The review verifier confirmed the four tool checksums on
  September 28, before the seed-selector change described below.
  `edger-v2-cadence-{core,worker}.mjs` were last modified September 25, and
  `edger-v2-cadence-experiment.py` at 06:00:35 on September 27.
- The plan's estimands and decision rules existed at 06:10:14, before any
  game. The saved analysis matches them: all 132 intervals were recomputed
  exactly.

Unresolved:

- Why the plan declares `frozen_at_utc: 06:15:00Z`, which matches neither
  the plan's write time nor the analysis script's. It reads like a manually
  entered time. No record explains it.
- The contents of `analyze.mjs` before 06:15:57 are unknown. Its only
  possible exposure was one arm's iteration-0 training games against
  training opponents, which none of the pre-registered decisions use. That
  makes an influence unlikely, but the records cannot exclude it.

Therefore "estimands and rules fixed before any match" is supported. "Analysis
code fixed before any match" is not: it was written during the first
training iteration and before any evaluation. The confirmation freeze below
writes its time from the clock, checksums the runner and analysis, and
refuses to refreeze once any match output exists.

### Confirmation bundle

Ignored `artifacts/edger-training/experiments/20260928-cadence-confirmation/`:

- `evaluate --seed-set development|confirmation` is now required
  (`scripts/edger-v2-cadence-experiment.mjs`). Confirmation seeds come only
  from the replication plan, development seeds only from base/per-run plans.
  The named set must be distinct and disjoint from the frozen suites, every
  other set in the plan, and `--exclude-seed-plans` (the base plan, because
  r0 trained on its seeds). Reports record the set, schema, excluded-plan
  checksums and exact seeds. Two new tests cover selection, the wrong-file
  mistakes, missing sets, insufficient/malformed counts, separation, and a
  real CLI run that records the seeds it played.
- `scripts/freeze.mjs` pins the parent and final r0/r1/r2 learned-trained
  exports, both seed plans, the 29-file import closure of the evaluator
  (including untracked files), `package.json`, the Node binary, the runner,
  analysis and capacity estimate. It checks them against the September 27
  records. `run.mjs` and `analyze.mjs` refuse to proceed on any checksum,
  closure or Node mismatch.
- `scripts/stage.mjs` copies every pinned input and the Node binary outside
  iCloud with the same layout and verifies them. During this preparation
  iCloud evicted the in-repo Node binary twice. Launches were then killed
  (exit 137) or failed with "Operation timed out", which would stop a long run.
- `scripts/run.mjs`: 24 conditions, v1 first, each model's two cadences
  back to back. Each condition has in-process repeats plus a cross-process
  replay of five pairs at three workers. It stops on engineering failures,
  the wall cap or the disk reserve, never on scores, and prints no scores.
- `scripts/analyze.mjs` implements step 4 above: C1 (primary: every tick
  minus learned, learned-trained weights, vs v1, run-averaged), C2/C3 parent
  cadence and interaction, and T1–T3 against the parent. It uses the same
  10,000-draw seed-pair bootstrap and the proposed decision rule. A dry run on
  the already-open development reports reproduces 48 September 27 intervals
  exactly and finds no engineering problems.

Capacity estimate (`reports/capacity-estimate.json`, from 6-worker September
27 step times): 9,600 matrix games plus 336 repeat games; **about 2.7 h
expected** (every tick 2.2 h, learned 0.5 h); proposed **wall cap 4.5 h**;
about 15 MiB of reports and no trajectories; start a step only with at least
2 GiB free (5.4 GiB free now). Parent v1/aggressive costs are scaled from
the same-run parent-vs-heuristic ratio (0.88 learned, 1.12 every tick). The
20260926 parent timings are excluded: they ran 7 workers on 8 cores, and
non-inference time per game was about 20× the trained models' at similar
match length, consistent with the earlier sleep/throttling. The cap adapts
each projection by the observed slowdown. If it is reached, v1 conditions
are already complete.

Browser profiling must not run concurrently with the matrix on this machine.
It would distort both measurements, so schedule it before or after.

**Frozen 2026-09-27T16:01:19Z** (02:01 AEST September 28; written from the
clock). Plan SHA-256 `95d01bbc73b08d67cb629cee4918e41b2c5dc7a7a3412382be793a09215a87c4`.
Pins: parent `2e576955…`, r0 `dfc76358…`, r1 `07accf40…`, r2 `2852f7c4…`,
replication seed plan `6f5d790d…`, base plan `a5d7cadc…`, Node binary
`38de4fc4…`, live v1 `895d5541…`. All pins match the September 27 records.
The closure is 29 files: three untracked cadence scripts, a modified
`src/ai/v2/policy.js`, and the rest clean at HEAD `0270d828`. `run.mjs
--verify-only` passes. The run has not started. It awaits acceptance of the
budget; a budget change before the first game means
`freeze.mjs --refreeze "<reason>"`. (Superseded on September 28 at 11:25 UTC
by the refreeze in "Running-step enforcement and refreeze" below; the pins
are unchanged.)

Runner smoke test (before the freeze). The runner and analysis ran end to end
from a staged copy in the session scratchpad. The only changes to that copy
were `PAIRS=2`, `REPEAT_PAIRS=1` and a synthetic seed plan whose two seeds
are disjoint from every real set, including the reserved confirmation
seeds. It completed 48 steps, all exit 0, in 0.17 h. Confirmation-mode
analysis found zero engineering problems on real evaluator output.
Verified refusals:
- a refreeze without a reason, and any freeze once output exists;
- a tampered pin, or a Node binary other than the pinned one;
- a relaunch after a stop without `--acknowledge-stop`.

A corrupted action hash made the analysis verdict "invalid" and stopped the
runner at the cross-process repeat. After acknowledgement it resumed to
completion. The frozen `run.mjs` differs from the smoke-tested one only in
its step-log command text.

## Budget review — September 28, 06:55 UTC

The numerical local budget is accepted: 9,600 matrix games plus 336 repeat
games, six workers, 2.7 h expected, 4.5 h maximum, about 15 MiB of reports
without trajectories, and a 2 GiB free-space reserve. Launch remains blocked
on one implementation discrepancy with the offered limits.

The frozen `scripts/run.mjs` checks projected remaining time and free space
only before a step (lines 100–108), then blocks in `spawnSync` without a
timeout (line 117). The frozen plan explicitly describes these as step
admission rules. They do not enforce a deadline or detect a disk-reserve
breach while that step runs. Add running-step enforcement of the cumulative
deadline and periodic disk checks, including shutdown of evaluator workers
and an explicit recorded resource stop. Verify those paths with synthetic
work and refreeze with a reason before any confirmation game; retain the
same numerical budget, matrix, seeds and decision rules.

V1-first ordering prioritizes the primary comparison but does not guarantee
it completes before a resource stop. Incomplete primary conditions must stay
reported as incomplete.

This review changed documentation only. The plan checksum remains
`95d01bbc73b08d67cb629cee4918e41b2c5dc7a7a3412382be793a09215a87c4`;
no staging, confirmation games, refreeze or tests ran. AC power and an open
lid were observed, with about 6.3 GiB available. The in-repo Node binary was
still marked `dataless`, reinforcing the need for verified staging.

## Running-step enforcement and refreeze — September 28, 11:26 UTC

This resolves the budget-review blocker. The numerical budget, matrix, models,
seeds, evaluator closure, capacity estimate and analysis are unchanged.

`scripts/run.mjs` now enforces the limits while a step runs:

- Each evaluator is spawned detached, in its own process group. Its six match
  workers are `worker_threads` of that process; the evaluator starts no
  processes.
- Every 10 s a watchdog checks cumulative step time against the 4.5 h cap
  and free space against the 2 GiB reserve. Cumulative step time spans
  sessions and includes stopped steps, which move to `replaced_steps` on rerun.
- A breach, an unreadable free-space value, or SIGINT/SIGTERM/SIGHUP to the
  runner sends SIGTERM to the whole group, then SIGKILL after 15 s. A second
  signal skips the grace period.
- The runner waits until the group is empty and deletes the step's partial
  report. It records the step (`stopped`, signal, process group) and the
  session stop (`wall_cap`, `disk_reserve`, `interrupted` or
  `engineering_failure`).
- A process left in the group after a normal exit is killed and treated as
  an engineering failure.
- A relaunch refuses while an earlier session's evaluator group is alive. A
  session that ended without a recorded stop needs `--acknowledge-stop`.

Admission checks before a step are unchanged. `common.mjs` holds the 10 s and
15 s constants. `freeze.mjs` writes the in-step rules into
`budget.wall_cap_rule`, `budget.disk_rule`, `budget.running_step_enforcement`
and `stopping_rules`. It also notes that v1-first ordering does not
guarantee primary completion.

Limits that remain:

- A step can run past the cap by at most one check plus the grace period,
  about 25 s.
- The evaluator writes its report only at the end. A stop discards the
  condition in progress; the largest projection is 14 min, for parent every
  tick vs v1.
- SIGKILL of the runner cannot be trapped. The evaluator keeps running and
  that step's time is not counted. The relaunch refusal and acknowledgement
  make this visible.
- V1 conditions are projected at 1.2 h of 2.7 h. Only a sustained 3.7×
  slowdown would stop the run before they finish. Missing conditions are
  reported as incomplete.

Verification used the final scripts in six scratch copies under the session
scratchpad. Each copy was built from the frozen closure and pins and
re-pinned in that copy only. Synthetic seeds (label
`edger-cadence-runner-watchdog-synthetic-20260928`) were derived disjoint from
the frozen suites and every set in both real plans, including the 200
reserved seeds. No confirmation seed was played. Evidence and the harness are
in the bundle's ignored `runner-checks/`.

| Check | Result |
| --- | --- |
| Normal path, 2 pairs / 1 repeat pair | 48/48 steps exit 0 in 337 s, each in its own group, empty afterwards with no strays; analysis finds zero engineering problems |
| Cap reached mid-step (40 s test cap, 60 pairs) | Stopped at 60/120 games; evaluator (1 process, 17 threads, about 650% CPU) exited 18 ms after SIGTERM; group and partial gone; unacknowledged relaunch refused; acknowledged relaunch stopped at the cumulative cap before any step |
| Free space below reserve mid-step (600 MiB filler under a reserve 250 MiB below free space) | Stop 4.8 s after the filler, exit 11 ms after SIGTERM; filler removed |
| SIGINT, then acknowledged rerun and SIGTERM, then SIGHUP | Each stop 7–10 ms; rerun completed the stopped condition and kept the first attempt in `replaced_steps`; completed reports kept |
| Runner SIGKILL | Evaluator orphaned (parent pid 1); relaunch refused naming its group until `kill -TERM -<group>`; then acknowledgement required |
| Stub evaluator ignoring SIGTERM, with a child process | SIGKILL 15.0 s after SIGTERM; evaluator and child gone |
| Stub exiting 0 but leaving a child | Child killed; run stopped as `engineering_failure` |

Refrozen 2026-09-28T11:25:49.711Z (21:25 AEST) with
`freeze.mjs --refreeze "<reason>"`. The reason records the enforcement change,
the synthetic-seed verification and the unchanged budget. New plan SHA-256:
`0a86a59832746a81ea4aba9636fdb2de89339a57e22dcac5cf1b761d67ef9840`. A
field-by-field comparison with the superseded plan found:

- **Unchanged:** pins, conditions, games, pairs, repeats, closure (29
  files), module settings, estimate checksum, budget numbers, analysis
  section, the `analyze`/`estimate`/`stage` scripts and the Node binary.
- **Changed:** freeze time, `superseded_plan`, the `common`/`freeze`/`run`
  checksums, the rule texts listed above, and the descriptive tree record
  (documentation edited since the first freeze).

`run.mjs --verify-only` passes. No confirmation output, run log or logs exist.

The superseded plan (`95d01bbc…`) was moved to `reports/superseded/` and
read back. About a minute later it was gone from the iCloud-synced folder,
and no conflict copy appeared. The system log did not show the cause. It was
restored from a byte copy made before the refreeze and matches `95d01bbc…`.
The six superseded scripts are stored beside it, and each matches the
superseded plan.

One synthetic-check copy failed before its runner started. `copyFileSync`
from an evicted repository file returned `ECANCELED`. After rehydration the
check passed. `stage.mjs` uses the same copy call and fails loudly, so run
`--verify-only`, which rehydrates, immediately before staging.

## Launch review — September 29 (AEST; September 28 UTC)

*Steps 1–2 below were completed the same night; see "Retry removal and
refreeze". Steps 3–5 were completed on September 29; see "Confirmation run".*

**Hold launch for one runner correction.** This supersedes the earlier
ready-to-stage handoff. The running-step watchdog and the 71 saved checks
are supported, but they do not cover automatic retries after an evaluator
SIGKILL. No confirmation game or staging occurred during this review.

Fresh `run.mjs --verify-only` passed for plan `0a86a598…`. The superseded
plan still matches `95d01bbc…`; all six current script hashes match the plan
and test-evidence manifest, and all six superseded scripts match their plan.
Comparison confirms unchanged model/seed pins, matrix, evaluator closure,
numerical budgets and analysis. The design change is only the qualification
of v1-first ordering. The saved six scenario reports contain 71 PASS checks
and no failures; they were inspected, not rerun here.

### Finding: SIGKILL retries bypass admission and restart the watchdog

`scripts/run.mjs:229–237` retries every exit 137 or SIGKILL, regardless of
whether the evaluator has started work. Admission checks run only before
this loop. Each retry starts a fresh 10 s watchdog, so attempts that die
before its first check can continue after the cap or below the reserve.
They are labelled "killed at launch" without evidence of a launch failure.
The final step record also loses the earlier attempts' exit details; after
exhausting four attempts it incorrectly records `attempts: 5`.

An isolated, no-game reproduction used the unchanged frozen runner and the
pinned Node v20.20.2 binary. A stub logged work after 2 s and self-SIGKILLed
after 9 s. With a 1 s cap, 0.1 s projection and unchanged 10/15 s watchdog
and grace, the runner launched it **four times for 36.244 s**. It never
recorded a watchdog halt and finally stopped as `engineering_failure`.
Thus the stated approximately 25 s maximum cap overrun does not hold on
this path. This is a control-flow test with a stubbed `common.mjs` verifier,
one unused synthetic seed and no real evaluator/model input; it does not
replace the full synthetic-seed checks. Fixture, exact reproduction command,
hashes and logs are preserved in ignored
`artifacts/edger-training/experiments/20260929-confirmation-launch-review/`.

### Next execution plan

1. Make a narrow runner correction before using the holdout. Prefer removing
   automatic exit-137/SIGKILL retries: record the failed attempt and stop for
   engineering review; an acknowledged relaunch uses the normal cumulative
   admission checks. This also avoids guessing whether a kill happened at
   launch. Correct the attempt count and retain failure evidence. Preserve
   the existing process-group cleanup before any return or relaunch.
2. Add regressions for an evaluator killed after work starts, budget/reserve
   checks before a relaunch, and accurate attempt records. Rerun the existing
   stop scenarios on final scripts using synthetic seeds only. Refreeze with
   an explicit retry-policy reason before any confirmation output, preserving
   `0a86a598…` and its six scripts outside iCloud first. Keep models, seeds,
   matrix, analysis and numerical budgets unchanged.
3. Verify the new plan using a byte-identical Node outside iCloud, immediately
   stage to a new directory outside `~/Documents`, and verify that staged
   copy against the expected full plan hash. Check free space on the staging
   filesystem, AC power and an open lid. At this review, free space was about
   5.7 GiB and AC was attached; recheck at launch.
4. Run once under `caffeinate -s -i`, with six workers and no competing heavy
   work. Review any recorded stop before `--acknowledge-stop`; do not extend
   the cumulative budget. A runner SIGKILL still leaves unaccounted evaluator
   time: stop its recorded process group and reconcile that time before
   considering continuation. Do not treat acknowledgement as a budget reset.
5. Preserve and checksum reports and logs outside iCloud first. Run the
   frozen analysis once there after completion or a final stop, then copy
   the verified evidence back. Report missing conditions as incomplete and
   include runner failures/resource stops alongside the statistical verdict.
   Browser profiling follows separately; confirmation alone clears no
   runtime-cost, tactical, parity or promotion gate.

Review validation (September 28 UTC / September 29 AEST):

```bash
/private/tmp/edger-confirmation-review-y_4hw1gg/node artifacts/edger-training/experiments/20260928-cadence-confirmation/scripts/run.mjs --verify-only
# In /private/tmp/edger-confirmation-review-y_4hw1gg/retry-check:
../node run.mjs
```

The first command passed. The second reproduced the defect (exit 1,
36.244 s, four actual attempts / five recorded). No confirmation data was
generated. No frozen script, model, evaluator, runtime or gate changed;
only review documentation and isolated evidence were written. `npm test`,
streaming tests, cadence tests, bot benchmark and browser smoke were not
rerun for this review. Their earlier results remain prior validation.
`git diff --check` and a trailing-whitespace scan of the review documents
passed. Final checks confirmed unchanged frozen scripts/plan and no
confirmation output or leftover evaluator process.

## Retry removal and refreeze — September 29 (AEST; September 28, 15:40–16:10 UTC)

This completes steps 1–2 of the launch-review plan. Models, seeds, matrix,
evaluator closure (29 files), capacity estimate, analysis, budget numbers and
the 10 s watchdog and 15 s grace constants are unchanged. No confirmation
game was played and nothing was staged.

`scripts/run.mjs` now launches each step's evaluator exactly once per
session. The four-attempt loop is gone. Any non-zero exit or signal death is
an `engineering_failure` stop, including SIGKILL or exit 137 at launch. The
existing process-group wait and stray kill still run before the stop. The
step record keeps `attempts: 1`, the exit status/signal and the process
group, and the step log has one `launch:` header per session. A rerun
happens only after an acknowledged relaunch passes the cumulative cap and
disk admission checks. The killed step's time then stays in
`replaced_steps`. `freeze.mjs` changes only the
`stopping_rules.engineering_failure` text to state this. With no retry
path, the documented bound applies again: a step overruns the cap by at most
one 10 s check plus the 15 s grace, as before. The exception remains an
untrappable runner SIGKILL.

Verification ran the final scripts from scratch copies with synthetic seeds,
built as in the previous section. The pinned Node v20.20.2 ran from a
byte-identical scratchpad copy (SHA-256 `38de4fc4…`). All nine scenarios
passed: 111 checks, none failed.

| Check | Result |
| --- | --- |
| Previous six scenarios, rerun unchanged | 71/71; normal path 48/48 steps in 330 s with one attempt each; cap stop at 60/120 games, 27 ms after SIGTERM; disk stop 4.8 s after the filler; signal stops 7–14 ms; orphan refusal; SIGKILL 15.0 s after an ignored SIGTERM; stray child stopped as `engineering_failure` |
| `killed`: the review case (1 s cap, 0.1 s projection, stub SIGKILLed 9 s after launch, once it had logged work) | One launch; step 9.0 s, `attempts: 1`, `signal: SIGKILL`, not a watchdog stop; `engineering_failure`; group empty; unacknowledged relaunch refused; acknowledged relaunch stopped at the cumulative cap with no launch and an unchanged step record |
| `killed-reserve` | After a SIGKILLed stub, an acknowledged relaunch below the disk reserve (600 MiB filler) stopped before launching. After the filler was removed, the rerun launched once and stopped again. The first step stayed in `replaced_steps` with its 9.04 s and signal |
| `launch-kill` | SIGKILL at launch (0.04 s step), then exit 137 on the acknowledged rerun. Each was one launch and an `engineering_failure` naming the exit, and neither was retried |
| Negative control: `killed` on the superseded runner | Reproduced the defect: 4 launches, 36.2 s, `attempts: 5`; 5 of 12 checks failed |

Refrozen at 2026-09-28T16:01:46.466Z with `freeze.mjs --refreeze "<reason>"`.
The reason records the retry removal, the checks above and the unchanged
design. New plan SHA-256:
`9e6b6da2985b65d5e175da03cb7833f2303d87ef1ce987b876a058e3ec3b0d50`.
A field-by-field comparison with `0a86a598…` shows:

- **Changed:** freeze time, `superseded_plan`, the `run.mjs`/`freeze.mjs`
  checksums, `stopping_rules.engineering_failure`, and the descriptive tree
  record.
- **Unchanged:** every other section: scope, design, pins, closure, module
  settings, toolchain, budget and analysis.

`run.mjs --verify-only` passes. No `reports/eval`, `reports/repeats`,
`reports/run-log.json` or `logs/` exist.

Preservation followed the iCloud notes. Before any edit, the whole bundle
was byte-copied outside iCloud, and all 36 file hashes matched. The six
`0a86a598…` scripts were written to
`reports/superseded/scripts-2026-09-28T11-25-49-711Z/` and match that plan.
After the refreeze moved the old plan, it was replaced at once with a
freshly written copy of the backup (`0a86a598…`). The previous runner-check
harness and evidence moved to
`runner-checks/superseded-2026-09-28T11-25-49-711Z/`. The new harness, both
stubs, ten evidence files and `scripts-under-test.sha256` are in
`runner-checks/`, and the checksums equal the refrozen scripts.

One scratch copy (`launch-kill`) took 96 s to build before its runner
started. The other copies took about 0.3 s. This is consistent with iCloud
rehydrating a repository input. The runner steps themselves took well under
a second.

Remaining limits are unchanged: a stop discards the condition in progress,
an untrappable runner SIGKILL leaves that step's evaluator time uncounted,
and v1-first order cannot guarantee primary completion. An evaluator killed
by the OS or by a Node-binary eviction now costs a manual, acknowledged
relaunch rather than a silent retry.

Steps 3–5 of the launch-review plan followed on September 29 (next section).

## Confirmation run — September 29 (03:45–06:46 UTC; 13:45–16:46 AEST)

This completes steps 3–5 of the launch-review plan on frozen plan
`9e6b6da2985b65d5e175da03cb7833f2303d87ef1ce987b876a058e3ec3b0d50`. The
matrix, seeds, models, budget and analysis were unchanged. There was no
training, tuning, refreeze, code change, cloud work, runtime or gate change,
promotion, staging in Git or commit. The plan can no longer be refrozen,
because output now exists. The reserved holdout is spent: any later
controller tuning needs a fresh holdout.

### Launch conditions, verification and staging

- **Free space.** `df -k /System/Volumes/Data` was sampled 12 times at 30 s
  intervals from 03:39:50 to 03:45:21Z and read 8.51–8.63 GiB each time.
  This is the staging filesystem for `~/edge_royale-runs`. The earlier
  10.2 GiB reading was not reused.
- **Machine state.** AC power, lid open. No `xcodebuild`, `keepalive.sh`,
  `relay.py` or `devicectl` was running. A Claude Code session had just
  started in the Project B repository; it stayed idle and no build ran during
  the run. No evaluator process or confirmation output existed.
- **Node.** `/private/tmp/edger-confirmation-review-y_4hw1gg/node`, v20.20.2,
  full SHA-256
  `38de4fc456c0c439bac48c727d378f749abb4e31f4116703bb1ee9a746fccbb6`.

```bash
NODE=/private/tmp/edger-confirmation-review-y_4hw1gg/node
EXP=artifacts/edger-training/experiments/20260928-cadence-confirmation
$NODE $EXP/scripts/run.mjs --verify-only    # 03:45:41–03:47:14Z: verified 9e6b6da2…
$NODE $EXP/scripts/stage.mjs ~/edge_royale-runs/20260929T0346Z-cadence-confirmation   # 03:47:15Z: 45 files
```

In the staged directory:

- The plan's full hash matched.
- `STAGED.json` lists 44 files plus Node; each was recomputed, with no
  mismatch.
- The staged Node hash matched.
- The staged `run.mjs --verify-only` passed.
- 8.55 GiB was free.

### Execution

At 03:48:18Z, from the staged root:

```bash
caffeinate -s -i node-v20.20.2/bin/node $EXP/scripts/run.mjs
```

It ran in its own session (fork, then `setsid`; parent launchd), so it did
not depend on the agent's shell. The first launcher attempt called
`setsid()` from a process-group leader and failed with EPERM before `exec`.
Nothing started: no run log was written and no process was left. Its output
is kept as `run-2026-09-29/ops/launch-setsid-eperm.txt` and
`launcher-setsid-eperm.out`. It was a wrapper failure, not a runner session
or stop.

- **Session.** One session, `stop_reason: complete` at 06:46:03.838Z. No
  acknowledgement and no replaced steps.
- **Steps.** All 48 steps had `attempts: 1`, exit 0, no signal, no watchdog
  halt, an empty process group and no strays.
- **Time.** Step time totalled 10,664 s (2.96 h of the 4.5 h cap) against
  2.72 h projected, a ratio of 1.09. Every-tick evaluations took 2.34 h
  (2.08 h projected), learned evaluations 0.49 h (0.48 h projected) and
  repeats 0.14 h. The largest per-step ratio was 1.34, on a 94 s step.
- **Monitoring.** A 60 s engineering monitor (`ops/monitor.log`, 178
  samples) read only progress counts and runner timing. No score was
  inspected before completion. It recorded:
  - free space of 7.26–8.48 GiB and swap use of 5.6–6.7 GiB;
  - AC power and an open lid throughout;
  - no build processes.
- **Background load.** Load spiked from outside the run between 04:32 and
  04:38Z (1-minute load average up to 99; source not identified). About one
  core of macOS `ANECompilerService` and StorageManagement work ran
  alongside the run. These slowed every-tick steps by 10–27%. They
  triggered no stop.

**There was no engineering stop.**

### Determinism and engineering checks

- **Games.** 9,600 matrix games: 24 conditions × 200 reserved pairs × both
  sides. Every report records the confirmation set, the exact seeds and the
  excluded base plan. There were 0 illegal attempts.
- **Repeats.** Two in-process repeat specs per condition (48 in total) matched.
  All 24 cross-process repeats at 3 workers (240 games) produced identical
  action-stream and final-state hashes.
- **Analysis checks.** The analysis identity checks (model hashes, seed
  plan, exclusion, schema) found 0 engineering problems.

### Frozen analysis

The analysis ran once, at 12:05:37–12:05:41Z, from the staged environment:
`node-v20.20.2/bin/node $EXP/scripts/analyze.mjs > $EXP/reports/analysis.md`.
It exited 0 with empty stderr, using bootstrap seed 20260928 and 10,000
seed-pair resamples.

**Verdict: "every-tick inference supported for a later production-change
review."** All four pre-registered rules hold.

Primary contrast C1 (every tick minus learned inference, same learned-trained
weights), with development-seed values for comparison:

| Opponent | r0 | r1 | r2 | Run-averaged [95%] | Pairs better / worse / tied | Development E4 (September 27) |
| --- | --- | --- | --- | --- | --- | --- |
| v1 (primary) | +0.210 | +0.098 | +0.168 | **+0.158 [+0.128, +0.190]** | 120 / 22 / 58 | +0.140 [+0.106, +0.173] |
| aggressive | +0.095 | +0.018 [−0.013, +0.050] | +0.072 | +0.062 [+0.040, +0.082] | 73 / 18 / 109 | +0.060 [+0.023, +0.095] |
| heuristic | +0.135 | +0.063 | +0.095 | +0.097 [+0.073, +0.122] | 101 / 28 / 71 | +0.075 [+0.038, +0.112] |

The rule checks:

- The primary mean is 0.158 ≥ 0.05, and its lower bound 0.128 > 0.
- The secondary run-averaged lower bounds are +0.040 and +0.073, both above
  −0.05.
- The smallest per-run point estimate is +0.018 (r1 vs aggressive), above
  −0.05; its interval includes zero.

C1 is replicated positive per run against v1 and heuristic. Against
aggressive it is "not established" per run and positive only run-averaged.

Other run-averaged estimands:

- **C2 (parent: every tick minus learned).** v1 −0.028 [−0.086, +0.031],
  aggressive −0.077 [−0.122, −0.033], heuristic −0.034 [−0.095, +0.028].
  Faster inference does not help the parent, and it hurts against
  aggressive.
- **C3 (cadence interaction).** +0.186, +0.139 and +0.131; replicated
  positive against all three opponents. The cadence gain is specific to the
  RL-trained weights.
- **T1 (trained learned minus parent learned).**
  - v1: +0.136 [+0.083, +0.190], replicated positive.
  - heuristic: +0.167 [+0.118, +0.217], replicated positive.
  - aggressive: +0.002 [−0.030, +0.036], **inconsistent**. The per-run
    results are r0 −0.050 [−0.095, −0.005], r1 +0.048 and r2 +0.007.
- **T2 (trained every tick minus parent learned).** +0.294, +0.063 and
  +0.264; replicated positive against all three opponents.
- **T3 (trained minus parent, both every tick).** +0.322, +0.141 and
  +0.298; replicated positive against all three opponents.

Learned-trained weights at every tick average 0.809 against v1, 0.948
against aggressive and 0.937 against heuristic (development: 0.799, 0.947
and 0.917). The parent at its learned cadence scores 0.515, 0.885 and 0.672.
Per-condition scores and intervals are in `reports/analysis.md`.

### Local cost

This measures six concurrent workers under the background load above. It is
not a latency measurement.

- **Decisions per game.** Trained models make 3,297–3,917 decisions per game
  at every tick (the parent 3,787–4,318), against 64–150 with the learned
  delay (the parent 33–37).
- **Inference time.** The evaluator's inference timer excludes legal-action
  enumeration. It averaged 1.83–2.05 ms per decision at every tick and
  1.85–2.37 ms with the learned delay. That totals 6.3–8.0 s of inference per
  every-tick game against 0.12–0.30 s.
- **Wall time.** 8.3–13.5 s per game at every tick against 1.0–4.3 s with
  the learned delay.

These are means under contention. The September 27 figure (local p95 <1 ms
per call) was measured differently, so the two are not comparable. Neither
measures complete decision latency, browser frame cost or the reference-host
p95 ≤5 ms gate.

### Evidence

- **Staged run (outside iCloud).**
  `~/edge_royale-runs/20260929T0346Z-cadence-confirmation/`:
  - `SHA256SUMS-pre-analysis` (`28037d27…`): 150 files, including Node,
    written before the analysis and re-verified after it.
  - `SHA256SUMS-analysis` (`739ff1b2…`).
- **Durable copy without Node.**
  `~/edge_royale-runs/20260929T0346Z-cadence-confirmation-evidence/`:
  153 files, all verified; `SHA256SUMS` `099346cb…`.
- **Repository bundle** (ignored, and subject to iCloud eviction):
  - `reports/eval/` and `reports/repeats/`, 24 files each;
  - `reports/run-log.json` (`adcaa74b…`);
  - `reports/analysis.json` (`eecd1a57…`) and `reports/analysis.md`
    (`6201ecc6…`);
  - `logs/`, 48 step logs;
  - `run-2026-09-29/`: `STAGED.json` (`e5728360…`), `ops/` (launch record,
    prelaunch state, monitor script and log, runner output, analysis
    stderr) and the three checksum manifests.

  All 109 copied files match. The frozen plan and capacity estimate were
  compared and found identical, not overwritten. The superseded plans still
  match `95d01bbc…` and `0a86a598…`. The bundle's `run.mjs --verify-only`
  still passes.

### Interpretation and limits

- On the 200 reserved seeds, every-tick inference improves all three
  learned-trained checkpoints against v1. The gain transfers to aggressive
  and heuristic. This confirms the September 27 development result at
  similar magnitude.
- The claim is conditional on these three checkpoints, this parent, this
  budget and the roughly 80% v1 training mixture. Intervals cover
  evaluation seeds, not future training runs.
- The trained-over-parent improvement at the learned cadence is not
  established against aggressive (inconsistent across runs).
- Confirmation clears no parity, tactical, provenance, runtime-cost or
  promotion gate. All eight replication exports still fail unchanged
  preflight; preflight was not rerun because no model changed. Live v1 is
  unchanged.
- An every-tick runtime would be a separate product decision. It needs
  explicit approval, complete-path browser and reference-host profiling
  under the p95 ≤5 ms gate, and a production candidate that passes the full
  promotion process.

## Work after that experiment

First measure complete-path and rendered-browser cost for the unchanged three
learned-trained checkpoints under both controllers, following the
[runtime-cost plan](EDGER_RUNTIME_COST_PLAN.md). Prepare the bounded timing-only
reference-host request after validating that harness. Then prioritize the
concrete promotion blockers: repaired spell diagnostics and a reviewed tactical
proposal; then the parity contract and any precision fix.
Retain the historical league-regression attribution experiment (same parent,
equal updates, at least two runs per arm), but it need not delay a no-training
confirmation of the already-saved models. Re-scope the BC-control and
architecture ablations after these results. Review the whole accumulated
uncommitted diff before publication, then prepare fresh scaling/provenance and
a new immutable campaign prefix. The old recovery remains failed and immutable.

## Review validation

This review changes documentation and an ignored read-only verification script
only. It does not run training, confirmation matches, browser profiling,
cloud jobs or promotion. Earlier full-suite results (September 27: `npm test`
159/159 and `npm run test:edger-streaming` 14/14) are reported prior validation,
not fresh runs of this review.

From the repository root on September 28, 2026:

```bash
export PATH="$PWD/artifacts/edger-training/toolchains/node-v20.20.2-darwin-arm64/bin:$PATH"
PYTHON=/usr/local/bin/python3 PYTHONDONTWRITEBYTECODE=1 node --test tests/edger-v2-cadence.test.js
node artifacts/edger-training/experiments/20260928-cadence-review/verify.mjs
git diff --check -- progress.md docs/EDGER_REPLICATION_REVIEW.md
```

The targeted cadence suite passed 12/12, zero skipped, including the Python
learner tests. Its first Node launch exited 137; retry passed. Full `npm test`,
streaming, browser smoke and bot benchmark were not rerun because there is no
runtime, learner, simulation or gate change in this review.

The read-only verifier checked the 45 conditions used by the saved contrasts
(12,000 game records), model/report/source checksums, actual seed/side pairs,
winner-to-score conversion and reserved-seed separation. All 132 per-run and
run-averaged mean/95% interval comparisons matched exactly using the existing
bootstrap implementation. This is a recomputation of saved results, not an
independent replay of the matches. The nine fixed-trained/learned-evaluation
conditions unused by those contrasts were outside this numerical check.
The tactical helper defects were also reproduced directly: global index 1
was labelled Arrows instead of Giant, and its placement-mask collection was
`Uint8Array([0,0,0,0,0,0,0,0,0])`.
