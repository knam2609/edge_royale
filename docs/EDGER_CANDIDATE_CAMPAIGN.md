# Edger v2 candidate campaign review — November 22, 2026

After the [gate decision](EDGER_GATE_REVIEW.md) of November 20, the open
bottleneck is the fresh-provenance task in `progress.md`: no model exists
that could be promoted, even if it is strong enough. This review proposes how
to produce one, for the owner's decision.

**Status: run once on November 23, 2026; the selected run passed every gate
of the full evaluation** ([result](#result-november-23-2026)). **On November
25, 2026 the owner approved promoting it**
([decision](#owner-promotion-decision-november-25-2026)). It was promoted on
the local review branch `edger-v2-promote-c3`, which the owner accepted into
`edger-v2-accumulated` on November 26 ([merge](#merge-november-26-2026)).
Nothing is pushed, so `main` and the remote keep live v1. The owner approved
the design that day with one change (see
[Owner decision](#owner-decision-november-23-2026)). The proposal below is kept as
written at HEAD `6a522e8`; where it differs from the decision, the decision
wins. Every number below is read from saved outputs or from that code.

## Owner decision (November 23, 2026)

The owner adopted the decision review's recommendation: L with 12 runs, a
fresh final evaluation seed, and the refusal guard first. The measured recipe
and every evaluation gate are kept. The selected model gets one attempt, and
promotion remains a separate decision.

1. **Path: L.** The data-scaling proof applies to the production training
   path (it gates league training), not to promotion. The README and
   `docs/EDGER_TRAINING.md` now say so.
2. **Candidate label: yes, for the selected export only.** It is labelled
   `shadow_candidate_unreviewed` only after its lineage is verified against the
   frozen manifest. The label binds the selected checkpoint, the manifest hash
   and the exact export bytes, so a metadata edit alone cannot qualify an old
   diagnostic. Unselected runs keep `diagnostic_only_not_promotable`.
3. **Runs: 12.**
4. **Selection: as proposed.** The equal-weight mean of the scores against
   live v1, the heuristic and aggressive, on the same 100 side-swapped seed
   pairs per opponent for every eligible run. Ties go to the lower run index.
5. **Evaluator seed: replace `20260718`.** Reconstructing the September
   schedules at `0270d82` showed that the `20260718` full schedule contains
   all 500 of September's league-training match seeds, including 167 of its
   400 champion evaluation pairs (scheduler: `tests/edger-league.test.js`;
   evaluation schedule: `buildEdgerV2EvaluationSpecs` in
   `scripts/edger-v2-evaluation-core.mjs`). A new seed is frozen before any
   candidate output. The actual generated match seeds are checked for overlap
   with training, development, selection and archived evaluation. The full
   profile and every threshold are unchanged.
6. **No second pick.** A failed gate ends the campaign; the report is kept.
7. **Guard: yes, separately and first.** Implemented November 23:
   `edger:evaluate:v2 --profile full` and `edger:promote:v2` refuse
   `diagnostic_only_not_promotable`. A test shows promotion refusing a
   diagnostic export whose report matches and otherwise passes, while the same
   model with a candidate label promotes.

## Result (November 23, 2026)

Run directory `CC` = `~/edge_royale-runs/20261123-candidate-campaign.noindex`
(`README.md`, `plan.md`, 21,665-file `SHA256SUMS`). The source was the clean
commit `567ec98` (campaign tooling `4ac6bc1` plus a manifest robustness fix).
The design was frozen in `FROZEN.txt` (81 files) at 05:15:27Z, before any
campaign output.

**Frozen before output:**
- training plans r30–r41: the ninth's 43 plans reproduced byte for byte, then
  r30–r41;
- final evaluator seed **758784396**: the first labelled candidate
  (`edger-candidate-final-evaluation-20261123`) whose 5,650 full-schedule and
  100 reference match seeds miss a 281,954-seed ledger. The ledger holds the
  frozen suites (including September's league schedules and the `20260718`
  suite), the 507 plan files under `~/edge_royale-runs`, 13,240 recorded seed
  values, and generator reconstructions of every default seed in the scripts;
- 100 selection seeds (`edger-candidate-select-20261123`), outside the ledger,
  r30–r41 and the final evaluation.

**Disclosed:** one r30 training seed equals a value of the precautionary
20260927 stream reconstruction. The scripts use that stream only for
opponent-allocation draws, and the value is in no plan or record. r30–r41 are
disjoint from every plan file, the frozen suites, every recorded seed and the
match-schedule generators.

**Run:** one launch, 05:15:34Z–06:32:08Z (76.6 min), exit 0, with no retry,
cap or failure.
- QA (295/295 and the browser smoke) ran at the campaign commit before
  training.
- All 12 BC parents and all 12 runs completed on the first attempt (1,536
  updates each).
- All 12 lineages were valid, and all 12 runs were eligible.

Selection means against live v1, the heuristic and aggressive (200 games
each): mean 0.869, SD 0.040, range 0.793–0.918. The eighth's A children
scored 0.851 mean on the reused development seeds.

**c3 was selected** (0.905, 0.955, 0.895; mean 0.918) and exported as
`edger_v2_candidate_20261123-L_c3` (SHA-256 `26a56150…`, binding in
`CC/candidate/binding.json`).

**Full evaluation (seed 758784396, full profile): passed, no gate failed.**

| Gate | Result |
|---|---|
| Champion (live v1, 800 games) | 0.900, paired-bootstrap lower bound 0.880 (blocks 0.895, 0.905) |
| Heuristic (200 games) | 0.935, lower bound 0.900; live v1's reference at this seed 0.520 |
| Frozen league | +0.415 over live v1's reference mean |
| Weak baselines | random 1.000, aggressive 0.910, defender 1.000 |
| Safety | 10,000 games, 0 illegal actions; 100 replay checks |
| Parity, timing, size | max logit difference 1.9e-6; p95 1.40 ms (budget 5 ms); 36,946 actor parameters |
| QA | `npm test` and browser smoke reports at `567ec98` |

**Reported, not gates**, for the promotion review:
- tactical aggregate 0.236 against the heuristic's 0.852: defense 1.000, spell
  value 0, tower finishing 0, elixir punishment 0, pocket pressure 0.180;
- held-out Fireball bank: 0/27 lethal and 0/53 cluster;
- in the evaluator's 1,300 non-safety games, the candidate plays its five
  cheap troops about five times per game each, Arrows 0.016 and Giant 0.005
  times per game, and never Fireball. It captured none of its 614 lethal or
  1,370 cluster Fireball opportunities.

The design expected the Fireball and Giant result (see Limits); the owner
accepted it on November 20. Promotion stays a separate owner decision, with an
unmerged review PR that keeps live v1 until accepted.

## Owner promotion decision (November 25, 2026)

The owner approved promoting c3. It was promoted on the local branch
`edger-v2-promote-c3`, cut from `edger-v2-accumulated` at `d53fdf8`. The
branch stayed unmerged and unpushed, with live v1 live everywhere else, until
the owner accepted it on November 26 ([merge](#merge-november-26-2026)).
Publishing it needs the owner's separate push/PR approval.

**Binding checked by hand first**, since `edger:promote:v2` does not. A
read-only script ran in `CC/repo` (clean at `567ec98` before and after) and
passed 16/16 checks:
- `verify_candidate` re-derived c3's lineage from disk against the manifest
  and selection;
- the candidate's SHA-256 `26a56150…` equals `binding.json` and the report's
  `candidate_artifact_checksum`;
- `training.campaign` equals the manifest (`df3c0c8e…`), the selection
  (`8842e628…`), run c3, the final checkpoint (`1c6ddeb0…`, iteration 23) and
  the BC parent (`29cc6df5…`);
- the export's weights equal c3's final `model.json` and the binding's
  weights hash;
- the label is `shadow_candidate_unreviewed`, the campaign is `20261123-L`
  (not the smoke), and the report is a full profile at seed 758784396 with
  promotion passed.

`CC`'s `FROZEN.txt` and `SHA256SUMS` both verify. The export's
`diagnostic_provenance.note` reads "dirty worktree by design". That is fixed
text from the cadence script; the recorded diff and untracked-file hashes are
those of empty input.

**Promotion:** `npm run edger:promote:v2 -- --model CC/candidate/candidate.json
--report CC/evaluation/evaluation-report.json` exited 0 and printed the
reported measures. It wrote:
- `artifacts/edger-training/promoted/edger_policy_current.json`, now
  `26a56150…`;
- `edger_policy_current_report.json` and the new
  `edger_policy_current_reference.json`;
- `src/ai/generated/edgerPolicyCurrent.js`.

The browser, `selectBotDecision` and the evaluator's default champion now use
c3. The live path enumerates c3's full grid and uses its learned delay.

**Live v1 retired, kept byte for byte** in
`artifacts/edger-training/retired/edger_policy_bootstrap_20260701/`: the
artifact `895d5541…`, its report, and the generated module `69333cd5…`.
Nothing in `src/` imports them.

**Tests that assumed v1 was live** (8 of 295 failed after promotion):
- Four `tests/bot-runtime.test.js` tests exercised the v1 ML path through
  the live model. They now use the retired v1 artifact, and the live-model
  test checks c3's live path on production matches.
- The October runtime-cost study pins the live module as v1 (`LIVE_V1_PIN`),
  and its v1-baseline driver refuses a v2 live module by design ("the live-v1
  baseline is undefined"):
  - its freeze tests now stage the retired module;
  - the expectations test checks the v2 part and the refusal;
  - the v1-baseline driver test now checks the refusal.

  The study's v1-baseline measurement can no longer run from this tree; a
  clone of `d53fdf8` still runs it.

**Validation on the branch:**
- `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2`: 297/297,
  which adds a v1-model legality test and a warm-up check of the live model.
- `npm run smoke:browser`: passed.
- `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30
  --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`: passed at 1.000
  (30-0), 1.000 (30-0) and 1.000 (29-0, 1 draw).
- The bot spec's benchmark with `edger_heuristic` added passed, at 0.867
  (26-4) against the heuristic and 1.000 against the rest;
  `npm run edger:canary -- --seed 20260718 --canary-ticks 80` passed.

**The benchmark does not play c3 the way the browser does.** The gate runs
Edger through `selectBotAction`: the legacy shortlist, a one-tick delay and
the single-tower benchmark arena. The same harness, a scratch copy with Edger
on `selectBotDecision` (its own delay and full grid), gave:
- 26-0-4, 20-0-10 and 14-0-16 (every resolved game won);
- 16,743 decisions and 3,684 plays: Musketeer 662, Goblins 751, Archers 734,
  Mini PEKKA 731, Knight 749, Arrows 57, and no Giant or Fireball.

On that arena the decoder's tile centres (for example 0.5, 1.5) are not in
the arena's integer-coordinate full-grid list. The engine accepted every play
in a 28-play check by spending the elixir. On the production arena every
live-path play is in the model's list (11/11 in a check, and the new test).

**Findings for follow-up (not changed in the promotion):**
- Several internal callers still play the `edger` bot through
  `selectBotAction` with the legacy shortlist and the one-tick delay:
  - `src/ai/benchmark.js`;
  - the cadence tooling's `edger` opponent (training plans and selection);
  - `scripts/edger-collection-core.mjs`.

  After promotion they all play c3 that way, not as it plays live. Future
  comparisons and corpora that name `edger` therefore face a different
  opponent than live v1 or live c3. To play live v1, pass its retired artifact
  as a model opponent.
- The weaknesses reported at evaluation are unchanged:
  - no Fireball, almost no Giant or Arrows, tactical aggregate 0.236;
  - runtime accepted only on this desktop Mac;
  - no play against humans.

### Merge (November 26, 2026)

The owner accepted the review branch: `git merge --ff-only
edger-v2-promote-c3` moved `edger-v2-accumulated` from `d53fdf8` to the
promotion commit `f89c1c2`. The fast-forward adds no changes, so the tree is
the one validated above. c3 is live on `edger-v2-accumulated`. Nothing is
pushed: `main` and the remote still run live v1, and publishing needs the
owner's separate push/PR approval after the full diff review. The findings
above are still open.

## Summary

- **No candidate exists, and the best recipe's children cannot be one.** The eighth comparison's 12 A children (full-grid, reward v1, `train-arm`, 1,536 updates) average 0.851 on the primary score (SD 0.033, range 0.807–0.910). Against live v1 they score 0.74–0.93 and against the heuristic 0.79–0.98. But they were trained on reused seed plans and judged on development seeds that every comparison used, and their exports are labelled `diagnostic_only_not_promotable`.
- **The production path would not use that recipe.** The cloud campaign trains with the production learner. On identical refreshed data, that learner cost −0.098 [−0.159, −0.036] against `train-arm` (third comparison). It also needs the 10,000-game corpus, a fresh data-scaling proof and several hours of `c7g.4xlarge` time against the A$10/month whole-account budget.
- **Recommendation: a local candidate campaign that repeats the measured recipe on fresh parents and seeds** (option L below). It trains 12 end-to-end runs, picks one by a rule frozen in advance on a new seed set, then runs the unchanged full evaluator on that run alone. Estimated cost is 3–4 hours on this host and nothing in the cloud. Promotion stays a separate approval.
- **Gap found: the "never promotable" label is not enforced at promotion.** Neither `edger:evaluate:v2` nor `edger:promote:v2` reads `training.promotion_status`. A diagnostic child with a passing full report and matching QA reports could therefore be promoted. The label is honored only by convention. Closing this is recommended whatever the choice below. **Closed November 23** by the guard (decision 7).

## What promotion needs today

`edger:promote:v2` (`scripts/edger-v2-promote.mjs`) checks:
- the report schema (`edger_v2_evaluation_report_v2`) and the `full` profile;
- the model ID and artifact checksum;
- the three reported sections;
- every required gate, with `promotion.passed`.

It does not check how the model was trained.

The report comes from `edger:evaluate:v2 --profile full`:
- **preflight:** parity, timing, schema and size, and the reported-measure inputs (`skill_report_inputs`, which needs the frozen bank);
- **match gates:**
  - champion: 800 games against live v1, score ≥ 0.535 and paired-bootstrap lower bound > 0.5;
  - heuristic: lower bound ≥ 0.45, and at most 0.03 below live v1's reference score;
  - weak baselines (random, aggressive, defender): ≥ 0.65 each;
  - frozen league: ≥ 0.02 over live v1's reference mean;
  - 10,000 safety games and 100 replay checks;
- **external:** `npm test` and browser-smoke reports whose `git_commit` equals the candidate's `training.git_commit`.

The reference comes from `edger:reference:v2` on live v1. The production
driver (`scripts/edger-production-campaign.mjs`) uses evaluator seed
`20260718`.

The production driver is the only path that writes campaign provenance today:
`full-cache` → `offline` → scaling → league → `qa` → `full-evaluation`. It
runs on `c7g.4xlarge` with an S3 prefix.

`train-arm` (`scripts/edger-v2-cadence-experiment.*`) is documented as local
and never promotable. Its checkpoints use a diagnostic schema that production
`load_checkpoint` rejects, and its exports carry
`promotion_status: diagnostic_only_not_promotable`. The exported actor itself
is an ordinary v2 model. The live runtime accepts the full-grid action space
(`src/ai/v2/policy.js`), and the sixth comparison's full-grid r6 child already
passed the evaluator's preflight on November 20, using the smoke profile.

## The measured recipe

Each element was chosen by a frozen comparison or an owner decision:

| Element | Choice | Source |
|---|---|---|
| Rollouts | refreshed every 64 games | first and second comparisons (owner, November 6) |
| Learner | `train-arm`, not the production `vtrace` path | third comparison; factorial (owner, November 10) |
| Placement | full grid | sixth comparison; adopted for training (owner, November 13) |
| Reward | `edger_potential_reward_v1` | fifth and seventh comparisons (frozen rule) |
| Opponent mix | plan: live v1 and heuristic, no snapshots | eighth comparison (frozen rule) |
| Updates | 1,536 (24 iterations × 32 pairs) | second comparison onward |
| BC parent | `bc --epochs 6`, default recipe, on the 160-episode September 21 subset (v4 cache) | pilot and `FR` |

The eighth's arm A is this recipe exactly. It ran `initialize-full-grid` from
the BC parent, then `train-arm --cadence learned --iterations 24
--pairs-per-iteration 32 --workers 6 --torch-seed 20260926 --reward
edger_potential_reward_v1 --prune-episodes`. All 12 children completed and
passed parity, with zero illegal attempts.

**Not measured:**
- BC on the full corpus;
- more than 1,536 updates;
- any torch seed other than `20260926`;
- the children against random (the weak-baseline gate includes it);
- the children against humans.

## Options

- **P. Production cloud campaign** (the [September plan](EDGER_EVALUATION_DIAGNOSIS.md#exact-next-cloud-plan--not-authorized-or-dispatch-ready), updated).
  - It needs:
    - fresh BC and scaling on the unchanged frozen corpus under the current code, with a new SHA and S3 prefix;
    - a bounded cloud pilot;
    - then production learning and full evaluation, each separately approved.
  - It keeps the existing provenance machinery unchanged.
  - Costs:
    - It trains with the learner the third comparison measured as worse, and the September campaign's candidate regressed under it.
    - The full evaluation alone has a 180-minute ceiling.
    - Admission is pending the cloud budget.
    - Under the November 20 repair, any league run needs fresh rollout lineage.
  - Not recommended now.
- **L. Local candidate campaign with the measured recipe.** Recommended. Design below.
  - It promotes nothing by itself. It changes one rule: the frozen campaign path may produce a model labelled as a candidate.
  - It skips the production data-scaling proof. That proof only gates production league training, not promotion. Without it, the evidence for L is the match gates.
- **L+. L with a BC parent trained on the full corpus.**
  - This changes BC, which no comparison has measured. Under the comparison rule, it needs its own end-to-end design first.
  - Not recommended for the first candidate.

## Recommended design (L), for approval

**Source and prefix.**
- The implementation below is committed locally, not pushed, as one reviewed SHA.
- The run directory `CC` = `~/edge_royale-runs/<date>-candidate-campaign.noindex` holds a clean clone at that SHA and serves as the campaign's immutable prefix.
- `plan.md`, the runner, the inputs and their checksums go into `FROZEN.txt` before any candidate output. `SHA256SUMS` is written after the run.

**Runs.**
- 12 end-to-end runs, c1–c12. Each run:
  1. trains its own BC parent with `FR`'s command on the same v4 subset cache: `bc --seed <s> --epochs 6`;
  2. runs `initialize-full-grid`;
  3. runs `train-arm` with arm A's flags, on its own training plan.
- Nothing else changes.

**Seeds.** Every set is new and checked for disjointness before the freeze:
- **BC seeds:** 20260748–20260759. Used so far: 20260718–20260735 (pilot and `FR`); 20260736–20260747 are reserved by the ninth's unlaunched Stage 2.
- **Training plans:** `replicate-seeds` replicates r30–r41 of the existing derivation. Before the freeze, a disjointness check runs over every `seed-plan-*.json` and replication plan under `~/edge_royale-runs`, as the ninth did. r18–r29 are the ninth's.
- **Selection seeds:** a new labelled set, for example `edger-candidate-select-20261122` with 100 seeds. It must be disjoint from:
  - the frozen suites (which include the evaluator's `20260718` stream);
  - every earlier plan, including the spent confirmation set `edger-cadence-confirm-20260927`.

**Eligibility and selection, frozen before output.**
- A run is eligible if it:
  - completes all 1,536 updates;
  - passes the JS/PyTorch parity check the comparisons used;
  - makes zero illegal attempts in its selection games.
- Each eligible run plays 100 seed pairs (200 games) against each of live v1, the heuristic and aggressive, on the selection seeds.
- The run with the highest mean of the three scores is selected. Ties go to the lower run index.
- Every run's result is recorded, including poor and ineligible runs.
- The selection games never use the evaluator's seeds.

**Final evaluation.** The selected run alone is evaluated:
- `edger:evaluate:v2 --profile full --seed <new frozen seed>` (the owner replaced `20260718`; see decision 5);
- with the QB bank;
- with a live v1 reference from `edger:reference:v2`;
- with QA reports written only after `PYTHON=/usr/local/bin/python3 npm test` and `npm run smoke:browser` exit 0 at the campaign SHA;
- with `--reference-hardware "Mac mini M6 (Mac18,5)"`.

**No second pick.**
- If the selected run fails any gate, the campaign ends as failed and is kept unchanged.
- A new attempt needs a new design and prefix.
- Evaluating a runner-up would turn the full suite into a selection set.

**Output.**
- The report, with its reported measures (tactical, bank, in-match card usage and Fireball capture), goes to the owner.
- Promotion stays a separate decision (Next Tasks: manual promotion with an unmerged review PR).

**Cost estimate.** These come from `FR` and `SL` wall times. Those hosts were sometimes shared, so the times are not cost evidence.

| Stage | Estimate |
|---|---|
| BC | about 3 min per run, so 36 min for 12 |
| `train-arm` | about 7 min per run; two at a time, about 45 min |
| Selection games | about 3.6 min per run (600 games, 6 workers), about 45 min |
| Full evaluation | 11,300 games, about 50–80 min |
| `npm test` and browser smoke | a few minutes |
| **Total** | **about 3–4 hours, local only** |

## Implementation needed after approval, before the freeze

1. **Guard (recommended under any option):** `edger:evaluate:v2` and `edger:promote:v2` refuse a model whose `training.promotion_status` is `diagnostic_only_not_promotable`, with tests. **Done November 23** (the evaluator refuses under the full profile; smoke diagnostics stay allowed).
2. **Campaign export** (decision 2: the selected run's export only, binding the checkpoint, the manifest hash and the exact export bytes):
   - It labels a `train-arm` checkpoint `shadow_candidate_unreviewed` only when its lineage matches the frozen campaign manifest:
     - the clean campaign SHA;
     - the BC parent's checksum and command;
     - arm A's flags (learned cadence, `full` loss, reward v1, no card KL, no opportunity weight, no warm start, plan mix, 24 × 32 pairs, full grid);
     - the iteration chain of collection and checkpoint hashes.
   - It records the campaign ID and the manifest hash in `training`.
   - It refuses anything else.
   - **Done November 23:** `candidate-manifest` and `export-candidate` in
     `scripts/edger-v2-cadence-experiment.py`
     ([commands](EDGER_TRAINING.md#decision-cadence-diagnostic-local-only-never-promotable)).
     The manifest is written once, after training and before selection, so the
     selection and the export bind its hash.
3. **Final evaluation seed (decision 5):** pick a new seed and check the match seeds its full schedule actually generates against every training, development, selection and archived evaluation input, including September's league schedules and the `20260718` suite. Freeze it before any candidate output. **Tooling done November 23:** `edgerV2EvaluationScheduleSeeds` and `edgerV2ReferenceMatchSeeds` (`scripts/edger-v2-evaluation-core.mjs`) give the exact seeds; the pick is the run directory's seed ledger.
4. **Selection seed set:**
   - a labelled derivation and plan schema for a candidate-selection set;
   - `evaluate --seed-set selection`;
   - the same frozen-suite and cross-plan exclusions as `confirmation`.
   - **Done November 23:** `selection-seeds` and `evaluate --seed-set selection`, which also refuse the final evaluation's seeds.
5. **QA reports:** a local writer of the driver's `edger_external_qa_report_v1` reports, run only after the commands exit 0. **Done November 23:** `scripts/edger-qa-report.mjs`.
6. **Run directory:**
   - `plan.md`, the runner and a dry run of the selection rule on synthetic results;
   - a smoke on an out-of-population parent (`b0-s20260718`), never a campaign run;
   - then the freeze.
   - **Done November 23** ([result](#result-november-23-2026)). The dry run passed 11/11 cases. The smoke ran the runner end to end: BC seed 20260718 at the campaign commit, one injected kill and resume, a deliberately failing second run, and the smoke evaluation profile.

## Questions for the owner

1. **Path:** L (recommended), P, or L+?
2. **Promotable label:** may the frozen campaign path label its export `shadow_candidate_unreviewed`, so that it can reach promotion review?
3. **Runs:**
   - 12 (recommended);
   - or 4 (cheaper; about 0.01–0.02 lower expected primary score than best-of-12). This is modeled from the eighth's run SD of 0.033, of which about 0.02 is its own evaluation noise, and a selection noise of about 0.015.
4. **Selection:** the three-opponent mean on 200 games per opponent, or another rule?
5. **Evaluator seed:** keep `20260718`, the production contract? It was never used for training or recipe selection. It was used for the failed September candidate's full evaluation and for smoke-profile prefixes on non-candidates.
6. **No second pick:** confirm.
7. **Guard:** implement it now, separately from the campaign?

## Limits

- The candidate trains against live v1 and the heuristic, and is selected against them and aggressive. Human play is untested.
- BC uses 128 training episodes. There is no data-scaling proof, so the evidence is match results only.
- Training is not bit-reproducible across hosts. The campaign binds the host, Node and Python provenance.
- The timing gate is measured on this host. Mobile, 120 Hz and reference-host runtime costs are not accepted ([local constraints](EDGER_LOCAL_CONSTRAINTS.md)). That is a promotion question, not a campaign one.
- A promoted Edger from this recipe would probably cast no Fireball and rarely play Giant. The eighth's A children cast none in 3,600 primary games and played Giant 0.17 times per game. The owner accepted this on November 20.

## Validation

Docs only. Read-only sources:
- `SL/arms/A-r*/{edger,edger_heuristic,aggressive}.json` (`.summary.score`), and the eighth's `plan.md`, `run.py` and `runner.log`;
- `FR/run.sh` and `run.log`;
- `scripts/edger-v2-evaluation-core.mjs`, `scripts/edger-v2-promote.mjs` and `scripts/edger-production-campaign.mjs`;
- `scripts/edger-v2-cadence-experiment.{mjs,py}` and `src/ai/v2/policy.js`.

The guard gap was confirmed with `grep -rn promotion_status scripts src`: no
evaluator or promotion code reads the field. No test run was needed.

November 23 (guard): `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2`
passed 290/290, including the two new guard tests in
`tests/edger-v2-evaluation.test.js`. No training or matches were run for the
campaign.
