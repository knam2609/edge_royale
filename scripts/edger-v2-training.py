#!/usr/bin/env python3
"""PyTorch training/export utilities for the shadow Edger v2 policy."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import platform
import random
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq
import torch
from torch import Tensor, nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset


MODEL_SCHEMA = "edger_policy_model_v2"
CHECKPOINT_SCHEMA = "edger_v2_checkpoint_v1"
ACTION_SCHEMA = "edger_autoregressive_action_v2"
OBSERVATION_SCHEMA = "edger_oracle_observation_v2"
ARCHITECTURE = {
    "type": "autoregressive_masked_conv_actor",
    "board_channels": 16,
    "conv_layers": 3,
    "conv1_kernel_size": 3,
    "conv2_kernel_size": 1,
    "conv3_kernel_size": 1,
    "global_hidden": 64,
    "fused_hidden": 64,
    "placement_hidden": 16,
    "delay_hidden": 64,
    "delay_bins": 200,
    "activation": "relu",
}
BOARD_HEIGHT = 32
BOARD_WIDTH = 18
BOARD_INPUT_CHANNELS = 24
GLOBAL_FEATURES = 96
CARD_ACTIONS = 9
PLACEMENTS = BOARD_HEIGHT * BOARD_WIDTH
DELAY_BINS = 200
VALUE_STRATUM_EMBEDDING = 8
KL_LIMIT = 0.05
ADVANTAGE_TEMPERATURE = 0.25
ADVANTAGE_WEIGHT_MIN = 0.1
ADVANTAGE_WEIGHT_MAX = 20.0


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def require_clean_git() -> str:
    commit = git_commit()
    if commit == "unknown":
        raise RuntimeError("authoritative Edger training requires Git provenance")
    status = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        text=True,
    ).strip()
    if status:
        raise RuntimeError(
            "authoritative Edger training requires a clean Git worktree; "
            "commit or remove changes first"
        )
    return commit


def seed_everything(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def round_float(value: float) -> float:
    return round(float(value), 8)


class EdgerV2Policy(nn.Module):
    def __init__(self, opponent_strata: int = 1) -> None:
        super().__init__()
        channels = ARCHITECTURE["board_channels"]
        self.conv1 = nn.Conv2d(BOARD_INPUT_CHANNELS, channels, 3, padding=1)
        self.conv2 = nn.Conv2d(channels, channels, 1)
        self.conv3 = nn.Conv2d(channels, channels, 1)
        self.global_encoder = nn.Linear(GLOBAL_FEATURES, ARCHITECTURE["global_hidden"])
        self.fusion = nn.Linear(
            channels + ARCHITECTURE["global_hidden"],
            ARCHITECTURE["fused_hidden"],
        )
        self.card_head = nn.Linear(ARCHITECTURE["fused_hidden"], CARD_ACTIONS)
        self.placement_context = nn.Linear(
            ARCHITECTURE["fused_hidden"],
            ARCHITECTURE["placement_hidden"],
        )
        self.card_embedding = nn.Embedding(CARD_ACTIONS, ARCHITECTURE["placement_hidden"])
        self.placement_scorer = nn.Linear(ARCHITECTURE["placement_hidden"], 1)
        self.delay_encoder = nn.Linear(
            ARCHITECTURE["fused_hidden"]
            + channels
            + ARCHITECTURE["placement_hidden"],
            ARCHITECTURE["delay_hidden"],
        )
        self.delay_head = nn.Linear(ARCHITECTURE["delay_hidden"], DELAY_BINS)

        # Training only. Opponent stratum never reaches actor logits.
        self.value_stratum_embedding = nn.Embedding(
            max(1, opponent_strata),
            VALUE_STRATUM_EMBEDDING,
        )
        self.value_head = nn.Linear(
            ARCHITECTURE["fused_hidden"] + VALUE_STRATUM_EMBEDDING,
            1,
        )

    def encode(self, board: Tensor, global_features: Tensor) -> tuple[Tensor, Tensor]:
        spatial = board.permute(0, 3, 1, 2)
        spatial = F.relu(self.conv1(spatial))
        spatial = F.relu(self.conv2(spatial))
        spatial = F.relu(self.conv3(spatial))
        pooled = spatial.mean(dim=(2, 3))
        global_hidden = F.relu(self.global_encoder(global_features))
        fused = F.relu(self.fusion(torch.cat([pooled, global_hidden], dim=1)))
        return spatial, fused

    def actor_logits(
        self,
        board: Tensor,
        global_features: Tensor,
        selected_card: Tensor,
        selected_placement: Tensor,
    ) -> dict[str, Tensor]:
        spatial, fused = self.encode(board, global_features)
        card_logits = self.card_head(fused)
        card_embedding = self.card_embedding(selected_card)
        placement_context = F.relu(self.placement_context(fused))
        spatial_cells = spatial.permute(0, 2, 3, 1).reshape(
            board.shape[0],
            PLACEMENTS,
            ARCHITECTURE["board_channels"],
        )
        placement_hidden = F.relu(
            spatial_cells + placement_context[:, None, :] + card_embedding[:, None, :]
        )
        placement_logits = self.placement_scorer(placement_hidden).squeeze(-1)
        batch_indices = torch.arange(board.shape[0], device=board.device)
        selected_spatial = spatial_cells[batch_indices, selected_placement]
        delay_hidden = F.relu(
            self.delay_encoder(
                torch.cat([fused, selected_spatial, card_embedding], dim=1)
            )
        )
        delay_logits = self.delay_head(delay_hidden)
        return {
            "card": card_logits,
            "placement": placement_logits,
            "delay": delay_logits,
            "fused": fused,
        }

    def value(
        self,
        fused: Tensor,
        opponent_stratum: Tensor,
    ) -> Tensor:
        embedding = self.value_stratum_embedding(opponent_stratum)
        return self.value_head(torch.cat([fused, embedding], dim=1)).squeeze(-1)


@dataclass(frozen=True)
class Batch:
    board: Tensor
    global_features: Tensor
    card_mask: Tensor
    placement_mask: Tensor
    delay_mask: Tensor
    card: Tensor
    placement: Tensor
    delay: Tensor
    discounted_return: Tensor
    sample_weight: Tensor
    stratum: Tensor
    is_winner: Tensor
    policy_rating: Tensor
    vtrace_target: Tensor
    vtrace_advantage: Tensor

    def to(self, device: torch.device) -> "Batch":
        return Batch(
            **{
                key: value.to(device)
                for key, value in self.__dict__.items()
            }
        )


class DecisionDataset(Dataset[dict[str, Any]]):
    def __init__(
        self,
        rows: list[dict[str, Any]],
        stratum_to_index: dict[str, int],
    ) -> None:
        self.rows = rows
        self.stratum_to_index = stratum_to_index

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, Any]:
        row = self.rows[index]
        rating = row.get("policy_league_rating")
        return {
            "board": torch.tensor(row["board"], dtype=torch.float32).reshape(
                BOARD_HEIGHT, BOARD_WIDTH, BOARD_INPUT_CHANNELS
            ),
            "global_features": torch.tensor(row["global"], dtype=torch.float32),
            "card_mask": torch.tensor(row["legal_masks"]["card"], dtype=torch.bool),
            "placement_mask": torch.tensor(
                row["legal_masks"]["placement"], dtype=torch.bool
            ),
            "delay_mask": torch.tensor(row["legal_masks"]["delay"], dtype=torch.bool),
            "card": torch.tensor(row["selected"]["card_index"], dtype=torch.long),
            "placement": torch.tensor(
                row["selected"]["placement_index"], dtype=torch.long
            ),
            "delay": torch.tensor(row["selected"]["delay_index"], dtype=torch.long),
            "discounted_return": torch.tensor(
                row["discounted_return"], dtype=torch.float32
            ),
            "sample_weight": torch.tensor(
                row.get("sample_weight", 1.0), dtype=torch.float32
            ),
            "stratum": torch.tensor(
                self.stratum_to_index.get(row["opponent_stratum"], 0),
                dtype=torch.long,
            ),
            "is_winner": torch.tensor(bool(row.get("is_winner")), dtype=torch.bool),
            "policy_rating": torch.tensor(
                float(rating) if rating is not None else float("-inf"),
                dtype=torch.float32,
            ),
            "vtrace_target": torch.tensor(
                row.get("vtrace_target", 0.0), dtype=torch.float32
            ),
            "vtrace_advantage": torch.tensor(
                row.get("vtrace_advantage", 0.0), dtype=torch.float32
            ),
        }


def collate_batch(rows: list[dict[str, Tensor]]) -> Batch:
    return Batch(
        **{
            key: torch.stack([row[key] for row in rows])
            for key in rows[0]
        }
    )


def load_parquet_rows(path: str | Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    table = pq.read_table(path)
    metadata = {
        key.decode("utf8"): value.decode("utf8")
        for key, value in (table.schema.metadata or {}).items()
    }
    return table.to_pylist(), metadata


def make_stratum_vocab(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    values = sorted({str(row.get("opponent_stratum", "unknown")) for row in rows})
    return {value: index for index, value in enumerate(values or ["unknown"])}


def loader_for(
    rows: list[dict[str, Any]],
    vocab: dict[str, int],
    batch_size: int,
    shuffle: bool,
    seed: int,
) -> DataLoader[dict[str, Tensor]]:
    generator = torch.Generator()
    generator.manual_seed(seed)
    return DataLoader(
        DecisionDataset(rows, vocab),
        batch_size=batch_size,
        shuffle=shuffle,
        generator=generator,
        num_workers=0,
        collate_fn=collate_batch,
    )


def mask_logits(logits: Tensor, mask: Tensor) -> Tensor:
    return logits.masked_fill(~mask, -1e9)


def actor_losses(logits: dict[str, Tensor], batch: Batch) -> tuple[Tensor, dict[str, Tensor]]:
    card_loss = F.cross_entropy(
        mask_logits(logits["card"], batch.card_mask),
        batch.card,
        reduction="none",
    )
    play = batch.card != 0
    placement_loss = torch.zeros_like(card_loss)
    if play.any():
        placement_loss[play] = F.cross_entropy(
            mask_logits(logits["placement"][play], batch.placement_mask[play]),
            batch.placement[play],
            reduction="none",
        )
    delay_loss = F.cross_entropy(
        mask_logits(logits["delay"], batch.delay_mask),
        batch.delay,
        reduction="none",
    )
    joint = card_loss + placement_loss + delay_loss
    return joint, {
        "card": card_loss,
        "placement": placement_loss,
        "delay": delay_loss,
    }


def forward_batch(model: EdgerV2Policy, batch: Batch) -> dict[str, Tensor]:
    return model.actor_logits(
        batch.board,
        batch.global_features,
        batch.card,
        batch.placement,
    )


def evaluate_loss(
    model: EdgerV2Policy,
    rows: list[dict[str, Any]],
    vocab: dict[str, int],
    batch_size: int,
    device: torch.device,
) -> dict[str, float]:
    if not rows:
        return {
            "joint_action_loss": None,
            "card_loss": None,
            "placement_loss": None,
            "delay_loss": None,
            "value_loss": None,
        }
    model.eval()
    totals = {"joint": 0.0, "card": 0.0, "placement": 0.0, "delay": 0.0, "value": 0.0}
    count = 0
    with torch.no_grad():
        for batch in loader_for(rows, vocab, batch_size, False, 1):
            batch = batch.to(device)
            logits = forward_batch(model, batch)
            joint, parts = actor_losses(logits, batch)
            value = model.value(logits["fused"], batch.stratum)
            value_loss = F.mse_loss(value, batch.discounted_return, reduction="none")
            batch_count = batch.card.shape[0]
            totals["joint"] += joint.sum().item()
            totals["card"] += parts["card"].sum().item()
            totals["placement"] += parts["placement"].sum().item()
            totals["delay"] += parts["delay"].sum().item()
            totals["value"] += value_loss.sum().item()
            count += batch_count
    return {
        "joint_action_loss": totals["joint"] / count,
        "card_loss": totals["card"] / count,
        "placement_loss": totals["placement"] / count,
        "delay_loss": totals["delay"] / count,
        "value_loss": totals["value"] / count,
    }


def categorical_kl(reference: Tensor, candidate: Tensor, mask: Tensor) -> Tensor:
    reference_log = F.log_softmax(mask_logits(reference, mask), dim=1)
    candidate_log = F.log_softmax(mask_logits(candidate, mask), dim=1)
    reference_probability = reference_log.exp()
    return (reference_probability * (reference_log - candidate_log)).sum(dim=1)


def selected_joint_log_probability(logits: dict[str, Tensor], batch: Batch) -> Tensor:
    card_log_probability = F.log_softmax(
        mask_logits(logits["card"], batch.card_mask), dim=1
    ).gather(1, batch.card[:, None]).squeeze(1)
    placement_log_probability = torch.zeros_like(card_log_probability)
    play = batch.card != 0
    if play.any():
        placement_log_probability[play] = F.log_softmax(
            mask_logits(logits["placement"][play], batch.placement_mask[play]), dim=1
        ).gather(1, batch.placement[play, None]).squeeze(1)
    delay_log_probability = F.log_softmax(
        mask_logits(logits["delay"], batch.delay_mask), dim=1
    ).gather(1, batch.delay[:, None]).squeeze(1)
    return card_log_probability + placement_log_probability + delay_log_probability


def actor_entropy(logits: dict[str, Tensor], batch: Batch) -> Tensor:
    def entropy_for(values: Tensor, mask: Tensor) -> Tensor:
        log_probability = F.log_softmax(mask_logits(values, mask), dim=1)
        probability = log_probability.exp()
        return -(probability * log_probability).sum(dim=1)

    entropy = entropy_for(logits["card"], batch.card_mask)
    play = batch.card != 0
    if play.any():
        entropy[play] += entropy_for(
            logits["placement"][play], batch.placement_mask[play]
        )
    entropy += entropy_for(logits["delay"], batch.delay_mask)
    return entropy


def evaluate_kl(
    reference: EdgerV2Policy,
    candidate: EdgerV2Policy,
    rows: list[dict[str, Any]],
    vocab: dict[str, int],
    batch_size: int,
    device: torch.device,
) -> float:
    if not rows:
        return 0.0
    reference.eval()
    candidate.eval()
    total = 0.0
    count = 0
    with torch.no_grad():
        for batch in loader_for(rows, vocab, batch_size, False, 1):
            batch = batch.to(device)
            reference_logits = forward_batch(reference, batch)
            candidate_logits = forward_batch(candidate, batch)
            kl = categorical_kl(
                reference_logits["card"], candidate_logits["card"], batch.card_mask
            )
            play = batch.card != 0
            if play.any():
                kl[play] += categorical_kl(
                    reference_logits["placement"][play],
                    candidate_logits["placement"][play],
                    batch.placement_mask[play],
                )
            kl += categorical_kl(
                reference_logits["delay"], candidate_logits["delay"], batch.delay_mask
            )
            total += kl.sum().item()
            count += kl.shape[0]
    return total / max(1, count)


def environment_metadata() -> dict[str, Any]:
    return {
        "python": platform.python_version(),
        "pytorch": torch.__version__,
        "pyarrow": pa.__version__,
        "platform": platform.platform(),
        "cuda": torch.version.cuda,
    }


def checkpoint_payload(
    *,
    model: EdgerV2Policy,
    optimizer: torch.optim.Optimizer,
    phase: str,
    seed: int,
    manifest_hash: str,
    dataset_checksum: str,
    parent_checkpoint: str | None,
    vocab: dict[str, int],
    metrics: dict[str, Any],
) -> dict[str, Any]:
    checkpoint_id_content = {
        "phase": phase,
        "seed": seed,
        "manifest_hash": manifest_hash,
        "dataset_checksum": dataset_checksum,
        "parent_checkpoint": parent_checkpoint,
        "git_commit": git_commit(),
        "metrics": metrics,
    }
    checkpoint_id = f"edger_v2_{phase}_{sha256_bytes(canonical_json(checkpoint_id_content).encode())[:16]}"
    return {
        "schema_version": CHECKPOINT_SCHEMA,
        "checkpoint_id": checkpoint_id,
        "phase": phase,
        "architecture": ARCHITECTURE,
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
        "seed": seed,
        "manifest_hash": manifest_hash,
        "dataset_checksum": dataset_checksum,
        "parent_checkpoint": parent_checkpoint,
        "opponent_stratum_vocabulary": vocab,
        "git_commit": git_commit(),
        "environment": environment_metadata(),
        "metrics": metrics,
    }


def save_checkpoint(path: str | Path, payload: dict[str, Any]) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"checkpoint is immutable and already exists: {output}")
    torch.save(payload, output)


def load_checkpoint(path: str | Path, device: torch.device) -> tuple[dict[str, Any], EdgerV2Policy]:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema_version") != CHECKPOINT_SCHEMA:
        raise ValueError(f"unsupported checkpoint schema {payload.get('schema_version')}")
    vocab = payload["opponent_stratum_vocabulary"]
    model = EdgerV2Policy(max(1, len(vocab))).to(device)
    model.load_state_dict(payload["model_state"])
    return payload, model


def winner_finetune_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ratings = sorted({
        float(row["policy_league_rating"])
        for row in rows
        if row.get("policy_league_rating") is not None
    })
    if not ratings:
        return []
    threshold = ratings[max(0, math.ceil(len(ratings) * 0.75) - 1)]
    return [
        row
        for row in rows
        if row.get("is_winner")
        and row.get("policy_league_rating") is not None
        and float(row["policy_league_rating"]) >= threshold
    ]


def run_bc(args: argparse.Namespace) -> None:
    require_clean_git()
    seed_everything(args.seed)
    rows, metadata = load_parquet_rows(args.dataset)
    train_rows = [row for row in rows if row["split"] == "train"]
    validation_rows = [row for row in rows if row["split"] == "validation"]
    if not train_rows:
        raise ValueError("BC dataset has no training rows")
    vocab = make_stratum_vocab(rows)
    device = torch.device(args.device)
    model = EdgerV2Policy(max(1, len(vocab))).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)

    for epoch in range(args.epochs):
        model.train()
        for batch in loader_for(
            train_rows,
            vocab,
            args.batch_size,
            True,
            args.seed + epoch,
        ):
            batch = batch.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = forward_batch(model, batch)
            joint, _ = actor_losses(logits, batch)
            value = model.value(logits["fused"], batch.stratum)
            value_loss = F.mse_loss(value, batch.discounted_return, reduction="none")
            loss = (
                (joint * batch.sample_weight).mean()
                + args.value_loss_weight * value_loss.mean()
            )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    finetune = winner_finetune_rows(train_rows)
    if finetune:
        finetune_optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate * 0.1)
        model.train()
        for batch in loader_for(finetune, vocab, args.batch_size, True, args.seed ^ 0x51A7):
            batch = batch.to(device)
            finetune_optimizer.zero_grad(set_to_none=True)
            logits = forward_batch(model, batch)
            joint, _ = actor_losses(logits, batch)
            loss = (joint * batch.sample_weight).mean()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            finetune_optimizer.step()
        optimizer = finetune_optimizer

    metrics = {
        "train_samples": len(train_rows),
        "validation_samples": len(validation_rows),
        "winner_top_quartile_finetune_samples": len(finetune),
        "validation": evaluate_loss(
            model, validation_rows, vocab, args.batch_size, device
        ),
    }
    payload = checkpoint_payload(
        model=model,
        optimizer=optimizer,
        phase="bc",
        seed=args.seed,
        manifest_hash=metadata.get("manifest_hash", "unknown"),
        dataset_checksum=sha256_file(args.dataset),
        parent_checkpoint=None,
        vocab=vocab,
        metrics=metrics,
    )
    save_checkpoint(args.out, payload)
    print(json.dumps({"checkpoint": str(Path(args.out).resolve()), **metrics}, indent=2))


def actor_parameters(model: EdgerV2Policy) -> list[nn.Parameter]:
    excluded = {
        id(parameter)
        for module in [model.value_stratum_embedding, model.value_head]
        for parameter in module.parameters()
    }
    return [parameter for parameter in model.parameters() if id(parameter) not in excluded]


def run_offline(args: argparse.Namespace) -> None:
    require_clean_git()
    seed_everything(args.seed)
    device = torch.device(args.device)
    parent, model = load_checkpoint(args.checkpoint, device)
    reference = copy.deepcopy(model).to(device).eval()
    for parameter in reference.parameters():
        parameter.requires_grad_(False)
    for parameter in model.value_stratum_embedding.parameters():
        parameter.requires_grad_(False)
    for parameter in model.value_head.parameters():
        parameter.requires_grad_(False)

    rows, metadata = load_parquet_rows(args.dataset)
    train_rows = [row for row in rows if row["split"] == "train"]
    validation_rows = [row for row in rows if row["split"] == "validation"]
    vocab = parent["opponent_stratum_vocabulary"]
    optimizer = torch.optim.Adam(actor_parameters(model), lr=args.learning_rate)
    accepted_state = copy.deepcopy(model.state_dict())
    accepted_epochs = 0
    validation_kl = 0.0
    rejected_validation_kl: float | None = None
    rollback_applied = False

    for epoch in range(args.epochs):
        model.train()
        for batch in loader_for(
            train_rows,
            vocab,
            args.batch_size,
            True,
            args.seed + epoch,
        ):
            batch = batch.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = forward_batch(model, batch)
            with torch.no_grad():
                reference_logits = forward_batch(reference, batch)
                value = reference.value(reference_logits["fused"], batch.stratum)
                advantage = batch.discounted_return - value
                advantage_weight = torch.exp(
                    advantage / ADVANTAGE_TEMPERATURE
                ).clamp(ADVANTAGE_WEIGHT_MIN, ADVANTAGE_WEIGHT_MAX)
            joint, _ = actor_losses(logits, batch)
            loss = (joint * advantage_weight * batch.sample_weight).mean()
            loss.backward()
            nn.utils.clip_grad_norm_(actor_parameters(model), 1.0)
            optimizer.step()

        validation_kl = evaluate_kl(
            reference,
            model,
            validation_rows,
            vocab,
            args.batch_size,
            device,
        )
        if validation_kl > KL_LIMIT:
            rejected_validation_kl = validation_kl
            rollback_applied = True
            model.load_state_dict(accepted_state)
            validation_kl = evaluate_kl(
                reference,
                model,
                validation_rows,
                vocab,
                args.batch_size,
                device,
            )
            break
        accepted_state = copy.deepcopy(model.state_dict())
        accepted_epochs = epoch + 1

    metrics = {
        "train_samples": len(train_rows),
        "validation_samples": len(validation_rows),
        "accepted_epochs": accepted_epochs,
        "validation_kl_from_bc": validation_kl,
        "rollback_applied": rollback_applied,
        "rejected_validation_kl": rejected_validation_kl,
        "kl_limit": KL_LIMIT,
        "advantage_temperature": ADVANTAGE_TEMPERATURE,
        "advantage_weight_clip": [ADVANTAGE_WEIGHT_MIN, ADVANTAGE_WEIGHT_MAX],
        "validation": evaluate_loss(
            model, validation_rows, vocab, args.batch_size, device
        ),
    }
    payload = checkpoint_payload(
        model=model,
        optimizer=optimizer,
        phase="offline_advantage_weighted",
        seed=args.seed,
        manifest_hash=metadata.get("manifest_hash", parent["manifest_hash"]),
        dataset_checksum=sha256_file(args.dataset),
        parent_checkpoint=parent["checkpoint_id"],
        vocab=vocab,
        metrics=metrics,
    )
    save_checkpoint(args.out, payload)
    print(json.dumps({"checkpoint": str(Path(args.out).resolve()), **metrics}, indent=2))


def attach_vtrace_targets(
    model: EdgerV2Policy,
    rows: list[dict[str, Any]],
    vocab: dict[str, int],
    batch_size: int,
    device: torch.device,
) -> list[dict[str, Any]]:
    eligible = [
        copy.deepcopy(row)
        for row in rows
        if row.get("vtrace_eligible")
        and row.get("behavior_log_probability") is not None
    ]
    if not eligible:
        raise ValueError("league cache has no V-trace-eligible simulator samples")
    values: list[float] = []
    target_log_probabilities: list[float] = []
    model.eval()
    with torch.no_grad():
        for batch in loader_for(eligible, vocab, batch_size, False, 1):
            batch = batch.to(device)
            logits = forward_batch(model, batch)
            values.extend(
                model.value(logits["fused"], batch.stratum).detach().cpu().tolist()
            )
            target_log_probabilities.extend(
                selected_joint_log_probability(logits, batch).detach().cpu().tolist()
            )

    groups: dict[tuple[str, str], list[int]] = {}
    for index, row in enumerate(eligible):
        groups.setdefault((row["episode_id"], row["actor"]), []).append(index)
    for indices in groups.values():
        indices.sort(key=lambda index: eligible[index]["tick"])
        next_vtrace_value = 0.0
        for position in range(len(indices) - 1, -1, -1):
            index = indices[position]
            row = eligible[index]
            next_value = values[indices[position + 1]] if position + 1 < len(indices) else 0.0
            discount = float(row.get("per_tick_gamma", 0.9997)) ** int(
                row["delay_ticks"]
            )
            importance = math.exp(
                max(
                    -20.0,
                    min(
                        20.0,
                        target_log_probabilities[index]
                        - float(row["behavior_log_probability"]),
                    ),
                )
            )
            rho = min(1.0, importance)
            trace_c = min(1.0, importance)
            temporal_difference = (
                float(row["reward"]) + discount * next_value - values[index]
            )
            vtrace_value = (
                values[index]
                + rho * temporal_difference
                + discount * trace_c * (next_vtrace_value - next_value)
            )
            policy_advantage = min(1.0, importance) * (
                float(row["reward"])
                + discount * next_vtrace_value
                - values[index]
            )
            row["vtrace_target"] = vtrace_value
            row["vtrace_advantage"] = policy_advantage
            row["target_log_probability_before_update"] = target_log_probabilities[index]
            row["importance_ratio_before_clip"] = importance
            next_vtrace_value = vtrace_value
    return eligible


def run_vtrace(args: argparse.Namespace) -> None:
    require_clean_git()
    seed_everything(args.seed)
    device = torch.device(args.device)
    parent, model = load_checkpoint(args.checkpoint, device)
    rows, metadata = load_parquet_rows(args.dataset)
    vocab = parent["opponent_stratum_vocabulary"]
    train_source = [row for row in rows if row["split"] == "train"]
    validation_rows = [row for row in rows if row["split"] == "validation"]
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    optimizer_restored = False
    if parent.get("phase") == "impala_vtrace_snapshot_league":
        optimizer.load_state_dict(parent["optimizer_state"])
        for parameter_group in optimizer.param_groups:
            parameter_group["lr"] = args.learning_rate
        optimizer_restored = True
    trained_samples = 0

    for epoch in range(args.epochs):
        targets = attach_vtrace_targets(
            model,
            train_source,
            vocab,
            args.batch_size,
            device,
        )
        trained_samples = len(targets)
        model.train()
        for batch in loader_for(
            targets,
            vocab,
            args.batch_size,
            True,
            args.seed + epoch,
        ):
            batch = batch.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = forward_batch(model, batch)
            log_probability = selected_joint_log_probability(logits, batch)
            entropy = actor_entropy(logits, batch)
            value = model.value(logits["fused"], batch.stratum)
            policy_loss = -(
                log_probability
                * batch.vtrace_advantage.detach()
                * batch.sample_weight
            ).mean()
            value_loss = F.mse_loss(value, batch.vtrace_target)
            loss = (
                policy_loss
                + args.value_loss_weight * value_loss
                - args.entropy_bonus * entropy.mean()
            )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    metrics = {
        "train_samples": trained_samples,
        "validation_samples": len(validation_rows),
        "vtrace": {
            "rho_clip": 1.0,
            "trace_c_clip": 1.0,
            "human_samples_excluded": True,
            "parent_optimizer_restored": optimizer_restored,
            "epochs": args.epochs,
            "entropy_bonus": args.entropy_bonus,
        },
        "validation": evaluate_loss(
            model, validation_rows, vocab, args.batch_size, device
        ),
    }
    payload = checkpoint_payload(
        model=model,
        optimizer=optimizer,
        phase="impala_vtrace_snapshot_league",
        seed=args.seed,
        manifest_hash=metadata.get("manifest_hash", parent["manifest_hash"]),
        dataset_checksum=sha256_file(args.dataset),
        parent_checkpoint=parent["checkpoint_id"],
        vocab=vocab,
        metrics=metrics,
    )
    save_checkpoint(args.out, payload)
    print(json.dumps({"checkpoint": str(Path(args.out).resolve()), **metrics}, indent=2))


def linear_json(layer: nn.Linear) -> dict[str, Any]:
    return {
        "input_dim": layer.in_features,
        "output_dim": layer.out_features,
        "weights": [round_float(value) for value in layer.weight.detach().cpu().t().flatten()],
        "bias": [round_float(value) for value in layer.bias.detach().cpu().flatten()],
    }


def conv_json(layer: nn.Conv2d) -> dict[str, Any]:
    return {
        "input_channels": layer.in_channels,
        "output_channels": layer.out_channels,
        "kernel_size": layer.kernel_size[0],
        "weights": [round_float(value) for value in layer.weight.detach().cpu().flatten()],
        "bias": [round_float(value) for value in layer.bias.detach().cpu().flatten()],
    }


def actor_parameter_count(model: EdgerV2Policy) -> int:
    return sum(parameter.numel() for parameter in actor_parameters(model))


def export_model_payload(
    checkpoint: dict[str, Any],
    model: EdgerV2Policy,
    model_id: str | None,
) -> dict[str, Any]:
    payload = {
        "model_id": model_id or checkpoint["checkpoint_id"].replace("checkpoint", "policy"),
        "schema_version": MODEL_SCHEMA,
        "action_space_version": ACTION_SCHEMA,
        "observation_schema_version": OBSERVATION_SCHEMA,
        "architecture": ARCHITECTURE,
        "weights": {
            "conv1": conv_json(model.conv1),
            "conv2": conv_json(model.conv2),
            "conv3": conv_json(model.conv3),
            "global_encoder": linear_json(model.global_encoder),
            "fusion": linear_json(model.fusion),
            "card_head": linear_json(model.card_head),
            "placement_context": linear_json(model.placement_context),
            "card_embedding": [
                round_float(value)
                for value in model.card_embedding.weight.detach().cpu().flatten()
            ],
            "placement_scorer": linear_json(model.placement_scorer),
            "delay_encoder": linear_json(model.delay_encoder),
            "delay_head": linear_json(model.delay_head),
        },
        "training": {
            "method": checkpoint["phase"],
            "seed": checkpoint["seed"],
            "git_commit": checkpoint["git_commit"],
            "checkpoint_id": checkpoint["checkpoint_id"],
            "parent_checkpoint": checkpoint["parent_checkpoint"],
            "dataset_manifest_hash": checkpoint["manifest_hash"],
            "dataset_checksum": checkpoint["dataset_checksum"],
            "environment": checkpoint["environment"],
            "metrics": checkpoint["metrics"],
            "promotion_status": "shadow_candidate_unreviewed",
        },
    }
    parameters = actor_parameter_count(model)
    if parameters > 50_000:
        raise ValueError(f"actor parameter count {parameters} exceeds 50,000")
    encoded = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
    if len(encoded) > 1_000_000:
        raise ValueError(f"actor export is {len(encoded)} bytes; limit is 1,000,000")
    return payload


def run_export(args: argparse.Namespace) -> None:
    require_clean_git()
    device = torch.device("cpu")
    checkpoint, model = load_checkpoint(args.checkpoint, device)
    model.eval()
    payload = export_model_payload(checkpoint, model, args.model_id)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.force:
        raise FileExistsError(f"model artifact already exists: {output}")
    output.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n")
    print(
        json.dumps(
            {
                "model": str(output.resolve()),
                "model_id": payload["model_id"],
                "actor_parameters": actor_parameter_count(model),
                "bytes": output.stat().st_size,
            },
            indent=2,
        )
    )


def load_actor_json(path: str | Path) -> EdgerV2Policy:
    payload = json.loads(Path(path).read_text())
    if payload.get("schema_version") != MODEL_SCHEMA:
        raise ValueError("parity model must use edger_policy_model_v2")
    model = EdgerV2Policy(1)

    def load_linear(layer: nn.Linear, source: dict[str, Any]) -> None:
        weights = torch.tensor(source["weights"], dtype=torch.float32).reshape(
            source["input_dim"], source["output_dim"]
        )
        layer.weight.data.copy_(weights.t())
        layer.bias.data.copy_(torch.tensor(source["bias"], dtype=torch.float32))

    def load_conv(layer: nn.Conv2d, source: dict[str, Any]) -> None:
        weights = torch.tensor(source["weights"], dtype=torch.float32).reshape(
            source["output_channels"],
            source["input_channels"],
            source["kernel_size"],
            source["kernel_size"],
        )
        layer.weight.data.copy_(weights)
        layer.bias.data.copy_(torch.tensor(source["bias"], dtype=torch.float32))

    weights = payload["weights"]
    load_conv(model.conv1, weights["conv1"])
    load_conv(model.conv2, weights["conv2"])
    load_conv(model.conv3, weights["conv3"])
    load_linear(model.global_encoder, weights["global_encoder"])
    load_linear(model.fusion, weights["fusion"])
    load_linear(model.card_head, weights["card_head"])
    load_linear(model.placement_context, weights["placement_context"])
    model.card_embedding.weight.data.copy_(
        torch.tensor(weights["card_embedding"], dtype=torch.float32).reshape(
            CARD_ACTIONS, ARCHITECTURE["placement_hidden"]
        )
    )
    load_linear(model.placement_scorer, weights["placement_scorer"])
    load_linear(model.delay_encoder, weights["delay_encoder"])
    load_linear(model.delay_head, weights["delay_head"])
    return model.eval()


def run_parity(args: argparse.Namespace) -> None:
    model = load_actor_json(args.model)
    fixture = json.loads(Path(args.fixture).read_text())
    board = torch.tensor(fixture["observation"]["board"], dtype=torch.float32).reshape(
        1, BOARD_HEIGHT, BOARD_WIDTH, BOARD_INPUT_CHANNELS
    )
    global_features = torch.tensor(
        fixture["observation"]["global"], dtype=torch.float32
    ).reshape(1, GLOBAL_FEATURES)
    card = torch.tensor([fixture["forced_card_index"]], dtype=torch.long)
    placement = torch.tensor(
        [fixture["forced_placement_index"]], dtype=torch.long
    )
    with torch.no_grad():
        logits = model.actor_logits(board, global_features, card, placement)
    masks = fixture["legal_masks"]
    result = {}
    for key in ["card", "placement", "delay"]:
        values = logits[key].squeeze(0)
        mask = torch.tensor(masks[key], dtype=torch.bool)
        values = values.masked_fill(~mask, -1e30)
        result[key] = [float(value) for value in values]
        result[f"{key}_argmax"] = int(torch.argmax(values).item())
    Path(args.out).write_text(json.dumps(result, separators=(",", ":")) + "\n")


def run_prepare(args: argparse.Namespace) -> None:
    rows = []
    with open(args.input, "r", encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    if not rows:
        raise ValueError("cannot prepare an empty decision cache")
    table = pa.Table.from_pylist(rows)
    metadata = dict(table.schema.metadata or {})
    metadata.update(
        {
            b"schema_version": b"edger_decision_parquet_v1",
            b"manifest_hash": args.manifest_hash.encode(),
            b"scale": str(args.scale).encode(),
            b"compression": b"zstd",
        }
    )
    table = table.replace_schema_metadata(metadata)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table,
        output,
        compression="zstd",
        compression_level=9,
        use_dictionary=True,
    )
    print(
        json.dumps(
            {
                "cache": str(output.resolve()),
                "rows": len(rows),
                "bytes": output.stat().st_size,
                "compression": "zstd",
            },
            indent=2,
        )
    )


def run_league_guard(args: argparse.Namespace) -> None:
    report = json.loads(Path(args.scaling_report).read_text())
    if not report.get("passed"):
        raise RuntimeError(
            "IMPALA/V-trace remains gated until the 1%/10%/100% scaling report passes"
        )
    required = {
        "full_improves_held_out_joint_action_loss",
        "full_non_regressing_frozen_league_score",
    }
    missing = sorted(key for key in required if not report.get(key))
    if missing:
        raise RuntimeError(
            "scaling report is missing required passing evidence: " + ", ".join(missing)
        )
    print(
        json.dumps(
            {
                "status": "ready",
                "message": (
                    "Scaling gate passed. Use scripts/edger-league.mjs to launch "
                    "the exact-JavaScript 16-32 worker IMPALA/V-trace campaign."
                ),
            },
            indent=2,
        )
    )


def run_scaling_report(args: argparse.Namespace) -> None:
    checkpoints = {}
    league_reports = {}
    manifests = {}
    models = {}

    def load_manifest(label: str, manifest_path: str) -> dict[str, Any]:
        manifest = json.loads(Path(manifest_path).read_text())
        if manifest.get("schema_version") != "edger_dataset_manifest_v1":
            raise ValueError(f"{label} manifest schema is incompatible")
        expected_hash = manifest.get("manifest_hash")
        content = copy.deepcopy(manifest)
        content.pop("manifest_hash", None)
        actual_hash = sha256_bytes(canonical_json(content).encode())
        if expected_hash != actual_hash:
            raise ValueError(f"{label} manifest_hash mismatch")
        shards = manifest.get("shards")
        if not isinstance(shards, list):
            raise ValueError(f"{label} manifest shards must be a list")
        return manifest

    for label, checkpoint_path, league_path, manifest_path, model_path in [
        (
            "1pct",
            args.one_checkpoint,
            args.one_league,
            args.one_manifest,
            args.one_model,
        ),
        (
            "10pct",
            args.ten_checkpoint,
            args.ten_league,
            args.ten_manifest,
            args.ten_model,
        ),
        (
            "100pct",
            args.full_checkpoint,
            args.full_league,
            args.full_manifest,
            args.full_model,
        ),
    ]:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        if checkpoint.get("schema_version") != CHECKPOINT_SCHEMA:
            raise ValueError(f"{label} checkpoint schema is incompatible")
        manifest = load_manifest(label, manifest_path)
        if checkpoint.get("manifest_hash") != manifest["manifest_hash"]:
            raise ValueError(f"{label} manifest/checkpoint binding mismatch")
        model_bytes = Path(model_path).read_bytes()
        model = json.loads(model_bytes)
        if model.get("schema_version") != MODEL_SCHEMA:
            raise ValueError(f"{label} candidate model schema is incompatible")
        if model.get("training", {}).get("checkpoint_id") != checkpoint["checkpoint_id"]:
            raise ValueError(f"{label} model/checkpoint binding mismatch")
        league_report = json.loads(Path(league_path).read_text())
        if league_report.get("schema_version") != "edger_frozen_league_report_v1":
            raise ValueError(f"{label} frozen league report schema is incompatible")
        if league_report.get("candidate_checkpoint_id") != checkpoint["checkpoint_id"]:
            raise ValueError(f"{label} frozen league candidate checkpoint binding mismatch")
        if league_report.get("candidate_model_id") != model.get("model_id"):
            raise ValueError(f"{label} frozen league candidate model binding mismatch")
        if league_report.get("candidate_model_checksum") != sha256_bytes(model_bytes):
            raise ValueError(f"{label} frozen league candidate model checksum mismatch")
        if (
            league_report.get("candidate_checkpoint_checksum")
            != sha256_file(checkpoint_path)
        ):
            raise ValueError(f"{label} frozen league candidate checkpoint checksum mismatch")
        if league_report.get("illegal_actions") != 0:
            raise ValueError(f"{label} frozen league report contains illegal actions")
        if not league_report.get("replay_checks", {}).get("all_passed"):
            raise ValueError(f"{label} frozen league replay verification failed")
        checkpoints[label] = checkpoint
        manifests[label] = manifest
        models[label] = model
        league_reports[label] = league_report

    def ids_for_split(manifest: dict[str, Any], split: str) -> list[str]:
        return [
            shard["episode_id"]
            for shard in manifest["shards"]
            if shard.get("split") == split
        ]

    training_ids = {
        label: set(ids_for_split(manifests[label], "train"))
        for label in ["1pct", "10pct", "100pct"]
    }
    if not training_ids["1pct"].issubset(training_ids["10pct"]):
        raise ValueError("1pct training episodes are not a subset of 10pct")
    if not training_ids["10pct"].issubset(training_ids["100pct"]):
        raise ValueError("10pct training episodes are not a subset of 100pct")
    for split in ["validation", "test"]:
        expected = canonical_json(ids_for_split(manifests["100pct"], split))
        for label in ["1pct", "10pct"]:
            if canonical_json(ids_for_split(manifests[label], split)) != expected:
                raise ValueError(
                    f"{split} episode IDs must be byte-for-byte identical at every scale"
                )
    suite_checksums = {
        league_reports[label].get("suite_spec_checksum")
        for label in ["1pct", "10pct", "100pct"]
    }
    if None in suite_checksums or len(suite_checksums) != 1:
        raise ValueError("frozen league suite specifications must be identical")
    ten_loss = checkpoints["10pct"]["metrics"]["validation"]["joint_action_loss"]
    full_loss = checkpoints["100pct"]["metrics"]["validation"]["joint_action_loss"]
    ten_league_score = league_reports["10pct"].get("frozen_league_score")
    full_league_score = league_reports["100pct"].get("frozen_league_score")
    if any(value is None for value in [ten_loss, full_loss, ten_league_score, full_league_score]):
        raise ValueError(
            "scaling evidence requires validation joint_action_loss and frozen_league_score"
        )
    loss_passed = float(full_loss) < float(ten_loss)
    league_passed = float(full_league_score) >= float(ten_league_score)
    report = {
        "schema_version": "edger_data_scaling_report_v1",
        "passed": loss_passed and league_passed,
        "full_improves_held_out_joint_action_loss": loss_passed,
        "full_non_regressing_frozen_league_score": league_passed,
        "scales": {
            label: {
                "checkpoint_id": checkpoints[label]["checkpoint_id"],
                "manifest_hash": checkpoints[label]["manifest_hash"],
                "manifest_path": str(Path(getattr(args, {
                    "1pct": "one_manifest",
                    "10pct": "ten_manifest",
                    "100pct": "full_manifest",
                }[label])).resolve()),
                "candidate_model_id": models[label]["model_id"],
                "candidate_model_checksum": league_reports[label][
                    "candidate_model_checksum"
                ],
                "candidate_checkpoint_checksum": league_reports[label][
                    "candidate_checkpoint_checksum"
                ],
                "validation_joint_action_loss": checkpoints[label]["metrics"][
                    "validation"
                ]["joint_action_loss"],
                "frozen_league_score": league_reports[label].get(
                    "frozen_league_score"
                ),
            }
            for label in ["1pct", "10pct", "100pct"]
        },
        "suite_spec_checksum": next(iter(suite_checksums)),
        "nested_training_sets": True,
        "identical_validation_and_test_sets": True,
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(2)


def add_training_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=20260718)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--device", default="cpu")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--input", required=True)
    prepare.add_argument("--out", required=True)
    prepare.add_argument("--manifest-hash", required=True)
    prepare.add_argument("--scale", type=float, required=True)
    prepare.set_defaults(func=run_prepare)

    bc = subparsers.add_parser("bc")
    add_training_arguments(bc)
    bc.add_argument("--value-loss-weight", type=float, default=0.5)
    bc.set_defaults(func=run_bc)

    offline = subparsers.add_parser("offline")
    add_training_arguments(offline)
    offline.add_argument("--checkpoint", required=True)
    offline.set_defaults(func=run_offline)

    vtrace = subparsers.add_parser("vtrace")
    add_training_arguments(vtrace)
    vtrace.add_argument("--checkpoint", required=True)
    vtrace.add_argument("--value-loss-weight", type=float, default=0.5)
    vtrace.add_argument("--entropy-bonus", type=float, default=0.001)
    vtrace.set_defaults(func=run_vtrace)

    export = subparsers.add_parser("export")
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--out", required=True)
    export.add_argument("--model-id")
    export.add_argument("--force", action="store_true")
    export.set_defaults(func=run_export)

    parity = subparsers.add_parser("parity")
    parity.add_argument("--model", required=True)
    parity.add_argument("--fixture", required=True)
    parity.add_argument("--out", required=True)
    parity.set_defaults(func=run_parity)

    league = subparsers.add_parser("league")
    league.add_argument("--scaling-report", required=True)
    league.set_defaults(func=run_league_guard)

    scaling = subparsers.add_parser("scaling-report")
    scaling.add_argument("--one-checkpoint", required=True)
    scaling.add_argument("--ten-checkpoint", required=True)
    scaling.add_argument("--full-checkpoint", required=True)
    scaling.add_argument("--one-manifest", required=True)
    scaling.add_argument("--ten-manifest", required=True)
    scaling.add_argument("--full-manifest", required=True)
    scaling.add_argument("--one-model", required=True)
    scaling.add_argument("--ten-model", required=True)
    scaling.add_argument("--full-model", required=True)
    scaling.add_argument("--one-league", required=True)
    scaling.add_argument("--ten-league", required=True)
    scaling.add_argument("--full-league", required=True)
    scaling.add_argument("--out", required=True)
    scaling.set_defaults(func=run_scaling_report)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
