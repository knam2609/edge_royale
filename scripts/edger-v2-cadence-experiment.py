#!/usr/bin/env python3
"""Diagnostic-only decision-cadence learner for the shadow Edger v2 policy.

Trains from fresh trajectories written by scripts/edger-v2-cadence-core.mjs.
The ``learned`` delay mode is the production V-trace update (joint card +
placement + delay log-probability, entropy over all three heads). The
``fixed_one_tick`` mode treats the one-tick delay as deterministic, so the
delay head is excluded from the policy log-probability and the entropy.

Loss modes are attribution controls on top of either cadence. ``full`` is the
update above. ``critic_only`` drops both the policy loss and the actor entropy,
so the actor changes only through value-loss gradients into the shared trunk.
``value_detached`` keeps the full actor loss but stops value-loss gradients at
the fused trunk features, so only actor terms shape the shared trunk.
``critic_head`` trains only the value head and its opponent-stratum embedding:
value loss alone, on detached fused features, so the trunk and every actor
head stay bit for bit unchanged. It is the critic warm-up of the reward
comparison; a later arm starts from it with ``--start-from-warmup``.

Outputs are never promotable: checkpoints use a separate diagnostic schema that
production ``load_checkpoint`` rejects, and exported actors are labelled
``diagnostic_only_not_promotable``. The one exception is ``export-candidate``:
the selected run of a candidate campaign, exported only after its whole
lineage matches the campaign manifest and the measured recipe.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

import numpy as np
import torch
from torch import Tensor, nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "edger_v2_training_for_cadence", ROOT / "scripts" / "edger-v2-training.py"
)
training = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = training
_spec.loader.exec_module(training)

EPISODE_SCHEMA = "edger_v2_cadence_episode_v1"
DIAGNOSTIC_CHECKPOINT_SCHEMA = "edger_v2_cadence_diagnostic_checkpoint_v1"
PROMOTION_STATUS = "diagnostic_only_not_promotable"
DELAY_MODES = ("learned", "fixed_one_tick")
LOSS_MODES = ("full", "critic_only", "value_detached", "critic_head")
# Modes with no actor loss: only the value loss is optimized.
CRITIC_LOSS_MODES = ("critic_only", "critic_head")
# Parameters a critic_head update may change; every other one is the actor's.
CRITIC_HEAD_MODULES = ("value_head", "value_stratum_embedding")
# Training reward potentials (scripts/edger-reward-core.mjs). Every episode in
# a collection, and every iteration of an arm, must use one version; files
# written before v2 existed carry v1 or no version at all.
REWARD_VERSIONS = ("edger_potential_reward_v1", "edger_potential_reward_v2")
DEFAULT_REWARD_VERSION = REWARD_VERSIONS[0]
# Rows the card KL penalty covers: every row, or only Fireball opportunity rows
# (tactical review proposal 3, option 1, the targeted floor).
CARD_KL_ROWS = ("all", "opportunity")
# Fireball opportunity classes whose card-head policy term the opportunity
# card weight multiplies (tactical review, ninth comparison).
OPPORTUNITY_WEIGHT_CLASSES = ("lethal", "cluster", "both")
DTYPES = {
    "Int32Array": np.dtype("<i4"),
    "Int16Array": np.dtype("<i2"),
    "Uint16Array": np.dtype("<u2"),
    "Uint8Array": np.dtype("u1"),
    "Float32Array": np.dtype("<f4"),
    "Float64Array": np.dtype("<f8"),
}
PARAMETER_GROUPS = {
    "trunk": ("conv1", "conv2", "conv3", "global_encoder", "fusion"),
    "card": ("card_head",),
    "placement": ("placement_context", "card_embedding", "placement_scorer", "placement_coordinates"),
    "delay": ("delay_encoder", "delay_head"),
    "value": ("value_head", "value_stratum_embedding"),
}


# --------------------------------------------------------------------------
# Trajectory loading


def load_cadence_episode(header_path: str | Path) -> dict[str, Any]:
    header_path = Path(header_path)
    header = json.loads(header_path.read_text())
    if header.get("schema_version") != EPISODE_SCHEMA:
        raise ValueError(f"unsupported cadence episode schema {header.get('schema_version')}")
    body = header_path.with_suffix(".bin").read_bytes()
    if hashlib.sha256(body).hexdigest() != header["body_sha256"]:
        raise ValueError(f"cadence episode body checksum mismatch: {header_path}")
    arrays = {}
    for name, spec in header["arrays"].items():
        dtype = DTYPES[spec["dtype"]]
        arrays[name] = np.frombuffer(
            body, dtype=dtype, count=spec["length"], offset=spec["offset"]
        )
    rows = int(header["rows"])
    arrays["global"] = arrays["global"].reshape(rows, training.GLOBAL_FEATURES)
    arrays["card_mask"] = arrays["card_mask"].reshape(rows, training.CARD_ACTIONS)
    return {"header": header, "rows": rows, **arrays}


def dense_boards(episode: dict[str, Any], start: int, end: int) -> Tensor:
    offsets = episode["board_offsets"]
    count = end - start
    board = np.zeros((count, header_board_size(episode)), dtype=np.float32)
    lo, hi = int(offsets[start]), int(offsets[end])
    lengths = np.diff(offsets[start : end + 1])
    row_ids = np.repeat(np.arange(count), lengths)
    board[row_ids, episode["board_indices"][lo:hi].astype(np.int64)] = episode[
        "board_values"
    ][lo:hi]
    return torch.from_numpy(board).reshape(
        count, training.BOARD_HEIGHT, training.BOARD_WIDTH, training.BOARD_INPUT_CHANNELS
    )


def header_board_size(episode: dict[str, Any]) -> int:
    size = int(episode["header"]["board_size"])
    expected = training.BOARD_HEIGHT * training.BOARD_WIDTH * training.BOARD_INPUT_CHANNELS
    if size != expected:
        raise ValueError(f"cadence board size {size} != {expected}")
    return size


def placement_masks(episode: dict[str, Any], start: int, end: int) -> Tensor:
    offsets = episode["placement_offsets"]
    count = end - start
    mask = np.zeros((count, training.PLACEMENTS), dtype=bool)
    lo, hi = int(offsets[start]), int(offsets[end])
    lengths = np.diff(offsets[start : end + 1])
    row_ids = np.repeat(np.arange(count), lengths)
    mask[row_ids, episode["placement_indices"][lo:hi].astype(np.int64)] = True
    return torch.from_numpy(mask)


def episode_batch(
    episode: dict[str, Any], start: int, end: int, stratum: int
) -> SimpleNamespace:
    """A duck-typed training.Batch for rows [start, end)."""
    count = end - start
    delay_mask = torch.ones((count, training.DELAY_BINS), dtype=torch.bool)
    return SimpleNamespace(
        board=dense_boards(episode, start, end),
        global_features=torch.from_numpy(
            np.array(episode["global"][start:end], dtype=np.float32)
        ),
        card_mask=torch.from_numpy(np.array(episode["card_mask"][start:end], dtype=bool)),
        placement_mask=placement_masks(episode, start, end),
        delay_mask=delay_mask,
        card=torch.from_numpy(episode["card_index"][start:end].astype(np.int64)),
        placement=torch.from_numpy(episode["placement_index"][start:end].astype(np.int64)),
        delay=torch.from_numpy(episode["delay_index"][start:end].astype(np.int64)),
        stratum=torch.full((count,), stratum, dtype=torch.long),
        sample_weight=torch.ones(count, dtype=torch.float32),
    )


# --------------------------------------------------------------------------
# Probability semantics


def head_log_probabilities(logits: dict[str, Tensor], batch: Any) -> dict[str, Tensor]:
    """Selected-action log-probability per head, as in selected_joint_log_probability."""
    card = F.log_softmax(
        training.mask_logits(logits["card"], batch.card_mask), dim=1
    ).gather(1, batch.card[:, None]).squeeze(1)
    placement = torch.zeros_like(card)
    play = batch.card != 0
    if play.any():
        placement[play] = F.log_softmax(
            training.mask_logits(logits["placement"][play], batch.placement_mask[play]), dim=1
        ).gather(1, batch.placement[play, None]).squeeze(1)
    delay = F.log_softmax(
        training.mask_logits(logits["delay"], batch.delay_mask), dim=1
    ).gather(1, batch.delay[:, None]).squeeze(1)
    return {"card": card, "placement": placement, "delay": delay}


def card_log_probability(logits: dict[str, Tensor], batch: Any) -> Tensor:
    """The selected card's log-probability alone, with gradient."""
    return F.log_softmax(
        training.mask_logits(logits["card"], batch.card_mask), dim=1
    ).gather(1, batch.card[:, None]).squeeze(1)


def opportunity_weight_rows(opportunity_class: Tensor, classes: str) -> Tensor:
    """Rows whose card-head policy term the opportunity weight multiplies."""
    if classes == "both":
        return opportunity_class != training.OPPORTUNITY_NONE
    return opportunity_class == training.OPPORTUNITY_CLASSES[classes]


def policy_log_probability(logits: dict[str, Tensor], batch: Any, delay_mode: str) -> Tensor:
    if delay_mode == "learned":
        # Production V-trace semantics, unchanged.
        return training.selected_joint_log_probability(logits, batch)
    if delay_mode == "fixed_one_tick":
        # The one-tick delay has probability one; log 1 = 0 contributes nothing.
        heads = head_log_probabilities(logits, batch)
        return heads["card"] + heads["placement"]
    raise ValueError(f"unknown delay mode {delay_mode}")


def head_entropies(logits: dict[str, Tensor], batch: Any) -> dict[str, Tensor]:
    def entropy_for(values: Tensor, mask: Tensor) -> Tensor:
        log_probability = F.log_softmax(training.mask_logits(values, mask), dim=1)
        return -(log_probability.exp() * log_probability).sum(dim=1)

    card = entropy_for(logits["card"], batch.card_mask)
    placement = torch.zeros_like(card)
    play = batch.card != 0
    if play.any():
        placement[play] = entropy_for(logits["placement"][play], batch.placement_mask[play])
    delay = entropy_for(logits["delay"], batch.delay_mask)
    return {"card": card, "placement": placement, "delay": delay}


def policy_entropy(logits: dict[str, Tensor], batch: Any, delay_mode: str) -> Tensor:
    if delay_mode == "learned":
        return training.actor_entropy(logits, batch)
    if delay_mode == "fixed_one_tick":
        heads = head_entropies(logits, batch)
        return heads["card"] + heads["placement"]
    raise ValueError(f"unknown delay mode {delay_mode}")


def behavior_log_probability(episode: dict[str, Any], delay_mode: str) -> np.ndarray:
    """Behaviour log-probability recorded by the sampling controller.

    Fixed cadence records a delay log-probability of exactly zero; the joint
    must equal card + placement. Anything else means the trajectory did not
    come from the fixed-cadence controller.
    """
    joint = np.array(episode["behavior_log_probability"], dtype=np.float64)
    if not np.all(np.isfinite(joint)):
        raise ValueError("cadence episode has unknown behaviour probabilities")
    header_mode = episode["header"].get("cadence")
    if header_mode != delay_mode:
        raise ValueError(f"episode cadence {header_mode} does not match delay mode {delay_mode}")
    if delay_mode == "fixed_one_tick":
        if np.any(episode["delay_index"] != 0) or np.any(episode["delay_ticks"] != 1):
            raise ValueError("fixed-cadence rows must record a one-tick delay")
        if np.any(episode["behavior_delay_log_probability"] != 0.0):
            raise ValueError("fixed-cadence rows must record delay log-probability 0")
    return joint


# --------------------------------------------------------------------------
# V-trace


def vtrace_recursion(
    *,
    values: list[float],
    target_log_probabilities: list[float],
    behavior_log_probabilities: list[float],
    rewards: list[float],
    delay_ticks: list[int],
    per_tick_gamma: float,
) -> dict[str, list[float]]:
    """The recursion of training.attach_vtrace_targets for one ordered episode."""
    count = len(values)
    targets = [0.0] * count
    advantages = [0.0] * count
    ratios = [0.0] * count
    next_vtrace_value = 0.0
    for index in range(count - 1, -1, -1):
        next_value = values[index + 1] if index + 1 < count else 0.0
        discount = float(per_tick_gamma) ** int(delay_ticks[index])
        importance = math.exp(
            max(-20.0, min(20.0, target_log_probabilities[index] - behavior_log_probabilities[index]))
        )
        rho = min(1.0, importance)
        trace_c = min(1.0, importance)
        temporal_difference = rewards[index] + discount * next_value - values[index]
        vtrace_value = (
            values[index]
            + rho * temporal_difference
            + discount * trace_c * (next_vtrace_value - next_value)
        )
        advantages[index] = min(1.0, importance) * (
            rewards[index] + discount * next_vtrace_value - values[index]
        )
        targets[index] = vtrace_value
        ratios[index] = importance
        next_vtrace_value = vtrace_value
    return {"targets": targets, "advantages": advantages, "ratios": ratios}


def microbatch_ranges(count: int, batch_size: int) -> list[tuple[int, int]]:
    return [(start, min(count, start + batch_size)) for start in range(0, count, batch_size)]


def grouped_l2(named_tensors: list[tuple[str, Tensor | None]]) -> dict[str, float]:
    """L2 norm per parameter group; missing tensors count as zero."""
    norms = {}
    for group, prefixes in PARAMETER_GROUPS.items():
        total = 0.0
        for name, tensor in named_tensors:
            if name.split(".")[0] in prefixes and tensor is not None:
                total += float(tensor.detach().pow(2).sum())
        norms[group] = math.sqrt(total)
    return norms


def group_gradient_norms(model: nn.Module) -> dict[str, float]:
    return grouped_l2([(name, parameter.grad) for name, parameter in model.named_parameters()])


def group_cosine(
    names: list[str], left: list[Tensor], right: list[Tensor], group: str
) -> float | None:
    prefixes = PARAMETER_GROUPS[group]
    dot = left_sq = right_sq = 0.0
    for name, a, b in zip(names, left, right):
        if name.split(".")[0] in prefixes:
            dot += float((a * b).sum())
            left_sq += float(a.pow(2).sum())
            right_sq += float(b.pow(2).sum())
    if left_sq == 0.0 or right_sq == 0.0:
        return None
    return dot / math.sqrt(left_sq * right_sq)


def train_cadence_episode(
    model: training.EdgerV2Policy,
    episode: dict[str, Any],
    optimizer: torch.optim.Optimizer,
    *,
    delay_mode: str,
    stratum: int,
    batch_size: int,
    value_loss_weight: float,
    entropy_bonus: float,
    loss_mode: str = "full",
    decompose: bool = False,
    reference: training.EdgerV2Policy | None = None,
    card_kl_coefficient: float = 0.0,
    card_kl_rows: str = "all",
    opportunity_card_weight: float = 1.0,
    opportunity_card_weight_classes: str = "both",
) -> dict[str, Any]:
    """One production-style V-trace update from one fresh episode.

    Targets are recomputed from the current weights before the update, every
    microbatch gradient accumulates against the same parameters, and one
    clipped optimizer step follows, as in training.train_vtrace_episode.

    ``decompose`` additionally measures each loss term's gradient separately
    with ``torch.autograd.grad`` on the same graph; the applied gradient is
    still the single combined backward pass, so the update is unchanged.

    A positive ``card_kl_coefficient`` adds KL(reference || model) over the
    card head (tactical review proposal 3). The forward direction keeps
    probability on every card the BC reference plays, so rare cards cannot
    collapse. Zero leaves the update exactly the production one.
    ``card_kl_rows="opportunity"`` applies it, with the same per-row weight,
    only on Fireball opportunity rows, so ordinary card choices learn freely.

    ``opportunity_card_weight`` w multiplies the card head's policy-gradient
    term by w on the Fireball opportunity rows of
    ``opportunity_card_weight_classes``: the policy loss gains
    -(w - 1) * log pi(card) * advantage on those rows, whatever card was
    sampled (tactical review, ninth comparison). w = 1 adds nothing and is
    exactly the earlier update.
    """
    if loss_mode not in LOSS_MODES:
        raise ValueError(f"unknown loss mode {loss_mode}")
    if card_kl_rows not in CARD_KL_ROWS:
        raise ValueError(f"unknown card KL rows {card_kl_rows}")
    if card_kl_coefficient < 0:
        raise ValueError("card KL coefficient must not be negative")
    if card_kl_coefficient > 0 and reference is None:
        raise ValueError("a card KL term needs a reference policy")
    if card_kl_coefficient > 0 and loss_mode in CRITIC_LOSS_MODES:
        raise ValueError(f"{loss_mode} has no actor loss to add a card KL term to")
    if opportunity_card_weight_classes not in OPPORTUNITY_WEIGHT_CLASSES:
        raise ValueError(f"unknown opportunity weight classes {opportunity_card_weight_classes}")
    if not math.isfinite(opportunity_card_weight) or opportunity_card_weight <= 0:
        raise ValueError("opportunity card weight must be a positive number")
    if opportunity_card_weight != 1.0 and loss_mode in CRITIC_LOSS_MODES:
        raise ValueError(f"{loss_mode} has no actor loss to weight")
    count = episode["rows"]
    behavior = behavior_log_probability(episode, delay_mode)
    ranges = microbatch_ranges(count, batch_size)
    values: list[float] = []
    targets_logp: list[float] = []
    head_logp = {"card": [], "placement": [], "delay": []}
    model.eval()
    with torch.no_grad():
        for start, end in ranges:
            batch = episode_batch(episode, start, end, stratum)
            logits = training.forward_batch(model, batch)
            values.extend(model.value(logits["fused"], batch.stratum).tolist())
            targets_logp.extend(policy_log_probability(logits, batch, delay_mode).tolist())
            for head, tensor in head_log_probabilities(logits, batch).items():
                head_logp[head].extend(tensor.tolist())
    recursion = vtrace_recursion(
        values=values,
        target_log_probabilities=targets_logp,
        behavior_log_probabilities=behavior.tolist(),
        rewards=episode["reward"].tolist(),
        delay_ticks=episode["delay_ticks"].tolist(),
        per_tick_gamma=float(episode["header"]["per_tick_gamma"]),
    )
    vtrace_target = torch.tensor(recursion["targets"], dtype=torch.float32)
    vtrace_advantage = torch.tensor(recursion["advantages"], dtype=torch.float32)

    model.train()
    optimizer.zero_grad(set_to_none=True)
    names = [name for name, _ in model.named_parameters()]
    parameters = [parameter for _, parameter in model.named_parameters()]
    components = ("value",) if loss_mode in CRITIC_LOSS_MODES else ("policy", "value", "entropy")
    if card_kl_coefficient > 0:
        components = (*components, "card_kl")
    component_grads = (
        {component: [torch.zeros_like(parameter) for parameter in parameters] for component in components}
        if decompose
        else None
    )
    head_policy_loss = {"card": 0.0, "placement": 0.0, "delay": 0.0}
    head_entropy = {"card": 0.0, "placement": 0.0, "delay": 0.0}
    card_entropy_given_choice = 0.0
    card_kl_total = 0.0
    opportunity_card_kl_total = 0.0
    opportunity_rows = 0
    # Per class: rows, rows that sampled Fireball, weighted rows and the V-trace
    # advantage summed over Fireball and other rows (descriptive).
    by_class = {
        name: {"rows": 0, "fireball_rows": 0, "weighted_rows": 0,
               "advantage_sum_fireball": 0.0, "advantage_sum_other": 0.0}
        for name in training.OPPORTUNITY_CLASSES
    }
    value_loss_total = 0.0
    for start, end in ranges:
        batch = episode_batch(episode, start, end, stratum)
        advantage = vtrace_advantage[start:end]
        logits = training.forward_batch(model, batch)
        log_probability = policy_log_probability(logits, batch, delay_mode)
        entropy = policy_entropy(logits, batch, delay_mode)
        detach_fused = loss_mode in ("value_detached", "critic_head")
        fused = logits["fused"].detach() if detach_fused else logits["fused"]
        value = model.value(fused, batch.stratum)
        policy_loss = -(log_probability * advantage.detach() * batch.sample_weight).sum()
        opportunity_class = training.fireball_opportunity(batch.global_features, batch.card_mask)
        weighted = opportunity_weight_rows(opportunity_class, opportunity_card_weight_classes)
        if opportunity_card_weight != 1.0 and bool(weighted.any()):
            extra = card_log_probability(logits, batch)[weighted] * advantage.detach()[weighted]
            policy_loss = policy_loss - (opportunity_card_weight - 1.0) * (
                extra * batch.sample_weight[weighted]
            ).sum()
        value_loss = F.mse_loss(value, vtrace_target[start:end], reduction="sum")
        if loss_mode in CRITIC_LOSS_MODES:
            loss = (value_loss_weight * value_loss) / count
        else:
            loss = (
                policy_loss + value_loss_weight * value_loss - entropy_bonus * entropy.sum()
            ) / count
        card_kl = None
        if reference is not None:
            with torch.no_grad():
                reference_card = training.forward_batch(reference, batch)["card"]
            # Measured with or without the penalty; rows with only PASS legal
            # contribute exactly zero. Detached unless it enters the loss.
            card = logits["card"] if card_kl_coefficient > 0 else logits["card"].detach()
            card_kl = training.categorical_kl(reference_card, card, batch.card_mask)
            opportunity = opportunity_class != training.OPPORTUNITY_NONE
            penalized_kl = card_kl if card_kl_rows == "all" else card_kl[opportunity]
            if card_kl_coefficient > 0:
                loss = loss + card_kl_coefficient * penalized_kl.sum() / count
        if not torch.isfinite(loss):
            raise ValueError("non-finite cadence V-trace loss; no candidate accepted")
        if component_grads is not None:
            terms = {
                "policy": policy_loss / count,
                "value": value_loss_weight * value_loss / count,
                "entropy": -entropy_bonus * entropy.sum() / count,
            }
            if card_kl_coefficient > 0:
                terms["card_kl"] = card_kl_coefficient * penalized_kl.sum() / count
            for component in components:
                grads = torch.autograd.grad(
                    terms[component], parameters, retain_graph=True, allow_unused=True
                )
                for accumulated, grad in zip(component_grads[component], grads):
                    if grad is not None:
                        accumulated += grad
        loss.backward()
        with torch.no_grad():
            heads = head_log_probabilities(logits, batch)
            for head in head_policy_loss:
                head_policy_loss[head] += float(-(heads[head] * advantage).sum())
            entropies = head_entropies(logits, batch)
            for head, tensor in entropies.items():
                head_entropy[head] += float(tensor.sum())
            card_entropy_given_choice += float(entropies["card"][batch.card_mask[:, 1:].any(dim=1)].sum())
            if card_kl is not None:
                card_kl_total += float(card_kl.sum())
                opportunity_card_kl_total += float(card_kl[opportunity].sum())
                opportunity_rows += int(opportunity.sum())
            fireball = batch.card == training.FIREBALL_CARD_INDEX
            for name, code in training.OPPORTUNITY_CLASSES.items():
                rows_of_class = opportunity_class == code
                counts = by_class[name]
                counts["rows"] += int(rows_of_class.sum())
                counts["fireball_rows"] += int((rows_of_class & fireball).sum())
                counts["weighted_rows"] += int((rows_of_class & weighted).sum()) if opportunity_card_weight != 1.0 else 0
                counts["advantage_sum_fireball"] += float(advantage[rows_of_class & fireball].sum())
                counts["advantage_sum_other"] += float(advantage[rows_of_class & ~fireball].sum())
            value_loss_total += float(value_loss)
    group_norms = group_gradient_norms(model)
    decomposition = None
    if component_grads is not None:
        combined = [
            parameter.grad if parameter.grad is not None else torch.zeros_like(parameter)
            for parameter in parameters
        ]
        residual_sq = combined_sq = 0.0
        for index, grad in enumerate(combined):
            summed = sum(component_grads[component][index] for component in components)
            residual_sq += float((summed - grad).pow(2).sum())
            combined_sq += float(grad.pow(2).sum())
        decomposition = {
            "group_norms": {
                component: grouped_l2(list(zip(names, component_grads[component])))
                for component in components
            },
            "trunk_cosine_policy_value": (
                group_cosine(names, component_grads["policy"], component_grads["value"], "trunk")
                if "policy" in components
                else None
            ),
            "relative_residual": math.sqrt(residual_sq) / math.sqrt(combined_sq) if combined_sq > 0 else 0.0,
        }
    before_step = [parameter.detach().clone() for parameter in parameters]
    gradient_norm = nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
    optimizer.step()
    effective_update = grouped_l2([
        (name, parameter.detach() - before)
        for name, parameter, before in zip(names, parameters, before_step)
    ])

    values_array = np.array(values)
    targets_array = np.array(recursion["targets"])
    returns_array = np.array(episode["discounted_return"], dtype=np.float64)
    residual = targets_array - values_array
    target_variance = float(np.var(targets_array))
    play_rows = int(np.sum(episode["card_index"] != 0))
    choice_mask = np.asarray(episode["card_mask"])[:, 1:].any(axis=1)
    choice_rows = int(choice_mask.sum())
    return {
        "rows": count,
        "play_rows": play_rows,
        "choice_rows": choice_rows,
        "environment_ticks": int(episode["header"]["result"]["tick"]),
        "gradient_norm": float(gradient_norm),
        "group_gradient_norms": group_norms,
        "gradient_decomposition": decomposition,
        "effective_update_l2": effective_update,
        "clipped": float(gradient_norm) > 1.0,
        "policy_loss_per_head": {head: value / count for head, value in head_policy_loss.items()},
        "entropy_per_head": {head: value / count for head, value in head_entropy.items()},
        # Conditional on the rows where the head actually chooses: card entropy
        # over rows with a legal non-PASS card, placement entropy over play rows.
        "card_entropy_given_choice": card_entropy_given_choice / choice_rows if choice_rows else None,
        "placement_entropy_given_play": head_entropy["placement"] / play_rows if play_rows else None,
        # On-policy KL(reference || model) over the card head, during the update.
        "card_kl_to_reference_given_choice": (
            card_kl_total / choice_rows if reference is not None and choice_rows else None
        ),
        # Fireball opportunity rows, counted when a reference is given.
        "opportunity_rows": opportunity_rows if reference is not None else None,
        "card_kl_to_reference_given_opportunity": (
            opportunity_card_kl_total / opportunity_rows
            if reference is not None and opportunity_rows else None
        ),
        "opportunity_by_class": by_class,
        "value_loss_vs_vtrace": value_loss_total / count,
        "critic_mse_vs_vtrace_before": float(np.mean(residual**2)),
        "critic_mse_vs_return_before": float(np.mean((returns_array - values_array) ** 2)),
        "critic_explained_variance_vs_vtrace": (
            None if target_variance == 0 else 1.0 - float(np.var(residual)) / target_variance
        ),
        "_advantages": recursion["advantages"],
        "_ratios": recursion["ratios"],
        "_choice_mask": choice_mask.tolist(),
        "_play_mask": (np.asarray(episode["card_index"]) != 0).tolist(),
        "_log_ratio_per_head": {
            "card": (np.array(head_logp["card"]) - np.array(episode["behavior_card_log_probability"])).tolist(),
            "placement": (
                np.array(head_logp["placement"]) - np.array(episode["behavior_placement_log_probability"])
            ).tolist(),
            "delay": (
                np.array(head_logp["delay"]) - np.array(episode["behavior_delay_log_probability"])
            ).tolist()
            if delay_mode == "learned"
            else [],
        },
    }


def distribution(values: list[float] | np.ndarray) -> dict[str, float | int | None]:
    array = np.asarray(values, dtype=np.float64)
    if array.size == 0:
        return {"count": 0}
    quantiles = np.quantile(array, [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
    return {
        "count": int(array.size),
        "mean": float(array.mean()),
        "std": float(array.std()),
        "min": float(array.min()),
        "p01": float(quantiles[0]),
        "p05": float(quantiles[1]),
        "p25": float(quantiles[2]),
        "p50": float(quantiles[3]),
        "p75": float(quantiles[4]),
        "p95": float(quantiles[5]),
        "p99": float(quantiles[6]),
        "max": float(array.max()),
        "fraction_positive": float(np.mean(array > 0)),
    }


# --------------------------------------------------------------------------
# Checkpoints and provenance


def provenance() -> dict[str, Any]:
    def git(*arguments: str) -> str:
        return subprocess.check_output(["git", *arguments], cwd=ROOT, text=True)

    try:
        diff = git("diff", "HEAD", "--binary")
        untracked = [
            path
            for path in git("ls-files", "--others", "--exclude-standard").splitlines()
            if path.startswith(("scripts/edger-v2-cadence", "tests/", "docs/"))
        ]
        untracked_digest = hashlib.sha256()
        for path in sorted(untracked):
            untracked_digest.update(path.encode())
            untracked_digest.update((ROOT / path).read_bytes())
        return {
            "head": git("rev-parse", "HEAD").strip(),
            "worktree_diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
            "untracked_experiment_files": sorted(untracked),
            "untracked_experiment_files_sha256": untracked_digest.hexdigest(),
            "note": "dirty worktree by design; diagnostic output, not authoritative training",
        }
    except (OSError, subprocess.CalledProcessError):
        return {"head": "unknown"}


def load_any_checkpoint(path: str | Path) -> tuple[dict[str, Any], training.EdgerV2Policy]:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    if payload.get("schema_version") == training.CHECKPOINT_SCHEMA:
        return training.load_checkpoint(path, torch.device("cpu"))
    if payload.get("schema_version") != DIAGNOSTIC_CHECKPOINT_SCHEMA:
        raise ValueError(f"unsupported checkpoint schema {payload.get('schema_version')}")
    model = training.EdgerV2Policy(
        max(1, len(payload["opponent_stratum_vocabulary"])),
        payload.get("action_space_version", training.ACTION_SCHEMA),
    )
    model.load_state_dict(payload["model_state"])
    return payload, model


def root_parent_id(checkpoint: dict[str, Any]) -> str:
    return checkpoint.get("root_parent_checkpoint_id") or checkpoint["checkpoint_id"]


def save_diagnostic_checkpoint(path: str | Path, payload: dict[str, Any]) -> None:
    output = Path(path)
    if output.exists():
        raise FileExistsError(f"diagnostic checkpoint already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, output)


def actor_differences(model: nn.Module, reference: nn.Module) -> list[str]:
    """Parameters outside the critic head that are not bit-identical."""
    reference_parameters = dict(reference.named_parameters())
    return [
        name
        for name, parameter in model.named_parameters()
        if name.split(".")[0] not in CRITIC_HEAD_MODULES
        and not torch.equal(parameter.detach(), reference_parameters[name].detach())
    ]


def check_warmup_start(
    checkpoint: dict[str, Any],
    model: nn.Module,
    parent_checkpoint: dict[str, Any],
    parent: nn.Module,
    *,
    delay_mode: str,
    loss_mode: str,
    reward_version: str,
) -> dict[str, Any]:
    """Refuse a warm start unless it is a critic_head warm-up of this parent.

    The warm-up must use the same cadence and reward, descend from the same
    root parent, and leave every actor and trunk parameter bit for bit the
    parent's, so the new arm differs from a cold start only in its critic.
    """
    if checkpoint.get("schema_version") != DIAGNOSTIC_CHECKPOINT_SCHEMA:
        raise ValueError("a warm start needs a diagnostic critic_head checkpoint")
    if checkpoint.get("loss_mode") != "critic_head":
        raise ValueError(f"a warm start needs a critic_head warm-up, not {checkpoint.get('loss_mode')}")
    if loss_mode == "critic_head":
        raise ValueError("a critic_head arm continues its warm-up; it does not warm start")
    if checkpoint.get("delay_mode") != delay_mode:
        raise ValueError("the warm-up used a different delay mode")
    if checkpoint.get("reward_version", DEFAULT_REWARD_VERSION) != reward_version:
        raise ValueError(
            f"the warm-up used reward {checkpoint.get('reward_version', DEFAULT_REWARD_VERSION)}, not {reward_version}"
        )
    if root_parent_id(checkpoint) != root_parent_id(parent_checkpoint):
        raise ValueError("the warm-up descends from a different parent")
    if checkpoint["opponent_stratum_vocabulary"] != parent_checkpoint["opponent_stratum_vocabulary"]:
        raise ValueError("the warm-up's opponent strata differ from the parent's")
    changed = actor_differences(model, parent)
    if changed:
        raise ValueError(f"the warm-up changed actor parameters: {', '.join(changed)}")
    return {
        "checkpoint_id": checkpoint["checkpoint_id"],
        "arm": checkpoint.get("arm"),
        "iteration": checkpoint.get("iteration"),
        "reward_version": reward_version,
    }


def parameter_drift(model: nn.Module, reference: nn.Module) -> dict[str, dict[str, float]]:
    reference_parameters = dict(reference.named_parameters())
    result = {}
    for group, prefixes in PARAMETER_GROUPS.items():
        delta = 0.0
        base = 0.0
        for name, parameter in model.named_parameters():
            if name.split(".")[0] in prefixes:
                source = reference_parameters[name].detach()
                delta += float((parameter.detach() - source).pow(2).sum())
                base += float(source.pow(2).sum())
        result[group] = {
            "l2": math.sqrt(delta),
            "relative_l2": math.sqrt(delta) / math.sqrt(base) if base > 0 else None,
        }
    return result


# --------------------------------------------------------------------------
# Commands


def run_train_iteration(args: argparse.Namespace) -> None:
    if args.delay_mode not in DELAY_MODES:
        raise ValueError(f"--delay-mode must be one of {DELAY_MODES}")
    if args.loss_mode not in LOSS_MODES:
        raise ValueError(f"--loss-mode must be one of {LOSS_MODES}")
    reward_version = getattr(args, "reward_version", DEFAULT_REWARD_VERSION)
    if reward_version not in REWARD_VERSIONS:
        raise ValueError(f"--reward-version must be one of {REWARD_VERSIONS}")
    opportunity_card_weight = float(getattr(args, "opportunity_card_weight", 1.0))
    opportunity_card_weight_classes = getattr(args, "opportunity_card_weight_classes", "both")
    training.seed_everything(args.seed)
    checkpoint, model = load_any_checkpoint(args.checkpoint)
    parent_checkpoint, parent = load_any_checkpoint(args.parent)
    parent.eval()
    action_space = model.action_space_version
    if parent.action_space_version != action_space:
        raise ValueError("checkpoint and parent action spaces differ")
    vocab = checkpoint["opponent_stratum_vocabulary"]
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    optimizer_restored = False
    start_from_warmup = bool(getattr(args, "start_from_warmup", False))
    warm_start = None
    if start_from_warmup:
        # A new arm whose weights come from a finished critic_head warm-up,
        # with fresh Adam, as from a BC parent. Only its critic may differ.
        warm_start = check_warmup_start(
            checkpoint, model, parent_checkpoint, parent,
            delay_mode=args.delay_mode, loss_mode=args.loss_mode, reward_version=reward_version,
        )
        warm_start["checkpoint_sha256"] = training.sha256_file(args.checkpoint)
    elif checkpoint.get("schema_version") == DIAGNOSTIC_CHECKPOINT_SCHEMA:
        warm_start = checkpoint.get("warm_start")
        if checkpoint["delay_mode"] != args.delay_mode:
            raise ValueError("delay mode changed within an arm")
        if checkpoint.get("loss_mode", "full") != args.loss_mode:
            raise ValueError("loss mode changed within an arm")
        if checkpoint.get("card_kl_coefficient", 0.0) != args.card_kl_coefficient:
            raise ValueError("card KL coefficient changed within an arm")
        if checkpoint.get("card_kl_rows", "all") != args.card_kl_rows:
            raise ValueError("card KL rows changed within an arm")
        if checkpoint.get("opportunity_card_weight", 1.0) != opportunity_card_weight:
            raise ValueError("opportunity card weight changed within an arm")
        if checkpoint.get("opportunity_card_weight_classes", "both") != opportunity_card_weight_classes:
            raise ValueError("opportunity card weight classes changed within an arm")
        if checkpoint.get("reward_version", DEFAULT_REWARD_VERSION) != reward_version:
            raise ValueError("reward version changed within an arm")
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        optimizer_restored = True
    collection = json.loads(Path(args.collection).read_text())
    if collection.get("reward_version", DEFAULT_REWARD_VERSION) != reward_version:
        raise ValueError(
            f"collection reward version {collection.get('reward_version')} is not {reward_version}"
        )
    if collection.get("action_space_version", training.ACTION_SCHEMA) != action_space:
        raise ValueError("collection and checkpoint action spaces differ")
    episode_paths = [Path(item["header"]) for item in sorted(collection["episodes"], key=lambda item: item["match_index"])]

    updates = []
    advantages: list[float] = []
    ratios: list[float] = []
    choice_mask: list[bool] = []
    play_mask: list[bool] = []
    log_ratios = {"card": [], "placement": [], "delay": []}
    started = time.perf_counter()
    for index, path in enumerate(episode_paths):
        episode = load_cadence_episode(path)
        if episode["header"].get("reward_version", DEFAULT_REWARD_VERSION) != reward_version:
            raise ValueError(
                f"episode {path} reward version {episode['header'].get('reward_version')} is not {reward_version}"
            )
        if episode["header"].get("action_space_version", training.ACTION_SCHEMA) != action_space:
            raise ValueError(f"episode {path} and checkpoint action spaces differ")
        stratum = episode_stratum(episode["header"], vocab)
        update = train_cadence_episode(
            model,
            episode,
            optimizer,
            delay_mode=args.delay_mode,
            stratum=stratum,
            batch_size=args.batch_size,
            value_loss_weight=args.value_loss_weight,
            entropy_bonus=args.entropy_bonus,
            loss_mode=args.loss_mode,
            decompose=args.decompose_every > 0 and index % args.decompose_every == 0,
            reference=parent,
            card_kl_coefficient=args.card_kl_coefficient,
            card_kl_rows=args.card_kl_rows,
            opportunity_card_weight=opportunity_card_weight,
            opportunity_card_weight_classes=opportunity_card_weight_classes,
        )
        advantages.extend(update.pop("_advantages"))
        ratios.extend(update.pop("_ratios"))
        choice_mask.extend(update.pop("_choice_mask"))
        play_mask.extend(update.pop("_play_mask"))
        for head, values in update.pop("_log_ratio_per_head").items():
            log_ratios[head].extend(values)
        update["episode_id"] = episode["header"]["episode_id"]
        updates.append(update)
    learner_seconds = time.perf_counter() - started

    def weighted_mean(key: str, head: str | None = None) -> float:
        total_rows = sum(update["rows"] for update in updates)
        if head is None:
            return sum(update[key] * update["rows"] for update in updates) / total_rows
        return sum(update[key][head] * update["rows"] for update in updates) / total_rows

    norms = [update["gradient_norm"] for update in updates]
    choice = np.asarray(choice_mask, dtype=bool)
    play = np.asarray(play_mask, dtype=bool)
    ratio_array = np.asarray(ratios)
    advantage_array = np.abs(np.asarray(advantages))
    card_log_ratio = np.asarray(log_ratios["card"])
    total_rows = sum(update["rows"] for update in updates)
    choice_rows = int(choice.sum())
    play_rows = int(play.sum())
    opportunity_rows = sum(update["opportunity_rows"] for update in updates)
    by_class = {}
    for name in training.OPPORTUNITY_CLASSES:
        totals = {key: sum(update["opportunity_by_class"][name][key] for update in updates)
                  for key in updates[0]["opportunity_by_class"][name]} if updates else {}
        other_rows = totals.get("rows", 0) - totals.get("fireball_rows", 0)
        by_class[name] = {
            "rows": totals.get("rows", 0),
            "fireball_rows": totals.get("fireball_rows", 0),
            "weighted_rows": totals.get("weighted_rows", 0),
            "mean_advantage_fireball": (
                totals["advantage_sum_fireball"] / totals["fireball_rows"] if totals.get("fireball_rows") else None
            ),
            "mean_advantage_other": totals["advantage_sum_other"] / other_rows if other_rows else None,
        }
    decomposed = [update["gradient_decomposition"] for update in updates if update["gradient_decomposition"]]
    cosines = [item["trunk_cosine_policy_value"] for item in decomposed if item["trunk_cosine_policy_value"] is not None]
    metrics = {
        "arm": args.arm,
        "delay_mode": args.delay_mode,
        "loss_mode": args.loss_mode,
        "reward_version": reward_version,
        "warm_start": warm_start,
        "decompose_every": args.decompose_every,
        "iteration": args.iteration,
        "learning_rate": args.learning_rate,
        "batch_size": args.batch_size,
        "value_loss_weight": args.value_loss_weight,
        "entropy_bonus": args.entropy_bonus,
        "card_kl_coefficient": args.card_kl_coefficient,
        "card_kl_rows": args.card_kl_rows,
        "opportunity_card_weight": opportunity_card_weight,
        "opportunity_card_weight_classes": opportunity_card_weight_classes,
        "optimizer_restored": optimizer_restored,
        "budget": {
            "episodes": len(updates),
            "optimizer_updates": len(updates),
            "environment_ticks": sum(update["environment_ticks"] for update in updates),
            "eligible_decision_rows": sum(update["rows"] for update in updates),
            "play_rows": sum(update["play_rows"] for update in updates),
            "learner_seconds": learner_seconds,
        },
        "gradient_norms": {
            **training.gradient_norm_summary(args.iteration, norms),
            "per_group_mean": {
                group: sum(update["group_gradient_norms"][group] for update in updates) / len(updates)
                for group in PARAMETER_GROUPS
            },
            "per_group_max": {
                group: max(update["group_gradient_norms"][group] for update in updates)
                for group in PARAMETER_GROUPS
            },
        },
        "policy_loss_per_head_row_weighted": {
            head: weighted_mean("policy_loss_per_head", head) for head in ("card", "placement", "delay")
        },
        "entropy_per_head_row_weighted": {
            head: weighted_mean("entropy_per_head", head) for head in ("card", "placement", "delay")
        },
        "critic": {
            "mse_vs_vtrace_before_row_weighted": weighted_mean("critic_mse_vs_vtrace_before"),
            "mse_vs_return_before_row_weighted": weighted_mean("critic_mse_vs_return_before"),
            "explained_variance_vs_vtrace_mean": float(
                np.mean([
                    update["critic_explained_variance_vs_vtrace"]
                    for update in updates
                    if update["critic_explained_variance_vs_vtrace"] is not None
                ])
            ),
        },
        "advantage_distribution": distribution(advantages),
        "importance_ratio_distribution": {
            **distribution(ratios),
            "fraction_clipped_above_1": float(np.mean(np.asarray(ratios) > 1.0)),
            "fraction_below_0_5": float(np.mean(np.asarray(ratios) < 0.5)),
        },
        "log_ratio_per_head": {head: distribution(values) for head, values in log_ratios.items()},
        # Row-weighted averages above are diluted by forced and chosen PASS
        # rows; these condition on rows where the actor had a real choice.
        "conditional": {
            "rows": total_rows,
            "forced_pass_rows": total_rows - choice_rows,
            "choice_rows": choice_rows,
            "play_rows": play_rows,
            "forced_pass_fraction": (total_rows - choice_rows) / total_rows,
            "play_fraction_of_choice_rows": play_rows / choice_rows if choice_rows else None,
            "card_entropy_given_choice": (
                sum(update["card_entropy_given_choice"] * update["choice_rows"]
                    for update in updates if update["choice_rows"]) / choice_rows
                if choice_rows else None
            ),
            "placement_entropy_given_play": (
                sum(update["entropy_per_head"]["placement"] * update["rows"] for update in updates) / play_rows
                if play_rows else None
            ),
            "card_kl_to_reference_given_choice": (
                sum(update["card_kl_to_reference_given_choice"] * update["choice_rows"]
                    for update in updates if update["choice_rows"]) / choice_rows
                if choice_rows else None
            ),
            "opportunity_rows": opportunity_rows,
            "opportunity_by_class": by_class,
            "card_kl_to_reference_given_opportunity": (
                sum(update["card_kl_to_reference_given_opportunity"] * update["opportunity_rows"]
                    for update in updates if update["opportunity_rows"]) / opportunity_rows
                if opportunity_rows else None
            ),
            "importance_ratio_given_choice": {
                **distribution(ratio_array[choice]),
                "fraction_clipped_above_1": float(np.mean(ratio_array[choice] > 1.0)) if choice_rows else None,
            },
            "importance_ratio_given_play": distribution(ratio_array[play]),
            "card_log_ratio_given_choice": distribution(card_log_ratio[choice]),
            "abs_advantage_mean_given_choice": float(advantage_array[choice].mean()) if choice_rows else None,
            "abs_advantage_mean_forced_pass": (
                float(advantage_array[~choice].mean()) if total_rows > choice_rows else None
            ),
        },
        # Separate policy/value/entropy gradients on sampled updates, measured
        # before clipping; the applied step is the unchanged combined gradient.
        "gradient_decomposition": {
            "episodes": len(decomposed),
            "per_component_group_mean": (
                {
                    component: {
                        group: float(np.mean([item["group_norms"][component][group] for item in decomposed]))
                        for group in PARAMETER_GROUPS
                    }
                    for component in decomposed[0]["group_norms"]
                }
                if decomposed else None
            ),
            "trunk_cosine_policy_value": distribution(cosines),
            "relative_residual_max": max((item["relative_residual"] for item in decomposed), default=None),
        },
        "effective_update_l2": {
            "per_group_mean": {
                group: float(np.mean([update["effective_update_l2"][group] for update in updates]))
                for group in PARAMETER_GROUPS
            },
        },
        "parameter_drift_from_parent": parameter_drift(model, parent),
        "updates": updates,
    }
    payload = {
        "schema_version": DIAGNOSTIC_CHECKPOINT_SCHEMA,
        **({"action_space_version": action_space} if action_space != training.ACTION_SCHEMA else {}),
        "promotion_status": PROMOTION_STATUS,
        "checkpoint_id": f"edger_v2_cadence_{args.arm}_iter{args.iteration}",
        "root_parent_checkpoint_id": root_parent_id(checkpoint),
        "input_checkpoint_sha256": training.sha256_file(args.checkpoint),
        "arm": args.arm,
        "delay_mode": args.delay_mode,
        "loss_mode": args.loss_mode,
        "reward_version": reward_version,
        "card_kl_coefficient": args.card_kl_coefficient,
        "card_kl_rows": args.card_kl_rows,
        "opportunity_card_weight": opportunity_card_weight,
        "opportunity_card_weight_classes": opportunity_card_weight_classes,
        "warm_start": warm_start,
        "iteration": args.iteration,
        "seed": args.seed,
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
        "opponent_stratum_vocabulary": vocab,
        "collection": str(Path(args.collection).resolve()),
        "collection_sha256": training.sha256_file(args.collection),
        "environment": training.environment_metadata(),
        "provenance": provenance(),
        "metrics": {key: value for key, value in metrics.items() if key != "updates"},
    }
    save_diagnostic_checkpoint(args.out, payload)
    Path(args.metrics_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.metrics_out).write_text(json.dumps(metrics, indent=1) + "\n")
    summary = {key: value for key, value in metrics.items() if key != "updates"}
    print(json.dumps(summary, indent=1))


def run_export(args: argparse.Namespace) -> None:
    checkpoint, model = load_any_checkpoint(args.checkpoint)
    model.eval()
    shim = {
        "phase": f"cadence_diagnostic_{checkpoint.get('delay_mode', 'parent')}_{checkpoint.get('loss_mode', 'full')}",
        "seed": checkpoint.get("seed"),
        "git_commit": checkpoint.get("provenance", {}).get("head", checkpoint.get("git_commit")),
        "checkpoint_id": checkpoint["checkpoint_id"],
        "parent_checkpoint": root_parent_id(checkpoint),
        "manifest_hash": None,
        "dataset_checksum": checkpoint.get("collection_sha256"),
        "environment": checkpoint.get("environment"),
        "metrics": {},
    }
    payload = training.export_model_payload(shim, model, args.model_id or checkpoint["checkpoint_id"])
    payload["training"]["promotion_status"] = PROMOTION_STATUS
    payload["training"]["diagnostic_provenance"] = checkpoint.get("provenance")
    output = Path(args.out)
    if output.exists():
        raise FileExistsError(f"export already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n")
    print(json.dumps({"model": str(output.resolve()), "model_id": payload["model_id"]}))


# ---------------------------------------------------------------------------
# Candidate campaign lineage (docs/EDGER_CANDIDATE_CAMPAIGN.md, owner decision
# of November 23, 2026). A campaign's runs are ordinary train-arm runs; only
# the selected run's final checkpoint may be exported as a candidate, and only
# after its whole lineage matches the campaign manifest and the measured
# recipe below. Every other export stays diagnostic_only_not_promotable.

CANDIDATE_MANIFEST_SCHEMA = "edger_v2_candidate_campaign_manifest_v1"
CANDIDATE_SELECTION_SCHEMA = "edger_v2_candidate_selection_v1"
CANDIDATE_BINDING_SCHEMA = "edger_v2_candidate_export_binding_v1"
CANDIDATE_PROMOTION_STATUS = "shadow_candidate_unreviewed"
EMPTY_DIFF_SHA256 = hashlib.sha256(b"").hexdigest()
# The eighth comparison's arm A: initialize-full-grid from a default-recipe BC
# parent, then train-arm with these settings and nothing else.
CANDIDATE_RECIPE = {
    "cadence": "learned",
    "loss_mode": "full",
    "reward_version": "edger_potential_reward_v1",
    "card_kl_coefficient": 0,
    "opportunity_card_weight": 1,
    "opportunity_card_weight_classes": "both",
    "warm_start": False,
    "opponent_mix": "plan",
    "iterations": 24,
    "pairs_per_iteration": 32,
    "torch_seed": 20260926,
    "learning_rate": 0.001,
    "decompose_every": 0,
    "action_space_version": training.FULL_GRID_ACTION_SCHEMA,
    "bc_card_teacher_filter": "none",
    "bc_opportunity_oversample": 1,
}


class LineageError(ValueError):
    pass


def git_state(root: Path = ROOT) -> dict[str, Any]:
    def git(*arguments: str) -> str:
        return subprocess.check_output(["git", *arguments], cwd=root, text=True)

    return {
        "head": git("rev-parse", "HEAD").strip(),
        "clean": git("status", "--porcelain", "--untracked-files=normal").strip() == "",
    }


def read_json_file(path: str | Path) -> Any:
    return json.loads(Path(path).read_text())


def export_weights(checkpoint: dict[str, Any], model: training.EdgerV2Policy) -> dict[str, Any]:
    shim = {
        "phase": "lineage_check", "seed": None, "git_commit": None, "checkpoint_id": "lineage_check",
        "parent_checkpoint": None, "manifest_hash": None, "dataset_checksum": None, "environment": None,
        "metrics": {},
    }
    return training.export_model_payload(shim, model, "lineage_check")["weights"]


def run_lineage(entry: dict[str, Any]) -> dict[str, Any]:
    """Hashes and recorded settings of one campaign run, read from disk.

    ``entry`` names the run, its BC seed, BC checkpoint, seed plan and
    train-arm work directory (initial.pt/json, arm-status.json, iter<i>/)."""
    work = Path(entry["work_dir"])
    bc_checkpoint = torch.load(entry["bc_checkpoint"], map_location="cpu", weights_only=False)
    initial_checkpoint = torch.load(work / "initial.pt", map_location="cpu", weights_only=False)
    status_path = work / "arm-status.json"
    status = read_json_file(status_path)
    chain = []
    # A stopped iteration (collapse, learner failure) has a record but no
    # checkpoint; the chain holds completed iterations only.
    for record in status["iterations"]:
        if not record.get("checkpoint_sha256"):
            continue
        folder = work / f"iter{record['iteration']}"
        chain.append({
            "iteration": record["iteration"],
            "collection_sha256": training.sha256_file(folder / "collection.json"),
            "checkpoint_sha256": training.sha256_file(folder / "checkpoint.pt"),
            "model_sha256": training.sha256_file(folder / "model.json"),
        })
    recipe = bc_checkpoint.get("metrics", {}).get("data_recipe", {})
    return {
        "run": entry["run"],
        "bc": {
            "checkpoint": str(Path(entry["bc_checkpoint"]).resolve()),
            "sha256": training.sha256_file(entry["bc_checkpoint"]),
            "checkpoint_id": bc_checkpoint.get("checkpoint_id"),
            "phase": bc_checkpoint.get("phase"),
            "seed": bc_checkpoint.get("seed"),
            "parent_checkpoint": bc_checkpoint.get("parent_checkpoint"),
            "dataset_checksum": bc_checkpoint.get("dataset_checksum"),
            "git_commit": bc_checkpoint.get("git_commit"),
            "card_teacher_filter": recipe.get("card_teacher_filter"),
            "opportunity_oversample": recipe.get("opportunity_oversample"),
        },
        "initial": {
            "checkpoint_sha256": training.sha256_file(work / "initial.pt"),
            "checkpoint_id": initial_checkpoint.get("checkpoint_id"),
            "model_sha256": training.sha256_file(work / "initial.json"),
            "phase": initial_checkpoint.get("phase"),
            "source_checkpoint_sha256": initial_checkpoint.get("metrics", {}).get("source_checkpoint_sha256"),
            "parent_checkpoint": initial_checkpoint.get("parent_checkpoint"),
            "action_space_version": initial_checkpoint.get("action_space_version"),
            "git_commit": initial_checkpoint.get("git_commit"),
        },
        "plan": {"path": str(Path(entry["plan"]).resolve()), "sha256": training.sha256_file(entry["plan"])},
        "work_dir": str(work.resolve()),
        "arm_status_sha256": training.sha256_file(status_path),
        "arm": status.get("arm"),
        "stop_reason": status.get("stop_reason"),
        "resumed_at_iteration": status.get("resumed_at_iteration"),
        "chain": chain,
    }


def lineage_problems(
    entry: dict[str, Any], lineage: dict[str, Any], *, git_commit: str, bc_dataset_sha256: str,
    recipe: dict[str, Any] = CANDIDATE_RECIPE,
) -> list[str]:
    """Every way a run differs from the campaign and the recipe; [] if none."""
    problems: list[str] = []

    def expect(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    work = Path(entry["work_dir"])
    bc = lineage["bc"]
    expect(bc["phase"] == "bc" and bc["parent_checkpoint"] is None, "the BC parent is not a fresh BC checkpoint")
    expect(bc["seed"] == entry["bc_seed"], f"the BC parent's seed {bc['seed']} is not {entry['bc_seed']}")
    expect(bc["dataset_checksum"] == bc_dataset_sha256, "the BC parent was trained on another dataset")
    expect(bc["git_commit"] == git_commit, "the BC parent was trained at another commit")
    expect(bc["card_teacher_filter"] == recipe["bc_card_teacher_filter"]
           and bc["opportunity_oversample"] == recipe["bc_opportunity_oversample"],
           "the BC parent did not use the default data recipe")
    initial = lineage["initial"]
    expect(initial["phase"] == "full_grid_initialization"
           and initial["source_checkpoint_sha256"] == bc["sha256"]
           and initial["parent_checkpoint"] == bc["checkpoint_id"],
           "initial.pt is not the full-grid initialization of the BC parent")
    expect(initial["action_space_version"] == recipe["action_space_version"], "initial.pt is not full grid")
    expect(initial["git_commit"] == git_commit, "initial.pt was written at another commit")
    initial_checkpoint, initial_model = load_any_checkpoint(work / "initial.pt")
    expect(read_json_file(work / "initial.json")["weights"] == export_weights(initial_checkpoint, initial_model),
           "initial.json is not the export of initial.pt")

    status = read_json_file(work / "arm-status.json")
    settings = {
        "cadence": status.get("cadence"),
        "loss_mode": status.get("loss_mode"),
        "reward_version": status.get("reward_version"),
        "card_kl_coefficient": status.get("card_kl_coefficient"),
        "opportunity_card_weight": status.get("opportunity_card_weight"),
        "opportunity_card_weight_classes": status.get("opportunity_card_weight_classes"),
        "warm_start": "initial_checkpoint" in status,
        "opponent_mix": status.get("opponent_mix", "plan"),
        "iterations": status.get("iterations_planned"),
        "pairs_per_iteration": status.get("pairs_per_iteration"),
        "torch_seed": status.get("torch_seed"),
        "learning_rate": status.get("learning_rate"),
        "decompose_every": status.get("decompose_every"),
    }
    for key, value in settings.items():
        expect(value == recipe[key], f"arm setting {key} is {value!r}, not {recipe[key]!r}")
    expect("snapshot_league" not in status, "the arm used a snapshot league")
    expect(status.get("parent_checkpoint_sha256") == initial["checkpoint_sha256"]
           and status.get("parent_model_sha256") == initial["model_sha256"],
           "the arm did not start from initial.pt and initial.json")
    expect(status.get("seeds_file_sha256") == lineage["plan"]["sha256"], "the arm trained on another seed plan")
    expect(status.get("stop_reason") == "completed", f"the arm stopped with {status.get('stop_reason')!r}")
    iterations = [record["iteration"] for record in status["iterations"]]
    expect(iterations == list(range(recipe["iterations"])) and all(
        record.get("checkpoint_sha256") for record in status["iterations"]),
        "the arm did not complete every iteration")
    if problems:
        return problems

    plan = read_json_file(entry["plan"])
    pairs = recipe["pairs_per_iteration"]
    previous_checkpoint = initial["checkpoint_sha256"]
    previous_model = initial["model_sha256"]
    for record, link in zip(status["iterations"], lineage["chain"]):
        iteration = record["iteration"]
        folder = work / f"iter{iteration}"
        label = f"iteration {iteration}"
        expect(record["checkpoint_sha256"] == link["checkpoint_sha256"]
               and record["model_sha256"] == link["model_sha256"], f"{label}: files differ from the arm status")
        expect(record["input_model_sha256"] == previous_model, f"{label}: played by another model")
        collection = read_json_file(folder / "collection.json")
        expect(collection.get("iteration") == iteration and collection.get("cadence") == recipe["cadence"]
               and collection.get("reward_version") == recipe["reward_version"]
               and collection.get("action_space_version") == recipe["action_space_version"]
               and collection.get("model_sha256") == previous_model
               and "snapshot_league" not in collection and "opponent_mix" not in collection,
               f"{label}: the collection is not a plan rollout of the previous model")
        episodes = collection.get("episodes", [])
        played = sorted((int(episode["episode_id"].split("-pair")[1].split("-")[0]), episode["candidate_actor"],
                         episode["seed"], episode["opponent"], "opponent_model_sha256" in episode)
                        for episode in episodes)
        expected = sorted((index, actor, plan["training"][index], plan["training_opponents"][index], False)
                          for index in range(iteration * pairs, (iteration + 1) * pairs)
                          for actor in ("blue", "red"))
        expect(played == expected, f"{label}: the games are not the plan's pairs")
        checkpoint, model = load_any_checkpoint(folder / "checkpoint.pt")
        provenance_ = checkpoint.get("provenance", {})
        learning_rates = {group["lr"] for group in checkpoint.get("optimizer_state", {}).get("param_groups", [])}
        expect(checkpoint.get("schema_version") == DIAGNOSTIC_CHECKPOINT_SCHEMA
               and checkpoint.get("iteration") == iteration and checkpoint.get("arm") == lineage["arm"]
               and checkpoint.get("delay_mode") == recipe["cadence"]
               and checkpoint.get("loss_mode") == recipe["loss_mode"]
               and checkpoint.get("reward_version") == recipe["reward_version"]
               and checkpoint.get("card_kl_coefficient") == recipe["card_kl_coefficient"]
               and checkpoint.get("opportunity_card_weight") == recipe["opportunity_card_weight"]
               and not checkpoint.get("warm_start")
               and checkpoint.get("seed") == recipe["torch_seed"]
               and checkpoint.get("action_space_version") == recipe["action_space_version"]
               and learning_rates == {recipe["learning_rate"]},
               f"{label}: the checkpoint's settings are not the recipe's")
        expect(checkpoint.get("input_checkpoint_sha256") == previous_checkpoint
               and checkpoint.get("collection_sha256") == link["collection_sha256"]
               and checkpoint.get("root_parent_checkpoint_id") == initial["checkpoint_id"],
               f"{label}: the checkpoint does not continue the chain")
        expect(provenance_.get("head") == git_commit and provenance_.get("worktree_diff_sha256") == EMPTY_DIFF_SHA256
               and provenance_.get("untracked_experiment_files") == [],
               f"{label}: the learner did not run on the clean campaign commit")
        expect(read_json_file(folder / "model.json")["weights"] == export_weights(checkpoint, model),
               f"{label}: model.json is not the export of its checkpoint")
        previous_checkpoint = link["checkpoint_sha256"]
        previous_model = link["model_sha256"]
    return problems


def build_candidate_manifest(
    runs: list[dict[str, Any]], *, campaign_id: str, bc_dataset_sha256: str, out: str | Path,
    recipe: dict[str, Any] = CANDIDATE_RECIPE,
) -> dict[str, Any]:
    """The campaign manifest: every run's lineage, written once after training.
    Tests pass a smaller recipe; the command always uses CANDIDATE_RECIPE."""
    state = git_state()
    if not state["clean"]:
        raise LineageError("the campaign manifest needs a clean checkout of the campaign commit")
    entries = []
    for entry in runs:
        status_path = Path(entry["work_dir"]) / "arm-status.json"
        record = {"run": entry["run"], "bc_seed": entry["bc_seed"], "entry": entry}
        if not Path(entry["bc_checkpoint"]).exists() or not status_path.exists():
            record.update({"lineage": None, "problems": ["the run did not train"]})
        else:
            try:
                record["lineage"] = run_lineage(entry)
                record["problems"] = lineage_problems(
                    entry, record["lineage"], git_commit=state["head"], bc_dataset_sha256=bc_dataset_sha256,
                    recipe=recipe)
            except (OSError, KeyError, ValueError, RuntimeError) as error:
                record.setdefault("lineage", None)
                record["problems"] = [f"the lineage could not be read: {type(error).__name__}: {error}"]
        record["lineage_valid"] = record["problems"] == []
        entries.append(record)
    manifest = {
        "schema_version": CANDIDATE_MANIFEST_SCHEMA,
        "campaign_id": campaign_id,
        "git_commit": state["head"],
        "recipe": recipe,
        "bc_dataset_sha256": bc_dataset_sha256,
        "runs": entries,
    }
    output = Path(out)
    if output.exists():
        raise FileExistsError(f"campaign manifest already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=1) + "\n")
    return manifest


def run_candidate_manifest(args: argparse.Namespace) -> None:
    manifest = build_candidate_manifest(
        read_json_file(args.runs), campaign_id=args.campaign_id, bc_dataset_sha256=args.bc_dataset_sha256,
        out=args.out)
    print(json.dumps({"manifest": str(Path(args.out).resolve()), "sha256": training.sha256_file(args.out),
                      "lineage_valid": [entry["run"] for entry in manifest["runs"] if entry["lineage_valid"]]}))


def verify_candidate(
    manifest_path: Path, selection_path: Path, run: str, *, recipe: dict[str, Any] = CANDIDATE_RECIPE,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The manifest entry of the selected run, re-verified from disk."""
    state = git_state()
    manifest = read_json_file(manifest_path)
    if manifest.get("schema_version") != CANDIDATE_MANIFEST_SCHEMA:
        raise LineageError(f"{manifest_path} is not a campaign manifest")
    if state["head"] != manifest["git_commit"] or not state["clean"]:
        raise LineageError("export a candidate only from a clean checkout of the campaign commit")
    if manifest.get("recipe") != recipe:
        raise LineageError("the manifest's recipe is not the measured recipe")
    selection = read_json_file(selection_path)
    if selection.get("schema_version") != CANDIDATE_SELECTION_SCHEMA:
        raise LineageError(f"{selection_path} is not a campaign selection")
    if selection.get("manifest_sha256") != training.sha256_file(manifest_path):
        raise LineageError("the selection was made on another manifest")
    if selection.get("selected") != run:
        raise LineageError(f"run {run} was not selected (selected: {selection.get('selected')})")
    entries = [entry for entry in manifest["runs"] if entry["run"] == run]
    if len(entries) != 1:
        raise LineageError(f"the manifest holds {len(entries)} entries for run {run}")
    entry = entries[0]
    if not entry.get("lineage_valid") or entry.get("problems"):
        raise LineageError(f"run {run} failed its lineage check: {entry.get('problems')}")
    lineage = run_lineage(entry["entry"])
    if lineage != entry["lineage"]:
        raise LineageError(f"run {run}'s files no longer match the manifest")
    problems = lineage_problems(entry["entry"], lineage, git_commit=manifest["git_commit"],
                                bc_dataset_sha256=manifest["bc_dataset_sha256"], recipe=recipe)
    if problems:
        raise LineageError(f"run {run} failed its lineage check: {problems}")
    return manifest, entry


def export_candidate(
    manifest: str | Path, selection: str | Path, run: str, out: str | Path, binding_out: str | Path, *,
    recipe: dict[str, Any] = CANDIDATE_RECIPE,
) -> dict[str, Any]:
    """Label the selected run's final checkpoint a candidate; returns the binding."""
    manifest_path, selection_path = Path(manifest), Path(selection)
    for path in (Path(out), Path(binding_out)):
        if path.exists():
            raise FileExistsError(f"already exists: {path}")
    manifest, entry = verify_candidate(manifest_path, selection_path, run, recipe=recipe)
    final = entry["lineage"]["chain"][-1]
    folder = Path(entry["lineage"]["work_dir"]) / f"iter{final['iteration']}"
    checkpoint, model = load_any_checkpoint(folder / "checkpoint.pt")
    model.eval()
    manifest_sha256 = training.sha256_file(manifest_path)
    shim = {
        "phase": "candidate_campaign_learned_full",
        "seed": checkpoint["seed"],
        "git_commit": manifest["git_commit"],
        "checkpoint_id": checkpoint["checkpoint_id"],
        "parent_checkpoint": root_parent_id(checkpoint),
        "manifest_hash": None,
        "dataset_checksum": checkpoint.get("collection_sha256"),
        "environment": checkpoint.get("environment"),
        "metrics": {},
    }
    payload = training.export_model_payload(shim, model, f"edger_v2_candidate_{manifest['campaign_id']}_{run}")
    if payload["weights"] != read_json_file(folder / "model.json")["weights"]:
        raise LineageError("the candidate's weights differ from the selected model")
    payload["training"]["promotion_status"] = CANDIDATE_PROMOTION_STATUS
    payload["training"]["campaign"] = {
        "campaign_id": manifest["campaign_id"],
        "manifest_sha256": manifest_sha256,
        "selection_sha256": training.sha256_file(selection_path),
        "run": run,
        "checkpoint_sha256": final["checkpoint_sha256"],
        "bc_checkpoint_sha256": entry["lineage"]["bc"]["sha256"],
    }
    payload["training"]["diagnostic_provenance"] = checkpoint.get("provenance")
    output, binding_output = Path(out), Path(binding_out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n")
    binding = {
        "schema_version": CANDIDATE_BINDING_SCHEMA,
        **payload["training"]["campaign"],
        "model_id": payload["model_id"],
        "export": str(output.resolve()),
        "export_sha256": training.sha256_file(output),
        "export_weights_sha256": training.sha256_bytes(training.canonical_json(payload["weights"]).encode()),
    }
    binding_output.parent.mkdir(parents=True, exist_ok=True)
    binding_output.write_text(json.dumps(binding, indent=1) + "\n")
    return binding


def run_export_candidate(args: argparse.Namespace) -> None:
    print(json.dumps(export_candidate(args.manifest, args.selection, args.run, args.out, args.binding_out)))


def probe_tensors(probes: list[dict[str, Any]]) -> dict[str, Tensor]:
    count = len(probes)
    board = torch.zeros(count, training.BOARD_HEIGHT * training.BOARD_WIDTH * training.BOARD_INPUT_CHANNELS)
    placement_by_card = torch.zeros(count, training.CARD_ACTIONS, training.PLACEMENTS, dtype=torch.bool)
    for index, probe in enumerate(probes):
        board[index, probe["board_indices"]] = torch.tensor(probe["board_values"], dtype=torch.float32)
        for card, cells in enumerate(probe["placement_by_card"]):
            placement_by_card[index, card, cells] = True
    return {
        "board": board.reshape(count, training.BOARD_HEIGHT, training.BOARD_WIDTH, training.BOARD_INPUT_CHANNELS),
        "global": torch.tensor([probe["global"] for probe in probes], dtype=torch.float32),
        "card_mask": torch.tensor([probe["card_mask"] for probe in probes], dtype=torch.bool),
        "placement_by_card": placement_by_card,
        "card": torch.tensor([probe["card_index"] for probe in probes], dtype=torch.long),
        "placement": torch.tensor([probe["placement_index"] for probe in probes], dtype=torch.long),
    }


def run_probe(args: argparse.Namespace) -> None:
    _, model = load_any_checkpoint(args.checkpoint)
    _, parent = load_any_checkpoint(args.parent)
    model.eval()
    parent.eval()
    report: dict[str, Any] = {"checkpoint": str(Path(args.checkpoint).resolve())}
    for probe_path in args.probes:
        probes = json.loads(Path(probe_path).read_text())["probes"]
        tensors = probe_tensors(probes)
        totals = {
            "states": 0, "card_legal_states": 0, "card_kl_sum": 0.0, "card_agree": 0,
            "card_pass_model": 0, "card_pass_parent": 0, "play_states": 0,
            "placement_kl_sum": 0.0, "placement_agree": 0, "delay_kl_sum": 0.0,
            "delay_agree": 0, "parent_card_nll_sum": 0.0, "parent_placement_nll_sum": 0.0,
        }
        with torch.no_grad():
            for start, end in microbatch_ranges(len(probes), 256):
                board = tensors["board"][start:end]
                global_features = tensors["global"][start:end]
                card_mask = tensors["card_mask"][start:end]
                parent_card_logits = parent.actor_logits(board, global_features, tensors["card"][start:end], tensors["placement"][start:end])
                # Parent argmax card/placement condition the placement and delay heads.
                parent_card = tensors["card"][start:end]
                parent_placement = tensors["placement"][start:end]
                model_logits = model.actor_logits(board, global_features, parent_card, parent_placement)
                count = end - start
                legal_cards = card_mask.sum(dim=1) > 1
                card_kl = training.categorical_kl(parent_card_logits["card"], model_logits["card"], card_mask)
                model_card = training.mask_logits(model_logits["card"], card_mask).argmax(dim=1)
                totals["states"] += count
                totals["card_legal_states"] += int(legal_cards.sum())
                totals["card_kl_sum"] += float(card_kl[legal_cards].sum())
                totals["card_agree"] += int((model_card == parent_card)[legal_cards].sum())
                totals["card_pass_model"] += int((model_card == 0)[legal_cards].sum())
                totals["card_pass_parent"] += int((parent_card == 0)[legal_cards].sum())
                card_log = F.log_softmax(training.mask_logits(model_logits["card"], card_mask), dim=1)
                totals["parent_card_nll_sum"] += float(-card_log.gather(1, parent_card[:, None]).squeeze(1)[legal_cards].sum())
                play = parent_card != 0
                if play.any():
                    placement_mask = tensors["placement_by_card"][start:end][torch.arange(count), parent_card]
                    placement_kl = training.categorical_kl(parent_card_logits["placement"][play], model_logits["placement"][play], placement_mask[play])
                    model_placement = training.mask_logits(model_logits["placement"][play], placement_mask[play]).argmax(dim=1)
                    placement_log = F.log_softmax(training.mask_logits(model_logits["placement"][play], placement_mask[play]), dim=1)
                    totals["play_states"] += int(play.sum())
                    totals["placement_kl_sum"] += float(placement_kl.sum())
                    totals["placement_agree"] += int((model_placement == parent_placement[play]).sum())
                    totals["parent_placement_nll_sum"] += float(-placement_log.gather(1, parent_placement[play][:, None]).sum())
                delay_mask = torch.ones(count, training.DELAY_BINS, dtype=torch.bool)
                totals["delay_kl_sum"] += float(training.categorical_kl(parent_card_logits["delay"], model_logits["delay"], delay_mask).sum())
                totals["delay_agree"] += int((model_logits["delay"].argmax(dim=1) == parent_card_logits["delay"].argmax(dim=1)).sum())
        legal = max(1, totals["card_legal_states"])
        plays = max(1, totals["play_states"])
        states = max(1, totals["states"])
        report[Path(probe_path).stem] = {
            "states": totals["states"],
            "states_with_a_legal_card": totals["card_legal_states"],
            "parent_play_states": totals["play_states"],
            "card_kl_parent_to_model": totals["card_kl_sum"] / legal,
            "card_argmax_agreement": totals["card_agree"] / legal,
            "card_parent_argmax_nll": totals["parent_card_nll_sum"] / legal,
            "pass_argmax_rate_model": totals["card_pass_model"] / legal,
            "pass_argmax_rate_parent": totals["card_pass_parent"] / legal,
            "placement_kl_parent_to_model": totals["placement_kl_sum"] / plays,
            "placement_argmax_agreement": totals["placement_agree"] / plays,
            "placement_parent_argmax_nll": totals["parent_placement_nll_sum"] / plays,
            "delay_kl_parent_to_model": totals["delay_kl_sum"] / states,
            "delay_argmax_agreement": totals["delay_agree"] / states,
        }
    report["parameter_drift_from_parent"] = parameter_drift(model, parent)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))


def opportunity_capture_against_parent(
    model: dict[str, dict[str, Any]], parent: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Pooled held-out capture below the parent's is a diagnostic failure
    (tactical review proposal 3); it is reported, and training continues."""
    pooled, parent_pooled = model["opportunity"], parent["opportunity"]
    comparable = pooled["rows"] > 0 and pooled["rows"] == parent_pooled["rows"]
    return {
        "model": model,
        "parent": parent,
        "capture_rate_below_parent": (
            pooled["capture_rate"] < parent_pooled["capture_rate"] if comparable else None
        ),
        "mean_p_fireball_below_parent": (
            pooled["mean_p_fireball"] < parent_pooled["mean_p_fireball"] if comparable else None
        ),
    }


def heldout_batches(
    dataset: str | Path, vocab: dict[str, int]
) -> tuple[list[training.Batch], list[training.Batch]]:
    """Validation batches and Fireball opportunity batches from one read.

    Both equal what training.batches_for_parquet yields for the validation
    split, without and with the opportunity predicate, in the same order.
    """
    opportunity_rows: list[dict[str, Any]] = []

    def validation_rows() -> Iterator[dict[str, Any]]:
        for row in training.iter_parquet_rows(dataset, split="validation"):
            if training.row_fireball_opportunity(row) != training.OPPORTUNITY_NONE:
                opportunity_rows.append(row)
            yield row

    validation = list(training.batches_from_rows(validation_rows(), vocab, 32))
    return validation, list(training.batches_from_rows(opportunity_rows, vocab, 32))


def episode_stratum(header: dict[str, Any], vocab: dict[str, int]) -> int:
    """The critic stratum of one collected game.

    Snapshot league games name their stratum explicitly (``edger``) because
    the opponent label is a snapshot id; such a stratum must be in the parent's
    vocabulary. Every other game keeps the existing lookup of its opponent,
    unknown opponents falling back to index 0.
    """
    if "opponent_stratum" in header:
        stratum = header["opponent_stratum"]
        if stratum not in vocab:
            raise ValueError(
                f"episode {header.get('episode_id')} stratum {stratum!r} is not in the parent vocabulary"
            )
        return vocab[stratum]
    return vocab.get(header["opponent"], 0)


def run_heldout(args: argparse.Namespace) -> None:
    checkpoint, model = load_any_checkpoint(args.checkpoint)
    _, parent = load_any_checkpoint(args.parent)
    vocab = checkpoint["opponent_stratum_vocabulary"]
    device = torch.device("cpu")
    validation, opportunity = heldout_batches(args.dataset, vocab)
    report = {
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "dataset": str(Path(args.dataset).resolve()),
        "dataset_sha256": training.sha256_file(args.dataset),
        "split": "validation",
        "note": "Teacher-label imitation loss on the 20260921 frozen subset; not the RL objective.",
        "validation": training.evaluate_loss_batches(model, validation, device),
        "kl_from_parent": training.evaluate_kl_batches(parent, model, validation, device),
        "opportunity_capture": opportunity_capture_against_parent(
            training.evaluate_opportunity_capture_batches(model, opportunity, device),
            training.evaluate_opportunity_capture_batches(parent, opportunity, device),
        ),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    train = commands.add_parser("train-iteration")
    train.add_argument("--checkpoint", required=True)
    train.add_argument("--parent", required=True)
    train.add_argument("--collection", required=True)
    train.add_argument("--delay-mode", required=True, choices=DELAY_MODES)
    train.add_argument("--arm", required=True)
    train.add_argument("--iteration", type=int, required=True)
    train.add_argument("--out", required=True)
    train.add_argument("--metrics-out", required=True)
    train.add_argument("--learning-rate", type=float, default=1e-3)
    train.add_argument("--batch-size", type=int, default=32)
    train.add_argument("--value-loss-weight", type=float, default=0.5)
    train.add_argument("--entropy-bonus", type=float, default=0.001)
    train.add_argument("--loss-mode", default="full", choices=LOSS_MODES)
    train.add_argument("--reward-version", default=DEFAULT_REWARD_VERSION, choices=REWARD_VERSIONS)
    train.add_argument(
        "--start-from-warmup", action="store_true",
        help="start a new arm from a critic_head warm-up checkpoint, with fresh Adam",
    )
    train.add_argument(
        "--card-kl-coefficient", type=float, default=0.0,
        help="weight of KL(parent || model) over the card head (0 = the production update)",
    )
    train.add_argument(
        "--card-kl-rows", default="all", choices=CARD_KL_ROWS,
        help="rows the card KL covers: all, or only Fireball opportunity rows",
    )
    train.add_argument(
        "--opportunity-card-weight", type=float, default=1.0,
        help="multiply the card head's policy term on Fireball opportunity rows by this weight (1 = off)",
    )
    train.add_argument(
        "--opportunity-card-weight-classes", default="both", choices=OPPORTUNITY_WEIGHT_CLASSES,
        help="opportunity classes the card weight applies to",
    )
    train.add_argument(
        "--decompose-every", type=int, default=0,
        help="measure per-loss-term gradients on every Nth episode update (0 = never)",
    )
    train.add_argument("--seed", type=int, default=20260926)
    train.set_defaults(func=run_train_iteration)

    export = commands.add_parser("export")
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--out", required=True)
    export.add_argument("--model-id")
    export.set_defaults(func=run_export)

    manifest = commands.add_parser("candidate-manifest")
    manifest.add_argument("--campaign-id", required=True)
    manifest.add_argument("--runs", required=True, help="JSON list of {run, bc_seed, bc_checkpoint, plan, work_dir}")
    manifest.add_argument("--bc-dataset-sha256", required=True)
    manifest.add_argument("--out", required=True)
    manifest.set_defaults(func=run_candidate_manifest)

    candidate = commands.add_parser("export-candidate")
    candidate.add_argument("--manifest", required=True)
    candidate.add_argument("--selection", required=True)
    candidate.add_argument("--run", required=True)
    candidate.add_argument("--out", required=True)
    candidate.add_argument("--binding-out", required=True)
    candidate.set_defaults(func=run_export_candidate)

    probe = commands.add_parser("probe")
    probe.add_argument("--checkpoint", required=True)
    probe.add_argument("--parent", required=True)
    probe.add_argument("--probes", nargs="+", required=True)
    probe.add_argument("--out", required=True)
    probe.set_defaults(func=run_probe)

    heldout = commands.add_parser("heldout")
    heldout.add_argument("--checkpoint", required=True)
    heldout.add_argument("--parent", required=True)
    heldout.add_argument("--dataset", required=True)
    heldout.add_argument("--out", required=True)
    heldout.set_defaults(func=run_heldout)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
