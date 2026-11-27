# Edger v2 tactical and Fireball gate review — November 20, 2026

The owner asked for this review on November 20, after the ninth comparison
closed. It examines the two preflight gates that every full-grid child has
failed: the tactical scenarios and the held-out Fireball bank.

**Owner decision, November 20: the strongest legal play is enough, and the
recommendation is adopted.** That means option C plus D as reported
diagnostics, and dropping the strict heuristic-aggregate rule. The
[implementation](#implementation-of-the-decision) follows the review below,
which was written before the decision. When written, no gate, scorer,
threshold, runtime, training code or frozen run had changed. Every number
below was computed read-only from finished, non-promotable models or read from
saved outputs.

- `GR` = `~/edge_royale-runs/20261120-gate-review.noindex/`: `gate-review.mjs`, `match-usage.py`, their outputs `gate-review.json` and `match-usage.json`, `README.md` (commands), and `SHA256SUMS` (5 files, list hash `e9634454…`).
- Inputs:
  - the eighth comparison's 12 final A children, 12/12 against `SL/SHA256SUMS`;
  - the sixth comparison's 12 full-grid children, each equal to the `model_sha256` in its three evaluations;
  - live v1;
  - the frozen QB bank, matching `QB/SHA256SUMS`.

## Summary

- **Both gates run before any promotion match.** A model that fails either one never plays the champion, anchor, weak-baseline or safety games, so the evaluator never measures its strength.
- **No policy has ever passed the tactical gate.** That includes the heuristic it is scored against (0.852), live v1 (0.522) and all 24 finished full-grid children (0.224–0.518). The heuristic scores 0 on pocket pressure, and the gate asks a candidate to beat the heuristic's own aggregate.
- **No policy passes the Fireball bank either.** The heuristic captures 20 of 27 lethal opportunities (0.741, below the 0.80 minimum), live v1 captures 8, and every child captures 0, without choosing Fireball even once.
- **The tactical gate makes spells mandatory twice.** Without Fireball or Arrows, the highest possible aggregate is 0.680, below the 0.852 a candidate must beat, before the spell floors apply.
- **The children's behavior matches what the gates see.** Over the eighth's RL, sampled Fireball fell from 0.79 to 0.06 per game and Giant from 1.89 to 0.37. Goblins, Knight, Archers and Mini PEKKA rose from 3.3–4.2 to 5.9–6.2 per game. The final children win almost entirely with the other six cards.
- **The skill the gates require is worth little to the training objective.** Forcing a capturing Fireball changed the match point by +0.029 (lethal) and +0.022 (cluster), both unresolved. Every floor that kept Fireball cost 0.06–0.16 in match score.
- **So the gates and the training objective disagree, and the gates decide first.** On development seeds, the eighth's A children beat live v1 by 0.740–0.930 (mean 0.808). Those seeds were reused by every comparison, so this is not promotion evidence; the gates stop the evaluator that would produce it.

## The gates as implemented

| Gate | What it scores | Pass rule | Origin |
|---|---|---|---|
| Tactical scenarios (`edger_tactical_scenarios_v2`) | 50 one-decision synthetic states: 5 categories × 5 variants × 2 sides. Each scorer rates only the immediate action; PASS scores 0. | Every category mean at or above its minimum (defense 0.70, spell value 0.70, tower finishing 0.80, elixir punishment 0.55, pocket pressure 0.55), **and** an aggregate strictly above the heuristic's on the same states. | Minimums and the heuristic rule date from July 4, 2026 (`2722bdc`, the daily-training automation) and have not changed. Proposal 4 (`16e36b4`, November 3) changed the scorers and states, not the thresholds. |
| Held-out Fireball (`heldout_fireball`) | 80 real test-split states from the QB bank (27 lethal, 53 cluster). A capture is a legal, correctly aimed Fireball. | Lethal ≥ 0.80 and cluster ≥ 0.70. | Proposal 4 (November 2). The tactical finishing and spell-value numbers were reused as rates: owner-chosen engineering targets, not fitted to any policy. |

Both run in `evaluateEdgerV2Preflight` (`scripts/edger-v2-evaluation-core.mjs`)
with parity and timing. Any preflight failure writes a rejected report with the
match gates skipped and no matches generated.

The match gates come after preflight:
- **champion:** 800 games, score ≥ 0.535, paired-bootstrap lower bound > 0.5;
- **heuristic and anchors:** lower bound ≥ 0.45, and no more than 0.03 below the champion's reference;
- **weak baselines:** ≥ 0.65 each;
- **frozen league:** improvement ≥ 0.02, with the worst anchor ≥ 0.45;
- **safety and replay:** 10,000 safety games and replay checks;
- **external:** the test suite, browser smoke and timing.

This review does not question any of these.

## Results

Tactical category means (`GR/gate-review.json`). For the children, the count
passing each minimum is in brackets. The ceiling is the best legal action in
every state (`evaluateScenarioFeasibility`).

| Policy | Defense | Spell value | Tower finishing | Punishment | Pocket | Aggregate | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| Minimum | 0.70 | 0.70 | 0.80 | 0.55 | 0.55 | > heuristic | |
| Ceiling | 1.25 | 0.96 | 1.15 | 1.00 | 1.15 | 1.102 | |
| Heuristic | 1.15 | 0.96 | 1.15 | 1.00 | **0** | 0.852 | fails: pocket, and cannot exceed itself |
| Live v1 | 1.15 | **0** | **0.46** | 1.00 | **0** | 0.522 | fails |
| Sixth full-grid children (12) | 1.00 [12] | **0** [0] | **0** [0] | 0.302 [4] | 0.288 [1] | 0.318 (0.224–0.518) | 0 of 12 pass |
| Eighth A children (12) | 1.00 [12] | **0** [0] | **0** [0] | 0.300 [4] | 0.193 [1] | 0.298 (0.224–0.518) | 0 of 12 pass |

Held-out Fireball bank (captures, with Fireball card choices in brackets):

| Policy | Lethal, of 27 (min 0.80) | Cluster, of 53 (min 0.70) | Gate |
|---|---:|---:|---|
| Heuristic | 20 [25], 0.741 | 40 [44], 0.755 | fails lethal |
| Live v1 | 8 [10], 0.296 | 22 [25], 0.415 | fails both |
| All 24 children | 0 [0] | 0 [0] | fail both |

The live v1 and heuristic counts reproduce the [proposal 4
baseline](EDGER_TACTICAL_REVIEW.md#rebaseline).

Children's per-card deployments per game in their primary evaluations
(`GR/match-usage.json`; 3,600 games per group against live v1, the heuristic
and aggressive):

| Group | Fireball | Arrows | Giant | Musketeer | Mini PEKKA | Knight | Archers | Goblins |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sixth shortlist control | ~0 | 2.59 | 0.74 | 3.55 | 5.89 | 6.17 | 6.05 | 6.33 |
| Sixth full-grid | 0 | 1.02 | 0.74 | 3.83 | 5.07 | 5.19 | 5.08 | 5.36 |
| Eighth A | 0 | 1.07 | 0.17 | 3.83 | 5.22 | 5.23 | 5.09 | 5.31 |
| Eighth B | 0 | 1.64 | 0.09 | 3.56 | 5.34 | 5.40 | 5.32 | 5.47 |
| Eighth A rollouts, iteration 0 (sampled parents) | 0.79 | 1.68 | 1.89 | 3.17 | 3.28 | 3.87 | 3.93 | 4.23 |
| Eighth A rollouts, iteration 23 (sampled) | 0.06 | 1.68 | 0.37 | 4.20 | 5.88 | 6.10 | 6.01 | 6.23 |

## Reading

1. **The gates are not calibrated against any policy that exists.** They predate every learned v2 model. Neither reference policy passes either gate. The [September 27 audit](EDGER_EVALUATION_DIAGNOSIS.md#tactical-suite-audit--september-27) already found that the suite "does not rank gameplay strength": v1 scored 0.451 against the heuristic's 0.873, while RL checkpoints that beat v1 at 0.76–0.78 (every-tick evaluation) scored 0.37.
2. **The heuristic rule asks for the heuristic's own choices.** On spell value, finishing and punishment the heuristic already picks the best-scoring action in every state. Its only losses are 0.10 per defense state and the whole pocket category, 12.5 of the 55.1 available points. A candidate must lose less than that.
   - Meeting every floor exactly averages only 0.66, so this rule, not the floors, is the binding one.
   - A candidate that never casts a spell loses at least 21.1 points, so its ceiling is 0.680.
3. **The pocket scorer encodes one strategic opinion.** With the left crown tower down, the heuristic and live v1 send a Giant to the other lane's bridge in all 10 states. The children deploy in the pocket in only 24 of their 240 states. Under the [rules](GAME_RULES.md), the pocket aims at the king tower, while the other lane goes for a second crown tower. Both are legal and plausible. Which one wins more has not been tested in matches.
4. **Defense and punishment are not the main gap.** Every child plays Mini PEKKA on every defense state, intercepting in 8 of 10, and passes defense. Punishment passes for 8 of the 24 children: they mostly answer with Mini PEKKA, and only some placements fall in the front rows.
5. **Spell abandonment is consistent across all three measures:** synthetic states, real bank states and matches. Between iterations 0 and 23, Fireball and Giant decline as cheaper troops take their place. Arrows survive in matches (1.0–2.6 per game) but are never chosen on the spell-value states.
6. **The match value of capture is small.** In the [ninth comparison](EDGER_TACTICAL_REVIEW.md#ninth-comparison-stage-1-result), forced capture changed the match point by +0.029 [−0.001, +0.060] for lethal and +0.022 [−0.021, +0.064] for cluster. In 594 of 676 lethal branches the point did not change. Two readings fit:
   - capture has a small value that the learner fails to find;
   - capture has about none for these children.

   Either way the training objective barely rewards it, and every floor that kept Fireball cost play: the global β = 0.05 floor about 0.06–0.10, the targeted β = 1 floor 0.160, at a capture rate of only 0.239.
7. **Consequence.** With the gates as they are, the best recipe so far cannot reach the match suite. Its strength is therefore unmeasured by the evaluator built to decide promotion.

## Options

Any change to a gate needs your explicit approval. Each option is described
with what it would and would not do.

- **A. Keep both gates unchanged.** The next work is then a recipe aimed at the gates. It would need heuristic-level spell choices on the synthetic states, at least 22 of 27 bank lethal captures (the heuristic gets 20), and pocket play above the 0.55 floor, which the heuristic itself misses.
  - The ninth's Stage 2 (weighted opportunity rows, frozen and unlaunched) covers only Fireball.
  - Earlier floors suggest a match-score cost.
- **B. Repair the tactical gate's own rules, keep it blocking.** Drop the strict heuristic-aggregate rule and keep the category floors. Separately review the pocket scorer against match outcomes.
  - The children would still fail spell value, finishing, and mostly punishment and pocket, so B alone unblocks nothing.
  - It removes a rule that no existing policy passes and that duplicates the spell floors.
- **C. Report the gates, don't block on them.** Keep both suites in every report, always run the match suite, and let the match gates plus your separate promotion approval decide.
  - This unblocks the evaluator immediately.
  - Risk: a promoted Edger might never cast Fireball and rarely play Giant. Players would see that change in how Edger plays.
  - Preflight would no longer stop weak candidates cheaply. A short champion pre-check could take over that role, as a cost saving only.
- **D. Measure the skills in matches.** Score them in the evaluator's own games instead of the synthetic states:
  - per-card deployment rates (deck usage);
  - capture rate at real in-match opportunities, using the ninth's shared detector (`scripts/edger-fireball-opportunity.mjs`).

  This can be blocking (keeping a spell requirement in terms players see) or reported, alongside C. It needs a design, with thresholds you choose frozen before any candidate is scored, following the bank's rule.
- **E. A runtime spell rule.** A deterministic rule would cast a capturing Fireball whenever one is legal.
  - This changes a product boundary: Edger would no longer be a purely learned policy (`AGENTS.md`).
  - It meets the bank's wording but not its intent.
  - Listed for completeness; not recommended.

## Recommendation

The choice turns on one product question: **must the shipped Edger use its
whole deck, spells in particular, or is the strongest legal play enough?**

- **If the strongest play is enough:** C, plus D as reported diagnostics. Your promotion approval would then see deck usage and capture next to the match gates.
- **If spells are required:** B, plus D as blocking, then design a recipe aimed at the in-match measure. This is A's work, measured the way players would see it.
- **In both cases, drop the strict heuristic-aggregate rule (B).** It is far stricter than the floors and measures closeness to the heuristic's own choices on states designed around them. No existing policy, the heuristic included, passes it.

**What stays the same either way:** no existing child is a promotion
candidate, because they were all trained and selected on reused development
seeds. A promotable model still needs fresh BC and scaling provenance, a new
immutable campaign prefix and the full match suite (the fresh-provenance task
in `progress.md`).

## Implementation of the decision

Implemented on November 20, 2026, after the owner's decision.
- **Gates removed:** `tactical_scenarios` and `heldout_fireball` are no longer gates. The v2 report schema is now `edger_v2_evaluation_report_v2`, and `edger:promote:v2` refuses every v1 report.
- **Reported measures:** the report keeps them under `reported`, with `blocking: false`. Each top-level `passed` field becomes `minimums_met`, and each category's becomes `minimum_met`, so neither can be read as a gate.
- **In-match measures (`reported.match_skills`):** these are new. Per evaluation group, and pooled over every group except safety, they record:
  - the candidate's legal plays per card;
  - at every candidate decision, PASS included, the Fireball opportunity class (shared rules, lethal first), Fireball choices and legal captures;
  - games with an opportunity and games with a capture.

  The match worker computes them only when the evaluator asks (`trackSkills`). They read engine state and change no decision.
- **Heuristic rule:** `evaluateScenarioLeague` now passes when every category minimum is met. `improved_over_heuristic` is still reported.
- **Inputs still fail closed:** a new preflight gate, `skill_report_inputs`, needs a feasible tactical suite and a valid frozen bank with both classes. A missing or invalid bank still stops the evaluation before any match, so every report carries both measures. A low capture rate or tactical score never stops it.
- **Unchanged:** parity, timing, the champion, anchor, weak-baseline, frozen-league, safety, replay, test-suite and browser gates, the tactical scorers and minimums, and the bank.
- **Commands:**
  - `edger:evaluate:v2` and `edger:promote:v2` print the reported measures;
  - promotion refuses a report missing any of them;
  - your separate approval still decides every promotion.
- **Legacy v1 evaluator:** `edger:evaluate` reports its tactical suite instead of gating on it.
- **Tests:**
  - an evaluation with no bank fails preflight closed, and its tactical and bank results appear only under `reported`;
  - a candidate below every tactical and Fireball minimum still reaches the full match suite, with no tactical or Fireball promotion failure;
  - tracked and untracked games are identical, apart from the added record;
  - the tracker counts captures only for legal, correctly aimed Fireballs, and never changes engine state;
  - the pooled summary excludes safety;
  - promotion refuses schema v1, missing reported sections and a missing `skill_report_inputs`;
  - minimums alone decide the tactical pass.
- **Cost:** tracking added about 4–5% to match time on a sixth-comparison child (90 games, 6 workers, two runs each way). That is local and descriptive, not a timing gate.

## Limits

- The tactical numbers are single decisions at constructed states, and the bank's are single decisions at the first opportunity per episode. Neither includes cast delay, travel or follow-up play.
- Match scores are 100-game development-seed evaluations against live v1, the heuristic, aggressive and defender. The same seeds were used in every comparison. Human play is untested.
- The heuristic's own match-level card usage was not measured here. The bank shows it chooses Fireball in 25 of 27 lethal and 44 of 53 cluster states.
- The pocket reading is a rules reading, not a measured result.

## Validation

Review (docs only). The read-only commands are in `GR/README.md`:
- `node gate-review.mjs ~/Developer/edge_royale ~/edge_royale-runs gate-review.json`
- `/usr/local/bin/python3 -I match-usage.py ~/edge_royale-runs match-usage.json`

Both were run at HEAD `c042a9f` with a clean tree. `shasum -a 256 -c SHA256SUMS` passes in `GR` (5/5). No test run was needed.

Implementation (November 20, 2026):
- `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2`: 288/288, including 7 new tests (`tests/edger-match-skills.test.js`, `tests/edger-v2-evaluation.test.js`, `tests/edger-training-pipeline.test.js`).
- A smoke-profile evaluation of the sixth's full-grid r6 child against the real QB bank, run from the repository root, not evidence:
  - preflight passed and the 16 smoke matches ran;
  - reported: tactical 0.236, bank 0/27 and 0/53;
  - in-match: no Giant or Fireball plays, 0 of 7 opportunity decisions captured.
- The bot benchmark and browser smoke were not run: Edger's runtime, the heuristic and the client are unchanged.
