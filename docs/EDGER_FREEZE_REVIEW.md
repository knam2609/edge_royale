# Repaired successor freeze review — October 8, 2026

Accept freeze `75dd33fe645a02721ce14aea69d0241d2016a2bca8127aa56e0f43a59c5f212c`
and its bound validation/dry-run evidence. No blocking code or evidence defect
was found in this review. The independent freeze review is complete.
**Measurement remains unadmitted because the current host is not ready.**
This review covers the repaired runtime-cost bundle, not the accumulated
learner/export/evaluator diff or any promotion gate.

## Evidence checked independently

Run `M` is
`~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex`.
Review `Q` is
`~/edge_royale-runs/20261008-runtime-cost-freeze-review.noindex`.
Pinned Node `N` is
`~/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node`.

- The read-only freeze has the stated full hash. Its predecessor still hashes
  to `800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5`.
  Every report, supervisor, gates-file and gate-log binding verifies.
- All 1,920 `out/SHA256SUMS-headed-freeze` entries and all 15 fresh-gate entries
  verify. The headed manifest covers every validation and dry-run file.
- All 607 staged files match closure `ecb846b0…`; there are no added files or
  links. The 139-file test copy matches reviewed manifest `1c87c620…`. All 47
  shared stage/copy paths match; all other staged source is generated or
  recorded as provenance from the reviewed copy. Current tested repository
  files differ only in the plan and backlog. Those documents are not read by
  tests. The repository, test-copy and stage-provenance stagers are identical.
- `checkFreezeInputs` returns zero problems, rechecking the durable Node and
  the executable/full-tree Chromium pins. The two diagnostic page files were
  reproduced in memory from the pinned live sources and guarded substitutions.
- Independent field comparison reproduces `out/freeze-comparison.json`:
  `measurement`, `rendered_matrix` (all 28 conditions and order), `run`,
  `live_v1`, `limits`, `deadlines` and the freeze schema are equal to the
  predecessor. Only the declared metadata, reports, gates, stage, stager,
  predecessor link and two result schemas differ. Expectations differ only
  in their generation timestamp and tracked-diff provenance. Live v1 retains
  its `895d5541…` artifact hash.
- All 122 saved matches equal Node on schedule hash, counts, decision kinds,
  opponent decisions, stream/state hashes, result and overtime start. This
  includes 16 live-v1 baselines and all eight real-time matches (ticks 6,000
  and 5,817). Four banks each record 59 states, 708 decisions, 354 production
  checks and zero mismatches. Real-time display admissions pass, with no
  monitor violations, page errors, visibility events or CPU lower bounds.
- Both supervisors record completion, exit zero, worker reap and verified
  cleanup with no remaining owned processes. Saved test logs confirm 213/213
  full and 66/66 targeted tests; the unchanged-live smoke log passes.
- The dry run covers its eight declared items. The complete path is 60/60,
  untruncated, with nine per-path/model first calls. Ordered coverage hashes
  were recomputed from saved combinations. The Node GC pair is 4/4 in each
  window with equal plan/coverage hashes. Both browser GC records carry the
  complete pair verdict, endpoint 200 and equal stream/state hashes; all four
  dry-run rendered/window records pass endpoint and display checks.
- Both saved native visible captures were inspected independently. Desktop
  (2560×1600) and portrait (780×1688) show the whole viewport.

The audit passes 4,880 checks with zero problems. Eleven focused tests pass,
30 are intentionally skipped, zero fail (6.641 s). The nine existing synthetic
worker controls were rerun against the verified copy, including missing/failed
partners, unequal endpoints/hashes and zero/unequal truncated coverage. All
controls produce the required admission verdicts. They replace child/match I/O;
they are not browser failure runs or timing evidence.

## Fresh host observations and decision

On October 8 local (October 7, 13:29:50–13:31:24 UTC), after review tests and
audits completed, three observations covered 94.4 seconds without a profiling
or validation workload. No user app was closed; existing app/agent activity
remained. This interval establishes failure of current host admission, not a
certified idle baseline or attribution to a particular app.

- Spotlight exclusion passes: the ordinary sibling control is found by both
  filename and content, while the identical sentinel inside `M` is absent from
  both searches. Both owned sentinels and the ordinary control directory were
  removed. No global indexing setting was changed.
- Available disk space is 15.54 GiB, above the 3 GiB admission minimum.
- Pressure stays at level **2** in all three observations. Swap counters rise
  by **27,258 pages in / 26,404 pages out** (425.9 / 412.6 MiB at 16,384 bytes
  per page); pageouts rise by 900 pages. Occupied swap alone is not the reason
  for refusal: pressure and active swapping are observed together.
- The laptop is on **battery**, with the lid open. The frozen run requires AC.
  Load, swap occupancy and process snapshots are retained in `Q/host-check.json`.

Next steps, in order:

1. Connect AC and prepare a clean session; a reboot is reasonable given the
   persistent pressure and active swapping. Closing unrelated user workloads
   or rebooting was not performed by this review.
2. Recheck the durable Node/browser/stage pins after any reboot. Immediately
   before measurement, repeat the Spotlight control, disk check (≥3 GiB), and
   a quiet interval recording load, pressure and swap-in/out deltas. Do not
   admit while level 2 pressure or active swapping persists. Existing swap
   occupancy by itself is not disqualifying.
3. Reserve about two uninterrupted hours of display, with the lid open and no
   app switching. Run only the frozen command once, with a fresh output
   directory, a three-hour total cap, 2 GiB running reserve, 1 GiB output cap,
   one active process/page and no retries. Preserve all incomplete conditions,
   including catch-up overshoot. The untouched reviewed wrapper is:

   ```bash
   # Only after host and display admission; M as above. Output M/measurement must be new.
   cd "$M/out"
   ./measure.sh stage measurement full 10800
   ```

No restaging, new freeze, full headed validation or extra dry run is needed
solely because the host is cleaned or rebooted, provided every durable pin
still matches. A changed harness, model, controller or measurement plan needs
a newly validated successor. After the local report, continue the runtime
review and prepare the separately approved reference-host request.

## Reproduction and limits

```bash
# From Q:
python3 audit.py > audit.log
$N freeze-check.mjs
$N worker-controls.mjs > worker-controls.json
# From M/test-copy:
$N --test --test-name-pattern 'freeze:|complete path:|browser GC pairs need|windowed matches must end' \
  tests/edger-v2-runtime-cost-browser.test.js > "$Q/targeted-tests.log" 2>&1
# From Q, the admission observations (not a timing run):
python3 host-check.py start
python3 host-check.py sample
python3 host-check.py finish
```

`Q/SHA256SUMS` checksums the review scripts/results. The full `npm test`, live
smoke, headed validation and dry run were not rerun: this session changes
documentation only and verifies their frozen records. The dry run covers only
one pair of each GC kind; browser/process failure cases remain unit/synthetic
coverage. Sampled focus monitoring cannot detect an excursion entirely between
polls. First calls measure cold model caches, not independent cold JIT starts;
GC scope includes harness bookkeeping. Traced timings must stay separate.

No profiling, app closure/reboot, download, cloud action, Git staging or commit
occurred. Both frozen bundles remain unchanged.
