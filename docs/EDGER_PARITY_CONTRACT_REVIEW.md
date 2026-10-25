# Edger v2 parity-contract review packet — October 25, 2026

This prepares Next Task 2, a reviewed decision on the PyTorch/JS parity
contract. It measures each candidate contract and each isolated runtime fix on
all seven local v2 models.

**Nothing has changed.** The `1e-5` tolerance, the gate code, the runtime and
the tie semantics are unchanged. Every option below needs explicit approval,
tests and fresh provenance before it lands. The September 27
[isolation](EDGER_EVALUATION_DIAGNOSIS.md#parity-failure-isolation--september-27)
is the background.

- `X` = `~/edge_royale-runs/20261025-tactical-parity-warmup.noindex/`. Scripts and per-model outputs are in `X/parity/`; models (checksums in the [tactical review](EDGER_TACTICAL_REVIEW.md#inputs)) are in `X/models/`.

## Current contract

`checkCandidateParity` (`scripts/edger-v2-evaluation-core.mjs`):
- **Bank.** The opening plus six mid-match states for each of three seeds, played by the candidate against the heuristic. Each state yields PASS plus every legal card branch.
- **Rule 1.** Every coordinate of the card, placement and delay logits must be within `1e-5` absolute of PyTorch float32 CPU (`edger-v2-training.py parity`). Masked coordinates are equal by construction.
- **Rule 2.** The masked argmax of each head must be identical, with the first index winning ties.

## Method

For each model, the unchanged bank was rebuilt: 18–19 states and 55–83
fixtures (they depend on the model's own play).

**Implementations compared** (`X/parity/policy-variant.js`):
- **V0:** the shipped runtime. A copy with no variant enabled reproduces it bit for bit on every fixture.
- **V1:** float64 accumulation in `meanPool`, rounded once to float32.
- **V2:** `Math.fround` on every loaded weight. This leaves conv kernels unchanged, since they are already stored as float32.
- **V3:** V1 and V2 together.

**References:**
- PyTorch float32: the real `parity` subcommand.
- PyTorch float64: the same float32 weights evaluated in double (`reference64.py`).

**Metrics,** on legal coordinates (`compare.py`):
- absolute error;
- ULP error at each coordinate's own magnitude;
- masked argmax;
- exact tie sets;
- legal-softmax total variation and log-probability error;
- argmax gaps no larger than twice the measured error.

## Results

**The current gate.** Under the current contract (V0 against float32), all seven
models fail, on 38–79 fixtures each. This reproduces the September 27 parent
result: 47/56 fixtures, worst error `9.155e-05`.

- **Every failure is a placement failure,** except that r0-learned's delay head also reaches `1.05e-05` under V0.
- **Placement logits are large.** They reach 149–189 for the fixed-trained models and 474–746 for the parent and learned-trained models. Above 128, one float32 ULP (`1.53e-05` or more) already exceeds `1e-5`.

**Decisions agree everywhere.** For every model, both references and all four
implementations:
- masked argmax agrees on every head and fixture, and the exact tie sets are identical;
- this includes 18–29 fixtures per model whose top choice is an exact tie (the structural ties of the [tactical review](EDGER_TACTICAL_REVIEW.md#troop-placement-ties)), which PyTorch reproduces exactly;
- no argmax gap lies within twice the measured error;
- legal-softmax total variation is at most `2.2e-05`, and log-probability error at most `1.21e-04`.

**Variants and references.** The cells show the ULP multiple needed for every
coordinate over `1e-5`, and the number of fixtures over `1e-5`.

| Model | V0 vs f32 | V1 vs f32 | V3 vs f32 | V0 vs f64 | V1 vs f64 | V3 vs f64 |
|---|---|---|---|---|---|---|
| Parent | 3.00 / 47 | 3.00 / 45 | 3.00 / 40 | 1.93 / 49 | 1.30 / 37 | 0.93 / 32 |
| Learned r0 | 11.00 / 56 | 3.00 / 36 | 3.00 / 30 | 4.01 / 56 | 0.95 / 35 | 0.84 / 35 |
| Learned r1 | 2.00 / 44 | 2.00 / 42 | 2.00 / 39 | 0.94 / 45 | 0.88 / 45 | 0.80 / 45 |
| Learned r2 | 3.00 / 38 | 2.00 / 33 | 2.00 / 37 | 1.84 / 38 | 0.85 / 34 | 0.92 / 32 |
| Fixed r0 | 9.00 / 79 | 2.00 / 35 | 2.00 / 37 | 9.12 / 78 | 0.86 / 11 | 0.80 / 6 |
| Fixed r1 | 9.00 / 67 | 2.00 / 33 | 3.00 / 34 | 8.39 / 73 | 1.00 / 5 | 1.00 / 8 |
| Fixed r2 | 7.00 / 73 | 3.00 / 32 | 3.00 / 33 | 5.44 / 78 | 1.11 / 8 | 0.73 / 6 |

- **V1, the float64 pool, is the effective runtime fix.**
  - It cuts the worst float32-relative error from 11 ULP to at most 3.
  - It brings card and delay within `1e-5` for all seven models (at most `1.91e-06` and `3.81e-06`).
  - It halves the fixtures over tolerance for the fixed-trained models.
- **V2 alone changes almost nothing against float32.** It matters only against an exact reference. With V1 it gives V3, whose every over-tolerance coordinate is within 1.00 ULP of the float64 evaluation, i.e. faithfully rounded.
- **No variant changes any JS argmax or tie set** on any bank. The full-match check is in [Decision preservation](#decision-preservation).
- **Pure ULP limits are unusable.** Raw ULP errors reach about 10⁵ at near-zero logits, from cancellation, so any ULP rule needs an absolute floor.

## Options

| Option | What changes | Measured outcome on the seven models |
|---|---|---|
| A. Keep `1e-5` against float32 | Nothing | 0/7 pass for every implementation, now and for any model whose placement logits exceed about 128 |
| B. Float64 reference, same `1e-5` | Reference only | 0/7 pass (V0 is over on 38–78 fixtures, V3 on 6–45) |
| C. Hybrid: `abs ≤ max(1e-5, k·ulp32(max(abs(js), abs(ref))))` against float32 | Tolerance above magnitude 32 only | V0 needs k = 11. V1 or V3 needs k = 3, so k = 4 passes 7/7 with one ULP of headroom |
| D. As C, against float64 | Reference and tolerance | V0 needs k = 9.12. V1 needs 1.30 and V3 1.00, so k = 2 passes 7/7 |
| E. Decision space only: identical argmax and tie sets, total variation bound | Drops the numeric check | 7/7 pass for every implementation, but blind to numeric bugs that have not yet flipped a decision on the bank |
| F. Bound placement logit scale in training | Training semantics | Not measured. A 3-ULP implementation stays within `1e-5` only below about 32; current placement logits are 5–23× larger |

- In option C, the tolerance is unchanged at exactly `1e-5` below magnitude 32, where 4·ulp32 < `1e-5`; above that it is 4 ULP.
- The September 21 counterexamples (a zero-weight actor with PASS bias, and a wrong card embedding) remain caught by the branch-aware bank under C or D. Their errors are 0 or about 1,000, nowhere near 4 ULP.

## Recommendation for review

1. **Land V1 first, as its own change.** Float64 accumulation in `meanPool`, rounded once to float32.
   - It is the main JS-side deviation and costs 576×16 extra double additions.
   - Without it, no contract below 11 ULP accepts the r0-learned or fixed-trained models.
   - It changes no decision on the banks or in the 70 full matches below. When it lands it still needs `npm test`, the bot-bench gate, a refreshed runtime-cost pin and fresh provenance, because it is protected runtime code.
   - V2 can be bundled or deferred; it matters only for a float64 reference.
2. **Then adopt option C with k = 4,** keeping the float32 PyTorch reference that training uses.
   - Also make the identical tie set an explicit requirement next to the identical masked argmax.
   - Report fragile-margin counts, and send any non-zero count to review.
   - This leaves `1e-5` in force below magnitude 32, and it still rejects the current V0 runtime for four models. The contract therefore cannot hide the known pooling deviation.
3. **Keep the logit-scale warning advisory** (option F) until a learner experiment shows that bounding the scale does not cost play. Option E alone is not recommended.

## Decision preservation

`X/parity/decisions-js.mjs` plays ten full learned-cadence matches per model
(seeds 20261025–20261034; v2 red against heuristic blue, the bank's loop). It
compares V0's red decision stream and final state hash with each variant.

**Result: all 70 matches are identical under V1, V2 and V3.** That covers
3,785 red decisions (parent 362, learned 641/1,458/821, fixed 182/152/169),
with the same streams and the same final state hashes (`X/parity/decisions.json`).
Together with the banks, this is evidence, not proof, that V1 and V2 are
decision-preserving. Their remaining gate checks are `npm test` and the bot-bench
gate after the change lands.

## Limits

- Seven local, non-promotable models and one bank schedule.
- PyTorch 2.11.0 CPU on an M1 (Python 3.11). The reference host's PyTorch/BLAS accumulation order may differ, so any adopted k must be re-measured there.
- The variants are scratch copies; nothing in `src/ai` changed.

## Reproduction

```bash
X=~/edge_royale-runs/20261025-tactical-parity-warmup.noindex
N=$HOME/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node
R=~/Developer/edge_royale; PY=/usr/local/bin/python3; cd "$X/parity"
for m in parent-lossless r0-learned-full r1-learned-full r2-learned-full r0-fixed-full r1-fixed-full r2-fixed-full; do
  $N parity-js.mjs "$X/models/$m.json" $m
  (cd "$R" && $PY scripts/edger-v2-training.py parity --model "$X/models/$m.json" --fixture "$X/parity/$m/fixtures.json" --out "$X/parity/$m/pt32.json")
  $PY reference64.py "$R/scripts/edger-v2-training.py" "$X/models/$m.json" $m/fixtures.json $m/pt64.json
  $PY -I compare.py $m/js-variants.json $m/pt32.json $m/pt64.json $m/compare.json
done
$N decisions-js.mjs decisions.json 10 parent="$X/models/parent-lossless.json" r0-learned="$X/models/r0-learned-full.json" # … and the other five models
```
