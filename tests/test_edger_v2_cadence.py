from __future__ import annotations

import copy
import importlib.util
import math
import random
import sys
import unittest
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "edger_v2_cadence_experiment", ROOT / "scripts" / "edger-v2-cadence-experiment.py"
)
cadence = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cadence
_spec.loader.exec_module(cadence)
training = cadence.training

VOCAB = {"aggressive": 0, "defender": 1, "edger": 2, "edger_heuristic": 3, "random": 4}
BOARD = training.BOARD_HEIGHT * training.BOARD_WIDTH * training.BOARD_INPUT_CHANNELS


def synthetic_episode(rows: int, *, mode: str, seed: int = 3) -> tuple[list[dict], dict]:
    """The same trajectory as production cache rows and as a cadence episode."""
    rng = random.Random(seed)
    production_rows = []
    columns: dict[str, list] = {key: [] for key in (
        "tick", "card_index", "placement_index", "delay_index", "delay_ticks", "reward",
        "discounted_return", "behavior_log_probability", "behavior_card_log_probability",
        "behavior_placement_log_probability", "behavior_delay_log_probability",
    )}
    board_offsets, board_indices, board_values = [0], [], []
    placement_offsets, placement_indices = [0], []
    globals_, card_masks = [], []
    tick = 1
    for _ in range(rows):
        cells = sorted(rng.sample(range(BOARD), 40))
        values = [float(np.float32(rng.uniform(-1, 1))) for _ in cells]
        board = [0.0] * BOARD
        for cell, value in zip(cells, values):
            board[cell] = value
        global_features = [float(np.float32(rng.uniform(-1, 1))) for _ in range(training.GLOBAL_FEATURES)]
        card_mask = [1] + [int(rng.random() < 0.6) for _ in range(training.CARD_ACTIONS - 1)]
        legal_cards = [index for index, value in enumerate(card_mask) if value]
        card = rng.choice(legal_cards)
        if card == 0:
            legal_cells = [0]
        else:
            legal_cells = sorted(rng.sample(range(training.PLACEMENTS), 30))
        placement = rng.choice(legal_cells)
        placement_mask = [0] * training.PLACEMENTS
        for cell in legal_cells:
            placement_mask[cell] = 1
        if mode == "fixed_one_tick":
            delay_index, delay_ticks, delay_lp = 0, 1, 0.0
        else:
            delay_index = rng.randrange(training.DELAY_BINS)
            delay_ticks, delay_lp = delay_index + 1, -rng.uniform(0, 3)
        card_lp = -rng.uniform(0, 2)
        placement_lp = 0.0 if card == 0 else -rng.uniform(0, 4)
        reward = rng.uniform(-0.05, 0.05)
        row = {
            "episode_id": "synthetic", "tick": tick, "actor": "red", "opponent_stratum": "edger",
            "board": board, "global": global_features,
            "legal_masks": {"card": card_mask, "placement": placement_mask, "delay": [1] * training.DELAY_BINS},
            "selected": {"card_index": card, "placement_index": placement, "delay_index": delay_index},
            "delay_ticks": delay_ticks, "reward": reward, "discounted_return": rng.uniform(-1, 1),
            "behavior_log_probability": card_lp + placement_lp + delay_lp, "vtrace_eligible": True,
            "per_tick_gamma": 0.9997, "sample_weight": 1.0,
        }
        production_rows.append(row)
        for key, value in (
            ("tick", tick), ("card_index", card), ("placement_index", placement),
            ("delay_index", delay_index), ("delay_ticks", delay_ticks), ("reward", reward),
            ("discounted_return", row["discounted_return"]),
            ("behavior_log_probability", row["behavior_log_probability"]),
            ("behavior_card_log_probability", card_lp),
            ("behavior_placement_log_probability", placement_lp),
            ("behavior_delay_log_probability", delay_lp),
        ):
            columns[key].append(value)
        board_indices.extend(cells)
        board_values.extend(values)
        board_offsets.append(len(board_indices))
        placement_indices.extend(legal_cells)
        placement_offsets.append(len(placement_indices))
        globals_.append(global_features)
        card_masks.append(card_mask)
        tick += delay_ticks
    episode = {
        "header": {
            "schema_version": cadence.EPISODE_SCHEMA, "board_size": BOARD, "per_tick_gamma": 0.9997,
            "cadence": mode, "opponent": "edger", "episode_id": "synthetic", "result": {"tick": tick},
        },
        "rows": rows,
        "tick": np.array(columns["tick"], dtype=np.int32),
        "card_index": np.array(columns["card_index"], dtype=np.int16),
        "placement_index": np.array(columns["placement_index"], dtype=np.int16),
        "delay_index": np.array(columns["delay_index"], dtype=np.int16),
        "delay_ticks": np.array(columns["delay_ticks"], dtype=np.int16),
        "reward": np.array(columns["reward"], dtype=np.float64),
        "discounted_return": np.array(columns["discounted_return"], dtype=np.float64),
        "behavior_log_probability": np.array(columns["behavior_log_probability"], dtype=np.float64),
        "behavior_card_log_probability": np.array(columns["behavior_card_log_probability"], dtype=np.float64),
        "behavior_placement_log_probability": np.array(columns["behavior_placement_log_probability"], dtype=np.float64),
        "behavior_delay_log_probability": np.array(columns["behavior_delay_log_probability"], dtype=np.float64),
        "global": np.array(globals_, dtype=np.float32),
        "card_mask": np.array(card_masks, dtype=np.uint8),
        "board_offsets": np.array(board_offsets, dtype=np.int32),
        "board_indices": np.array(board_indices, dtype=np.uint16),
        "board_values": np.array(board_values, dtype=np.float32),
        "placement_offsets": np.array(placement_offsets, dtype=np.int32),
        "placement_indices": np.array(placement_indices, dtype=np.uint16),
    }
    return production_rows, episode


def seeded_policy(seed: int = 20260926) -> "training.EdgerV2Policy":
    torch.manual_seed(seed)
    return training.EdgerV2Policy(len(VOCAB))


class CadenceLearnerTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.use_deterministic_algorithms(True)

    def test_episode_batch_matches_production_dataset_rows(self) -> None:
        rows, episode = synthetic_episode(37, mode="learned")
        production = next(iter(training.loader_for(rows, VOCAB, 37, False, 1)))
        batch = cadence.episode_batch(episode, 0, 37, VOCAB["edger"])
        for field in ("board", "global_features", "card_mask", "placement_mask", "delay_mask",
                      "card", "placement", "delay", "stratum", "sample_weight"):
            self.assertTrue(torch.equal(getattr(batch, field), getattr(production, field)), field)

    def test_learned_mode_is_the_production_vtrace_update(self) -> None:
        rows, episode = synthetic_episode(70, mode="learned")
        production_model = seeded_policy()
        cadence_model = copy.deepcopy(production_model)

        targets = training.attach_vtrace_targets(production_model, rows, VOCAB, 32, torch.device("cpu"))
        with torch.no_grad():
            values, logp = [], []
            for start, end in cadence.microbatch_ranges(70, 32):
                batch = cadence.episode_batch(episode, start, end, VOCAB["edger"])
                logits = training.forward_batch(cadence_model, batch)
                values.extend(cadence_model.value(logits["fused"], batch.stratum).tolist())
                logp.extend(cadence.policy_log_probability(logits, batch, "learned").tolist())
        recursion = cadence.vtrace_recursion(
            values=values, target_log_probabilities=logp,
            behavior_log_probabilities=episode["behavior_log_probability"].tolist(),
            rewards=episode["reward"].tolist(), delay_ticks=episode["delay_ticks"].tolist(),
            per_tick_gamma=0.9997,
        )
        self.assertEqual([row["vtrace_target"] for row in targets], recursion["targets"])
        self.assertEqual([row["vtrace_advantage"] for row in targets], recursion["advantages"])
        self.assertEqual([row["importance_ratio_before_clip"] for row in targets], recursion["ratios"])

        production_optimizer = torch.optim.Adam(production_model.parameters(), lr=1e-3)
        cadence_optimizer = torch.optim.Adam(cadence_model.parameters(), lr=1e-3)
        production_update = training.train_vtrace_episode(
            production_model, rows, VOCAB, 32, torch.device("cpu"), production_optimizer,
            value_loss_weight=0.5, entropy_bonus=0.001,
        )
        cadence_update = cadence.train_cadence_episode(
            cadence_model, episode, cadence_optimizer, delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=32, value_loss_weight=0.5, entropy_bonus=0.001,
        )
        self.assertGreater(production_update["gradient_norm"], 0.0)
        self.assertEqual(production_update["gradient_norm"], cadence_update["gradient_norm"])
        for (name, left), (_, right) in zip(
            production_model.named_parameters(), cadence_model.named_parameters()
        ):
            self.assertTrue(torch.equal(left, right), name)

    def test_fixed_mode_drops_delay_from_log_probability_and_entropy(self) -> None:
        _, episode = synthetic_episode(20, mode="fixed_one_tick")
        model = seeded_policy()
        batch = cadence.episode_batch(episode, 0, 20, VOCAB["edger"])
        logits = training.forward_batch(model, batch)
        heads = cadence.head_log_probabilities(logits, batch)
        joint = training.selected_joint_log_probability(logits, batch)
        fixed = cadence.policy_log_probability(logits, batch, "fixed_one_tick")
        self.assertTrue(torch.allclose(fixed, joint - heads["delay"], atol=1e-5))
        self.assertTrue(torch.equal(fixed, heads["card"] + heads["placement"]))
        self.assertTrue(torch.equal(heads["placement"][batch.card == 0], torch.zeros(int((batch.card == 0).sum()))))
        entropies = cadence.head_entropies(logits, batch)
        self.assertTrue(torch.allclose(
            cadence.policy_entropy(logits, batch, "fixed_one_tick"),
            training.actor_entropy(logits, batch) - entropies["delay"], atol=1e-4,
        ))
        self.assertTrue(torch.equal(
            cadence.policy_entropy(logits, batch, "fixed_one_tick"),
            entropies["card"] + entropies["placement"],
        ))

    def test_fixed_mode_update_leaves_the_unused_delay_head_untouched(self) -> None:
        _, fixed_episode = synthetic_episode(45, mode="fixed_one_tick", seed=5)
        _, learned_episode = synthetic_episode(45, mode="learned", seed=5)
        for mode, episode, expect_change in (
            ("fixed_one_tick", fixed_episode, False), ("learned", learned_episode, True),
        ):
            model = seeded_policy()
            before = copy.deepcopy(model.state_dict())
            optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
            update = cadence.train_cadence_episode(
                model, episode, optimizer, delay_mode=mode, stratum=VOCAB["edger"],
                batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            )
            for name in ("delay_encoder.weight", "delay_encoder.bias", "delay_head.weight", "delay_head.bias"):
                unchanged = torch.equal(before[name], model.state_dict()[name])
                self.assertEqual(unchanged, not expect_change, f"{mode} {name}")
            self.assertEqual(update["group_gradient_norms"]["delay"] == 0.0, not expect_change)
            self.assertFalse(torch.equal(before["card_head.weight"], model.state_dict()["card_head.weight"]))

    def test_fixed_mode_rejects_trajectories_not_from_the_fixed_controller(self) -> None:
        _, episode = synthetic_episode(8, mode="fixed_one_tick")
        cadence.behavior_log_probability(episode, "fixed_one_tick")
        for field, value in (("behavior_delay_log_probability", -0.1), ("delay_ticks", 7), ("delay_index", 3)):
            corrupted = dict(episode)
            corrupted[field] = episode[field].copy()
            corrupted[field][2] = value
            with self.assertRaises(ValueError):
                cadence.behavior_log_probability(corrupted, "fixed_one_tick")
        with self.assertRaises(ValueError):
            cadence.behavior_log_probability(episode, "learned")

    def test_on_policy_fixed_behaviour_gives_unit_importance_ratios(self) -> None:
        _, episode = synthetic_episode(30, mode="fixed_one_tick", seed=9)
        model = seeded_policy()
        with torch.no_grad():
            batch = cadence.episode_batch(episode, 0, 30, VOCAB["edger"])
            heads = cadence.head_log_probabilities(training.forward_batch(model, batch), batch)
        episode["behavior_card_log_probability"] = heads["card"].double().numpy()
        episode["behavior_placement_log_probability"] = heads["placement"].double().numpy()
        episode["behavior_log_probability"] = (heads["card"] + heads["placement"]).double().numpy()
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="fixed_one_tick",
            stratum=VOCAB["edger"], batch_size=32, value_loss_weight=0.5, entropy_bonus=0.001,
        )
        self.assertTrue(all(abs(ratio - 1.0) < 1e-6 for ratio in update["_ratios"]))
        self.assertEqual(update["_log_ratio_per_head"]["delay"], [])

    def test_gradient_decomposition_leaves_the_update_unchanged(self) -> None:
        for mode in ("learned", "fixed_one_tick"):
            _, episode = synthetic_episode(50, mode=mode, seed=11)
            plain = seeded_policy()
            measured = copy.deepcopy(plain)
            plain_update = cadence.train_cadence_episode(
                plain, episode, torch.optim.Adam(plain.parameters(), lr=1e-3), delay_mode=mode,
                stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            )
            measured_update = cadence.train_cadence_episode(
                measured, episode, torch.optim.Adam(measured.parameters(), lr=1e-3), delay_mode=mode,
                stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
                decompose=True,
            )
            self.assertEqual(plain_update["gradient_norm"], measured_update["gradient_norm"])
            for (name, left), (_, right) in zip(plain.named_parameters(), measured.named_parameters()):
                self.assertTrue(torch.equal(left, right), f"{mode} {name}")
            self.assertIsNone(plain_update["gradient_decomposition"])
            decomposition = measured_update["gradient_decomposition"]
            self.assertLess(decomposition["relative_residual"], 1e-5)
            norms = decomposition["group_norms"]
            self.assertEqual(set(norms), {"policy", "value", "entropy"})
            # Value loss never reaches actor heads; actor terms never reach the value head.
            for group in ("card", "placement", "delay"):
                self.assertEqual(norms["value"][group], 0.0)
            self.assertEqual(norms["policy"]["value"], 0.0)
            self.assertEqual(norms["entropy"]["value"], 0.0)
            self.assertGreater(norms["value"]["trunk"], 0.0)
            self.assertGreater(norms["policy"]["trunk"], 0.0)
            self.assertEqual(norms["policy"]["delay"] == 0.0, mode == "fixed_one_tick")
            self.assertIsNotNone(decomposition["trunk_cosine_policy_value"])
            for group, value in measured_update["effective_update_l2"].items():
                self.assertEqual(value == 0.0, mode == "fixed_one_tick" and group == "delay", group)

    def test_a_reference_without_card_kl_leaves_the_update_unchanged(self) -> None:
        _, episode = synthetic_episode(50, mode="learned", seed=23)
        plain = seeded_policy()
        measured = copy.deepcopy(plain)
        reference = seeded_policy(7)
        plain_update = cadence.train_cadence_episode(
            plain, episode, torch.optim.Adam(plain.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
        )
        measured_update = cadence.train_cadence_episode(
            measured, episode, torch.optim.Adam(measured.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            reference=reference,
        )
        self.assertEqual(plain_update["gradient_norm"], measured_update["gradient_norm"])
        for (name, left), (_, right) in zip(plain.named_parameters(), measured.named_parameters()):
            self.assertTrue(torch.equal(left, right), name)
        self.assertIsNone(plain_update["card_kl_to_reference_given_choice"])
        # Measured on the pre-update weights, over rows with a real card choice.
        batch = cadence.episode_batch(episode, 0, 50, VOCAB["edger"])
        with torch.no_grad():
            kl = training.categorical_kl(
                training.forward_batch(reference, batch)["card"],
                training.forward_batch(seeded_policy(), batch)["card"],
                batch.card_mask,
            )
        choice = batch.card_mask[:, 1:].any(dim=1)
        self.assertTrue(math.isclose(
            measured_update["card_kl_to_reference_given_choice"], float(kl[choice].mean()), rel_tol=1e-5))

    def test_card_kl_pulls_the_card_head_toward_the_reference(self) -> None:
        _, episode = synthetic_episode(60, mode="learned", seed=29)
        reference = seeded_policy(7)
        batch = cadence.episode_batch(episode, 0, 60, VOCAB["edger"])

        def kl_after(coefficient: float) -> float:
            model = seeded_policy()
            optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
            for _ in range(3):
                cadence.train_cadence_episode(
                    model, episode, optimizer, delay_mode="learned", stratum=VOCAB["edger"],
                    batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
                    reference=reference, card_kl_coefficient=coefficient,
                )
            with torch.no_grad():
                return float(training.categorical_kl(
                    training.forward_batch(reference, batch)["card"],
                    training.forward_batch(model, batch)["card"],
                    batch.card_mask,
                ).sum())

        self.assertLess(kl_after(5.0), kl_after(0.0))

    def test_card_kl_is_a_separate_card_and_trunk_term(self) -> None:
        _, episode = synthetic_episode(50, mode="learned", seed=31)
        model = seeded_policy()
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            reference=seeded_policy(7), card_kl_coefficient=0.05, decompose=True,
        )
        decomposition = update["gradient_decomposition"]
        self.assertLess(decomposition["relative_residual"], 1e-5)
        norms = decomposition["group_norms"]["card_kl"]
        self.assertGreater(norms["card"], 0.0)
        self.assertGreater(norms["trunk"], 0.0)
        for group in ("placement", "delay", "value"):
            self.assertEqual(norms[group], 0.0, group)
        for invalid in (
            {"card_kl_coefficient": 0.05},
            {"card_kl_coefficient": -1.0, "reference": seeded_policy(7)},
            {"card_kl_coefficient": 0.05, "reference": seeded_policy(7), "loss_mode": "critic_only"},
        ):
            with self.assertRaises(ValueError):
                cadence.train_cadence_episode(
                    model, episode, torch.optim.Adam(model.parameters()), delay_mode="learned",
                    stratum=0, batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001, **invalid,
                )

    def test_the_targeted_card_kl_covers_only_fireball_opportunity_rows(self) -> None:
        _, episode = synthetic_episode(50, mode="learned", seed=37)
        reference = seeded_policy(7)
        batch = cadence.episode_batch(episode, 0, 50, VOCAB["edger"])
        opportunity = training.fireball_opportunity(
            batch.global_features, batch.card_mask
        ) != training.OPPORTUNITY_NONE
        self.assertTrue(0 < int(opportunity.sum()) < 50, "fixture must mix opportunity rows")
        model = seeded_policy()
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            reference=reference, card_kl_coefficient=0.05, card_kl_rows="opportunity", decompose=True,
        )
        # The penalty's gradient is that of the same per-row KL, opportunity rows only.
        fresh = seeded_policy()
        with torch.no_grad():
            reference_card = training.forward_batch(reference, batch)["card"]
        kl = training.categorical_kl(reference_card, training.forward_batch(fresh, batch)["card"], batch.card_mask)
        penalty = 0.05 * kl[opportunity].sum() / 50
        grads = torch.autograd.grad(penalty, list(fresh.parameters()), allow_unused=True)
        expected = cadence.grouped_l2([(name, grad) for (name, _), grad in zip(fresh.named_parameters(), grads)])
        measured = update["gradient_decomposition"]["group_norms"]["card_kl"]
        for group in ("card", "trunk"):
            self.assertGreater(expected[group], 0.0, group)
            self.assertTrue(math.isclose(measured[group], expected[group], rel_tol=1e-4), group)
        self.assertEqual(update["opportunity_rows"], int(opportunity.sum()))
        self.assertTrue(math.isclose(
            update["card_kl_to_reference_given_opportunity"], float(kl.detach()[opportunity].mean()), rel_tol=1e-5))
        with self.assertRaises(ValueError):
            cadence.train_cadence_episode(
                model, episode, torch.optim.Adam(model.parameters()), delay_mode="learned",
                stratum=0, batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
                reference=reference, card_kl_coefficient=0.05, card_kl_rows="choice",
            )

    def test_the_targeted_card_kl_without_opportunity_rows_is_the_production_update(self) -> None:
        _, episode = synthetic_episode(50, mode="learned", seed=41)
        episode["global"][:, list(training.FIREBALL_LETHAL_GLOBALS)] = 0.0
        episode["global"][:, training.FIREBALL_TROOP_HITS_GLOBAL] = 0.0
        plain = seeded_policy()
        targeted = copy.deepcopy(plain)
        reference = seeded_policy(7)
        plain_update = cadence.train_cadence_episode(
            plain, episode, torch.optim.Adam(plain.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            reference=reference,
        )
        targeted_update = cadence.train_cadence_episode(
            targeted, episode, torch.optim.Adam(targeted.parameters(), lr=1e-3), delay_mode="learned",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            reference=reference, card_kl_coefficient=0.05, card_kl_rows="opportunity",
        )
        self.assertEqual(plain_update["gradient_norm"], targeted_update["gradient_norm"])
        for (name, left), (_, right) in zip(plain.named_parameters(), targeted.named_parameters()):
            self.assertTrue(torch.equal(left, right), name)
        self.assertEqual(targeted_update["opportunity_rows"], 0)
        self.assertIsNone(targeted_update["card_kl_to_reference_given_opportunity"])

    def test_heldout_capture_below_the_parent_is_flagged(self) -> None:
        def capture(rows: int, argmax: int, p: float | None) -> dict:
            entry = {
                "rows": rows, "fireball_argmax": argmax,
                "capture_rate": argmax / rows if rows else None, "mean_p_fireball": p,
            }
            return {"lethal": entry, "cluster": entry, "opportunity": entry}

        below = cadence.opportunity_capture_against_parent(capture(10, 2, 0.3), capture(10, 3, 0.2))
        self.assertIs(below["capture_rate_below_parent"], True)
        self.assertIs(below["mean_p_fireball_below_parent"], False)
        equal = cadence.opportunity_capture_against_parent(capture(10, 0, 0.1), capture(10, 0, 0.1))
        self.assertIs(equal["capture_rate_below_parent"], False)
        self.assertIs(equal["mean_p_fireball_below_parent"], False)
        empty = cadence.opportunity_capture_against_parent(capture(0, 0, None), capture(0, 0, None))
        self.assertIsNone(empty["capture_rate_below_parent"])
        self.assertIsNone(empty["mean_p_fireball_below_parent"])

    def test_critic_only_moves_the_actor_only_through_the_trunk(self) -> None:
        _, episode = synthetic_episode(40, mode="fixed_one_tick", seed=13)
        model = seeded_policy()
        before = copy.deepcopy(model.state_dict())
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="fixed_one_tick",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            loss_mode="critic_only", decompose=True,
        )
        after = model.state_dict()
        changed = {name for name in before if not torch.equal(before[name], after[name])}
        prefixes = {name.split(".")[0] for name in changed}
        actor_only = set(cadence.PARAMETER_GROUPS["card"] + cadence.PARAMETER_GROUPS["placement"]
                         + cadence.PARAMETER_GROUPS["delay"])
        self.assertFalse(prefixes & actor_only, prefixes)
        self.assertTrue(prefixes & set(cadence.PARAMETER_GROUPS["trunk"]))
        self.assertIn("value_head", prefixes)
        self.assertEqual(set(update["gradient_decomposition"]["group_norms"]), {"value"})
        self.assertIsNone(update["gradient_decomposition"]["trunk_cosine_policy_value"])
        self.assertLess(update["gradient_decomposition"]["relative_residual"], 1e-6)
        # The actor output still moves because the shared trunk moved.
        batch = cadence.episode_batch(episode, 0, 40, VOCAB["edger"])
        reference = seeded_policy()
        with torch.no_grad():
            self.assertFalse(torch.equal(
                training.forward_batch(model, batch)["card"], training.forward_batch(reference, batch)["card"]
            ))

    def test_value_detached_keeps_value_gradients_out_of_the_trunk(self) -> None:
        _, episode = synthetic_episode(40, mode="fixed_one_tick", seed=17)
        model = seeded_policy()
        before = copy.deepcopy(model.state_dict())
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="fixed_one_tick",
            stratum=VOCAB["edger"], batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001,
            loss_mode="value_detached", decompose=True,
        )
        norms = update["gradient_decomposition"]["group_norms"]
        self.assertEqual(norms["value"]["trunk"], 0.0)
        self.assertGreater(norms["value"]["value"], 0.0)
        self.assertGreater(norms["policy"]["trunk"], 0.0)
        self.assertFalse(torch.equal(before["value_head.weight"], model.state_dict()["value_head.weight"]))
        self.assertFalse(torch.equal(before["card_head.weight"], model.state_dict()["card_head.weight"]))
        with self.assertRaises(ValueError):
            cadence.train_cadence_episode(
                model, episode, torch.optim.Adam(model.parameters()), delay_mode="fixed_one_tick",
                stratum=0, batch_size=16, value_loss_weight=0.5, entropy_bonus=0.001, loss_mode="nope",
            )

    def test_conditional_metrics_use_choice_and_play_denominators(self) -> None:
        _, episode = synthetic_episode(36, mode="fixed_one_tick", seed=19)
        forced = [1, 4, 5, 9, 20, 21, 22]
        for row in forced:
            episode["card_mask"][row] = 0
            episode["card_mask"][row, 0] = 1
            episode["card_index"][row] = 0
            episode["behavior_placement_log_probability"][row] = 0.0
        model = seeded_policy()
        batch = cadence.episode_batch(episode, 0, 36, VOCAB["edger"])
        with torch.no_grad():
            entropies = cadence.head_entropies(training.forward_batch(model, batch), batch)
        choice = torch.ones(36, dtype=torch.bool)
        choice[forced] = False
        play = batch.card != 0
        update = cadence.train_cadence_episode(
            model, episode, torch.optim.Adam(model.parameters(), lr=1e-3), delay_mode="fixed_one_tick",
            stratum=VOCAB["edger"], batch_size=8, value_loss_weight=0.5, entropy_bonus=0.001,
        )
        self.assertEqual(update["choice_rows"], 36 - len(forced))
        self.assertEqual(update["_choice_mask"], choice.tolist())
        self.assertEqual(update["_play_mask"], play.tolist())
        self.assertTrue(math.isclose(
            update["card_entropy_given_choice"], float(entropies["card"][choice].mean()), rel_tol=1e-5))
        self.assertTrue(math.isclose(
            update["placement_entropy_given_play"], float(entropies["placement"][play].mean()), rel_tol=1e-5))
        # Forced-PASS rows have exactly zero card entropy.
        self.assertTrue(torch.all(entropies["card"][~choice] == 0))

    def test_train_iteration_records_loss_mode_and_conditional_metrics(self) -> None:
        import json
        import tempfile
        from types import SimpleNamespace
        from unittest import mock

        episodes = {
            f"ep{index}": synthetic_episode(24 + index, mode="fixed_one_tick", seed=40 + index)[1]
            for index in range(3)
        }
        for episode_id, episode in episodes.items():
            episode["header"] = {**episode["header"], "episode_id": episode_id}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = seeded_policy()
            parent = {
                "schema_version": cadence.DIAGNOSTIC_CHECKPOINT_SCHEMA, "checkpoint_id": "parent",
                "delay_mode": "fixed_one_tick", "loss_mode": "critic_only",
                "model_state": model.state_dict(),
                "optimizer_state": torch.optim.Adam(model.parameters(), lr=1e-3).state_dict(),
                "opponent_stratum_vocabulary": VOCAB,
            }
            torch.save(parent, root / "parent.pt")
            (root / "collection.json").write_text(json.dumps({"episodes": [
                {"match_index": index, "header": str(root / f"{name}.json")}
                for index, name in enumerate(episodes)
            ]}))
            arguments = dict(
                checkpoint=str(root / "parent.pt"), parent=str(root / "parent.pt"),
                collection=str(root / "collection.json"), delay_mode="fixed_one_tick",
                arm="test", iteration=0, out=str(root / "out.pt"),
                metrics_out=str(root / "metrics.json"), learning_rate=1e-3, batch_size=16,
                value_loss_weight=0.5, entropy_bonus=0.001, loss_mode="full",
                card_kl_coefficient=0.0, card_kl_rows="all", decompose_every=2, seed=1,
            )
            loader = lambda path: episodes[Path(path).stem]
            with mock.patch.object(cadence, "load_cadence_episode", loader), \
                    mock.patch("builtins.print"):
                with self.assertRaises(ValueError):
                    cadence.run_train_iteration(SimpleNamespace(**arguments))
                arguments["loss_mode"] = "critic_only"
                cadence.run_train_iteration(SimpleNamespace(**arguments))
                # The card KL coefficient is fixed for the whole arm, like the loss mode.
                with self.assertRaisesRegex(ValueError, "card KL coefficient changed"):
                    cadence.run_train_iteration(SimpleNamespace(**{
                        **arguments, "checkpoint": str(root / "out.pt"), "iteration": 1,
                        "out": str(root / "out1.pt"), "card_kl_coefficient": 0.05,
                    }))
                with self.assertRaisesRegex(ValueError, "card KL rows changed"):
                    cadence.run_train_iteration(SimpleNamespace(**{
                        **arguments, "checkpoint": str(root / "out.pt"), "iteration": 1,
                        "out": str(root / "out1.pt"), "card_kl_rows": "opportunity",
                    }))
            metrics = json.loads((root / "metrics.json").read_text())
            saved = torch.load(root / "out.pt", weights_only=False)
            self.assertEqual(saved["loss_mode"], "critic_only")
            self.assertEqual(saved["card_kl_coefficient"], 0.0)
            self.assertEqual(saved["card_kl_rows"], "all")
            self.assertEqual(metrics["loss_mode"], "critic_only")
            self.assertEqual(metrics["card_kl_coefficient"], 0.0)
            self.assertEqual(metrics["card_kl_rows"], "all")
            self.assertEqual(
                metrics["conditional"]["opportunity_rows"],
                sum(update["opportunity_rows"] for update in metrics["updates"]),
            )
            # Measured against the parent even without the penalty; the trunk moved.
            self.assertGreater(metrics["conditional"]["card_kl_to_reference_given_choice"], 0.0)
            self.assertEqual(metrics["gradient_decomposition"]["episodes"], 2)
            self.assertEqual(set(metrics["gradient_decomposition"]["per_component_group_mean"]), {"value"})
            conditional = metrics["conditional"]
            rows = sum(episode["rows"] for episode in episodes.values())
            self.assertEqual(conditional["rows"], rows)
            self.assertEqual(conditional["choice_rows"] + conditional["forced_pass_rows"], rows)
            self.assertEqual(conditional["play_rows"], metrics["budget"]["play_rows"])
            self.assertEqual(metrics["effective_update_l2"]["per_group_mean"]["card"], 0.0)
            self.assertGreater(metrics["effective_update_l2"]["per_group_mean"]["trunk"], 0.0)

    def test_train_iteration_refuses_mixed_reward_versions(self) -> None:
        import json
        import tempfile
        from types import SimpleNamespace
        from unittest import mock

        v1, v2 = cadence.REWARD_VERSIONS
        episodes = {
            f"ep{index}": synthetic_episode(12, mode="fixed_one_tick", seed=70 + index)[1]
            for index in range(2)
        }
        for episode_id, episode in episodes.items():
            episode["header"] = {**episode["header"], "episode_id": episode_id, "reward_version": v2}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = seeded_policy()
            torch.save({
                "schema_version": cadence.DIAGNOSTIC_CHECKPOINT_SCHEMA, "checkpoint_id": "parent",
                "delay_mode": "fixed_one_tick", "loss_mode": "critic_only", "reward_version": v2,
                "model_state": model.state_dict(),
                "optimizer_state": torch.optim.Adam(model.parameters(), lr=1e-3).state_dict(),
                "opponent_stratum_vocabulary": VOCAB,
            }, root / "parent.pt")

            def write_collection(version: str | None) -> None:
                collection = {"episodes": [
                    {"match_index": index, "header": str(root / f"{name}.json")}
                    for index, name in enumerate(episodes)
                ]}
                if version is not None:
                    collection["reward_version"] = version
                (root / "collection.json").write_text(json.dumps(collection))

            arguments = dict(
                checkpoint=str(root / "parent.pt"), parent=str(root / "parent.pt"),
                collection=str(root / "collection.json"), delay_mode="fixed_one_tick",
                arm="test", iteration=0, out=str(root / "out.pt"),
                metrics_out=str(root / "metrics.json"), learning_rate=1e-3, batch_size=16,
                value_loss_weight=0.5, entropy_bonus=0.001, loss_mode="critic_only",
                card_kl_coefficient=0.0, card_kl_rows="all", decompose_every=0, seed=1,
                reward_version=v2,
            )
            loader = lambda path: episodes[Path(path).stem]
            with mock.patch.object(cadence, "load_cadence_episode", loader), \
                    mock.patch("builtins.print"):
                # A collection without a version is v1, so it does not match a v2 arm.
                write_collection(None)
                with self.assertRaisesRegex(ValueError, "collection reward version"):
                    cadence.run_train_iteration(SimpleNamespace(**arguments))
                # Episodes must all carry the arm's version.
                write_collection(v2)
                episodes["ep1"]["header"]["reward_version"] = v1
                with self.assertRaisesRegex(ValueError, "episode .* reward version"):
                    cadence.run_train_iteration(SimpleNamespace(**arguments))
                episodes["ep1"]["header"]["reward_version"] = v2
                cadence.run_train_iteration(SimpleNamespace(**arguments))
                saved = torch.load(root / "out.pt", weights_only=False)
                self.assertEqual(saved["reward_version"], v2)
                self.assertEqual(json.loads((root / "metrics.json").read_text())["reward_version"], v2)
                # The version is fixed for the whole arm.
                with self.assertRaisesRegex(ValueError, "reward version changed within an arm"):
                    cadence.run_train_iteration(SimpleNamespace(**{
                        **arguments, "checkpoint": str(root / "out.pt"), "iteration": 1,
                        "out": str(root / "out1.pt"), "reward_version": v1,
                    }))
                with self.assertRaisesRegex(ValueError, "--reward-version must be one of"):
                    cadence.run_train_iteration(SimpleNamespace(**{**arguments, "reward_version": "nope"}))

    def test_vtrace_discount_follows_recorded_intervals(self) -> None:
        values = [0.2, -0.1, 0.4]
        result = cadence.vtrace_recursion(
            values=values, target_log_probabilities=[0.0] * 3, behavior_log_probabilities=[0.0] * 3,
            rewards=[0.01, -0.02, 1.0], delay_ticks=[1, 1, 1], per_tick_gamma=0.9997,
        )
        # On-policy with unit ratios, V-trace reduces to discounted returns.
        expected_last = 1.0
        expected_middle = -0.02 + 0.9997 * expected_last
        expected_first = 0.01 + 0.9997 * expected_middle
        for got, want in zip(result["targets"], [expected_first, expected_middle, expected_last]):
            self.assertTrue(math.isclose(got, want, rel_tol=1e-12, abs_tol=1e-12))
        sparse = cadence.vtrace_recursion(
            values=values, target_log_probabilities=[0.0] * 3, behavior_log_probabilities=[0.0] * 3,
            rewards=[0.01, -0.02, 1.0], delay_ticks=[40, 1, 1], per_tick_gamma=0.9997,
        )
        self.assertTrue(math.isclose(sparse["targets"][0], 0.01 + 0.9997**40 * expected_middle, rel_tol=1e-12))


if __name__ == "__main__":
    unittest.main()
