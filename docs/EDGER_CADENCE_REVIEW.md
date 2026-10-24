# Review of the decision-cadence conclusions — September 27, 2026

The measured gameplay improvement is supported. The strongest defensible claim
is that these particular trained checkpoints improve deterministic play against
v1, and that the benefit of faster evaluation depends on the checkpoint. The
experiment does not establish a preferred training cadence, a critic-driven
mechanism, or the cause of the historical league regression.

This reviews the September 26 section of
[the evaluation diagnosis](EDGER_EVALUATION_DIAGNOSIS.md). It does not change the
frozen decision rules, promotion gates, models or original experiment evidence.

## Findings

### 1. Training cadence and evaluation cadence need separate conclusions

The learned-delay-trained checkpoint scored 0.7775 when evaluated every tick;
the every-tick-trained checkpoint scored 0.7575 under that same controller.
Reanalysis of the saved paired games gives learned-training minus fixed-training
**+0.020, 95% interval [−0.035, +0.075]**. Neither training regime has a
demonstrated advantage at the same evaluation cadence; this is not an
equivalence result either.

The original C4 (+0.160) changes both the training and evaluation controller.
It compares two complete pipelines, so it cannot establish that every-tick
*training* is better. Both arms used 384 games and optimizer updates, but the
fixed arm had 62 times the decision rows and 85 times the recorded learner
time. The learned-trained/every-tick-evaluated combination therefore deserves
an explicit place in the replication plan. Its aggressive and heuristic
performance was not evaluated in the original experiment.

The cadence effect on learned-trained weights is +0.180; on parent weights it
is −0.005. Their paired difference is **+0.185 [ +0.10125, +0.265 ]**. This
exploratory interaction supports the narrower claim that faster evaluation
helped this trained checkpoint much more than this parent. It does not identify
which actor head improved or establish that one-tick cadence is optimal.

### 2. The critic attribution is a hypothesis, and entropy needs its denominator

`head_entropies` in `scripts/edger-v2-cadence-experiment.py` sets placement entropy
to zero on PASS rows. `train_cadence_episode` then divides by all decision rows.
The fixed arm's first and final iterations contain 99.157% and 99.144% PASS rows.
Its reported placement entropy of 0.0193 and 0.0167 nats per tick becomes
**2.2873 and 1.9486 nats per card-play row**. Those averages do not establish
near-deterministic placement when a card is played.

The raw module-gradient norms are real, but `group_gradient_norms` runs after
the policy, value and entropy losses have already been combined. It does not
separate their contributions to the shared trunk. Small raw head gradients also
do not establish small optimizer changes: the fixed arm's card-head relative
L2 drift is 0.1232, compared with 0.0760 for the trunk. Neither drift norm proves
which changes caused wins.

Measure policy/value/entropy gradients separately on shared parameters, report
effective parameter updates, and condition card entropy/importance ratios on
states with a genuine card choice. Report placement statistics on play rows.
A true critic-only ablation must disable **both policy loss and actor entropy**;
turning off policy loss alone leaves another actor-training signal. A matching
control that blocks value-loss gradients into the actor would help distinguish
the mechanisms. Near-unit aggregate ratios alone are weak evidence of stability
at meaningful decisions when most rows are PASS.

The forced-PASS fraction was not measured in this review: the attempted complete
mask scan was stopped when reads stalled on macOS dataless file placeholders.
The PASS fractions and conditional placement entropies above are exact
recomputations from the saved per-iteration row counts and entropy sums.

### 3. A null timing comparison does not rule out a timing bottleneck

Parent C1 is −0.005 [−0.064, +0.054]. Say **"every-tick evaluation produced no
detectable improvement for this parent"**, rather than "timing does not hold
the parent back." The interval still includes a five-percentage-point benefit,
and no intermediate or event-triggered cadence was tested. The significant
decline against aggressive is evidence that blindly increasing frequency can
also harm this parent.

The literal frozen label "inconclusive" is correctly applied: its four-way
mapping has no positive category for "RL helps and parent timing is not detected
as major." It should not obscure the positive C2 result. Any equivalence margin
or new decision categories should be specified before the next experiment.

### 4. Transfer and uncertainty should be scoped to the comparisons actually run

The +0.105 against aggressive is a valid training gain over the *fixed-cadence*
parent (0.775 → 0.880). Against the original learned-delay parent (0.875), the
trained fixed pipeline gains only **+0.005 [−0.050, +0.060]**. This supports
recovery of aggressive performance lost by the cadence switch; it does not yet
show improvement over the original parent against that opponent.

The paired bootstrap correctly resamples whole seed pairs. These intervals
measure evaluation-seed uncertainty for fixed checkpoints. They do not include
variation between training runs. The second learning rate uses the same seed
plan and is a sensitivity check, not an independent training replication.
General claims about training reliability or broad playing strength remain
premature with one run per arm and most training games against v1.

### 5. Metric disagreement and historical causation remain open

Worse held-out imitation loss coexists with stronger deterministic play here;
that loss should not be the sole model-selection criterion. It does not follow
that imitation loss has no diagnostic value generally. Sampled training-rollout
scores are also not a controlled substitute for matched deterministic evaluation.

Likewise, the tactical results do not prove that the suite is invalid. Tactical
score actually rises from 0.000 to 0.370 as gameplay improves; the identical
trained scores do not distinguish their gameplay strength. A policy can beat
v1 while retaining weaknesses in particular situations. Audit fixture validity
and coverage before drawing a broader conclusion, and retain the gate meanwhile.

The legacy data recipe is a reasonable hypothesis for the historical regression,
not an identified cause. Data freshness, opponent/state coverage, delay labels,
update history and numerical changes differ between experiments. A recorded
action probability of one is not intrinsically wrong for a deterministic
behavior policy. The existing equal-update attribution experiment remains
necessary. Nothing in this review changes the failed promotion status.

## Recommended next experiment

Replicate both training arms with new training seeds, evaluating **each trained
checkpoint under both cadences** against v1, heuristic and aggressive. Keep the
paired development comparisons and reserve fresh confirmation seeds before
choosing a product design. Treat training cadence and inference cadence as
separate choices. Include the correctly isolated critic-only control and the
conditional diagnostics above. Report per-run scores as well as evaluation
intervals; two additional runs are a first replication step, not a guarantee of
reliability. Benchmark intermediate cadences later if the crossover replicates.

## Evidence and validation

The review read the frozen plan, controller, worker, trainer, tests, learning
metrics and all 13 saved evaluation files (4,400 games). Recomputed scores and
paired-bootstrap intervals matched the original summaries; seed/side identity,
winner-to-score conversion, model-file checksums and reported legal/deployment
counts passed the additional read-only checks. No new games or training ran.

The three additional contrasts above are exploratory reanalyses, not new
pre-registered outcomes. An independent standard-library Python implementation
reproduced their Node bootstrap results, using the same 10,000 resamples and LCG
seed 20260926. Script, input-report hashes and results are under ignored
`artifacts/edger-training/experiments/20260927-cadence-review/`.

Exact reproducible commands from the repository root:

```bash
/usr/bin/python3 -u artifacts/edger-training/experiments/20260927-cadence-review/review.py
/usr/bin/python3 -u artifacts/edger-training/experiments/20260927-cadence-review/review.py --learning-only
git diff --check -- progress.md docs/EDGER_CADENCE_REVIEW.md
```

This session changes review documentation and the handoff only, plus an ignored
analysis script/report. The September 26 test results remain historical; tests,
browser smoke, bot benchmarks and promotion gates were not rerun.

## Follow-up — September 27

An independent check reproduced every figure above with the experiment's own
bootstrap code. The recommended replication then ran with two new training
runs, a critic-only control (policy loss and actor entropy both off), a
value-detached control, conditional metrics and both-cadence evaluation. See
[the diagnosis](EDGER_EVALUATION_DIAGNOSIS.md), section
"Cadence replication — executed September 27". In brief:

- RL gains replicate in all three runs (fixed-trained vs parent at every tick:
  +0.242 / +0.175 / +0.209 vs v1).
- Every-tick training still has no demonstrated advantage. At matched
  every-tick evaluation learned-delay training is ahead in every run and
  opponent (vs v1 +0.020 / +0.134 / +0.071), but the pre-registered label is
  "no demonstrated difference" because r0 is not detected.
- The critic hypothesis is not supported. Critic-only training does not
  reproduce the gain (r1 −0.385, r2 −0.050). Actor terms are necessary, and
  blocking value gradients from the trunk keeps the gain.
- Learned-delay training with every-tick evaluation beats the original parent
  on v1, aggressive and heuristic in all three runs. The fixed pipeline's
  aggressive result remains recovery, not improvement (+0.005 / +0.045 /
  +0.045 vs the original parent).
- Run-to-run spread is large (for example E2 +0.077 / +0.263 / +0.077).
