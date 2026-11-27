# Measurement repair review — October 6, 2026

The verified outside-iCloud repair copy has no blocking defect in the reviewed
measurement repairs. Proceed with fresh staging, verified-copy full/targeted
tests and headless live smoke. Hold the full headed validation and headed
measurement dry run until the owner has reserved the display. This decision
does not admit profiling, freeze the repaired code or review the accumulated
learner/runtime/evaluator diff.

## Reviewed behavior

- Each complete-path model is parsed separately for diagnostic, production and
  observed paths. Model/layer sharing is refused before calls. The loader's
  validator does not populate the policy caches; the first timed call still
  performs its own cached validation and convolution-kernel construction.
  This is cold model-cache work, not independent cold JIT startup.
- Browser windows must reach the admitted endpoint exactly. Catch-up overshoot
  is incomplete, preserving the uncapped drain loop. GC pair admission checks
  both windows, the common endpoint and both behavior hashes.
- Node windows require full, non-truncated coverage. Pair admission compares
  ordered plan and coverage hashes. The worker retains partial output and
  returns incomplete for the review's zero-coverage and unequal-prefix cases.
- Every complete path classifies decisions. The observed outer timer covers
  the opening through closing hook, and GC scope includes harness bookkeeping.
- The complete-path and measurement schemas are v2. The predecessor pin matches
  the preserved `800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5`
  freeze. The entire measurement configuration equals the predecessor's:
  28 rendered conditions, weights/controllers/order, 60 s Node windows and
  the 3 h total cap remain unchanged. Live v1 retains its `895d5541…` hash.

One P3 procedural correction: fresh expectations cannot have the predecessor's
`d0c0d9f0…` file hash, because `expectCommand` records a new timestamp and Git
provenance. Compare deterministic bank/match results and their model, seed,
live-v1 and bank bindings with the predecessor, then pass the fresh artifact's
actual SHA-256 to `restage.sh`. Do not rewrite provenance to preserve a hash.

## Independent validation and limits

Review files are in
`~/edge_royale-runs/20261006-runtime-cost-measurement-repair-review.noindex/`
(`Q`). The repair copy is
`~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex/test-copy`
(`C`). The pinned Node (`N`) is
`~/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node`.

```bash
# From Q:
python3 audit.py > audit.json
$N worker-controls.mjs > worker-controls.json
$N plan-controls.mjs > plan-controls.json
# From C:
$N --test --test-name-pattern 'complete path:|browser GC pairs need|windowed matches must end' tests/edger-v2-runtime-cost-browser.test.js
```

- All 139 saved copy hashes match manifest `1c87c620…`. Saved logs confirm
  213/213 full and 66/66 targeted tests. The mutation record reports five
  passing baseline groups and eight detected reversions; those mutations were
  inspected, not rerun in this review.
- Focused rerun: 6 passed, 35 skipped, zero failures, 6.074 s.
- Nine synthetic controls execute the actual nested worker pair-recording
  functions: valid pairs pass; missing/failed partners, tick 1200/1201,
  mismatched hashes, zero coverage and unequal truncated prefixes fail. Both
  partner records receive the pair verdict; partial Node file links survive.
  These controls replace child/match I/O and do not exercise Chromium or the
  supervisor end to end. The fresh headed dry run remains required.
- `plan-controls.mjs` confirms the unchanged configuration and predecessor/live
  hashes. No durations from the controls are interpreted as cost evidence.
- Current repository comparison, reads of the latest plan/backlog, and
  `git diff --check` stalled on dataless iCloud files. The attempts were stopped;
  their results are unverified. This review covers the saved repair copy.
  Verify fresh staged sources against that copy before accepting its gates.
- The `progress.md` refresh also stalled when that file became dataless. Its
  attempted update was stopped before any write. `Q/update-progress.py` retains
  the prepared update for after iCloud reads recover; unresolved handoff text
  has been preserved. The review is recorded in this document meanwhile.
- Full tests, live smoke, headed validation, dry run and freeze were not rerun.
  No profiling, browser download, cloud action, Git staging or commit occurred.

After the headed gates, create and review a new freeze linked to `800e6dc5…`.
Only then perform fresh Spotlight, free-space and quiet-host checks before the
bounded measurement. Occupied swap alone does not establish active contention;
record memory pressure and swap-in/out deltas over a quiet interval.
