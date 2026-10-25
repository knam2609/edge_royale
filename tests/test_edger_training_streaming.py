from __future__ import annotations

import hashlib
import importlib.util
import copy
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq
import torch


ROOT = Path(__file__).resolve().parents[1]
TRAINING_SCRIPT = ROOT / "scripts" / "edger-v2-training.py"
spec = importlib.util.spec_from_file_location("edger_training", TRAINING_SCRIPT)
training = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = training
spec.loader.exec_module(training)


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_training(
    arguments: list[str],
    *,
    cwd: Path,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TRAINING_SCRIPT), *arguments],
        cwd=cwd,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
    )


def decision_row(index: int, split: str) -> dict[str, object]:
    return {
        "episode_id": f"episode-{index:04d}",
        "tick": index + 1,
        "actor": "red",
        "opponent_stratum": "edger_heuristic",
        "board": [0.0] * (32 * 18 * training.BOARD_INPUT_CHANNELS),
        "global": [0.0] * training.GLOBAL_FEATURES,
        "legal_masks": {
            "card": [1] * 9,
            "placement": [1] * (32 * 18),
            "delay": [1] * 200,
        },
        "selected": {
            "card_index": 0,
            "placement_index": 0,
            "delay_index": 0,
        },
        "delay_ticks": 1,
        "reward": 0.0,
        "discounted_return": 0.0,
        "behavior_log_probability": -6.0,
        "vtrace_eligible": True,
        "source_kind": "simulator",
        "is_winner": False,
        "policy_id": "edger_v2_test",
        "policy_checkpoint_id": "checkpoint-test",
        "policy_league_rating": None,
        "split": split,
        "result_winner": "blue",
        "compatibility_cohort": "test-cohort",
        "reward_version": "edger_potential_reward_v1",
        "per_tick_gamma": 0.9997,
        "balance_stratum": "simulator|edger_heuristic|loss",
        "sample_weight": 1.0,
    }


def recovery_decision_row(index: int) -> dict[str, object]:
    """Production field order/types, including JSON integer-valued floats.

    Matches the first 256 replay-derived rows of manifest ca8435e58fd500f6...
    (PyArrow 17 and 21). Short vectors suffice for this serialization test.
    """
    return {
        "episode_id": f"episode-{index:04d}",
        "tick": index + 1,
        "actor": "red",
        "opponent_stratum": "edger_heuristic",
        "board": [0, 0.5, 1],
        "global": [0, 0.25, 1],
        "legal_masks": {"card": [1, 0], "placement": [0, 1], "delay": [1, 0]},
        "selected": {"card_index": 0, "placement_index": 0, "delay_index": 0},
        "delay_ticks": 1,
        "reward": 0 if index % 2 == 0 else 0.25,
        "discounted_return": 0 if index % 2 == 0 else 0.5,
        "behavior_log_probability": 0,
        "vtrace_eligible": True,
        "source_kind": "simulator",
        "is_winner": False,
        "policy_id": "edger_heuristic",
        "policy_checkpoint_id": "edger_heuristic",
        "policy_league_rating": None,
        "split": ["train", "validation", "test"][index % 3],
        "result_winner": "blue",
        "compatibility_cohort": "test-cohort",
        "reward_version": "edger_potential_reward_v1",
        "per_tick_gamma": 0.9997,
        "balance_stratum": "simulator|edger_heuristic|loss",
        "sample_weight": 0.5,
    }


class TrainingFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="edger-streaming-test-")
        self.root = Path(self.temporary.name)
        self.git_root = self.root / "clean-repo"
        self.git_root.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.git_root, check=True)
        subprocess.run(
            ["git", "config", "user.email", "edger-test@example.invalid"],
            cwd=self.git_root,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Edger Test"],
            cwd=self.git_root,
            check=True,
        )
        marker = self.git_root / "marker.txt"
        marker.write_text("clean\n")
        subprocess.run(["git", "add", "marker.txt"], cwd=self.git_root, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "test fixture"],
            cwd=self.git_root,
            check=True,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def prepare(self, rows: list[dict[str, object]], output: Path) -> Path:
        ndjson = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
        report = output.with_suffix(output.suffix + ".build.json")
        run_training(
            [
                "prepare",
                "--input",
                "-",
                "--out",
                str(output),
                "--manifest-hash",
                "streaming-test-manifest",
                "--scale",
                "1",
                "--report",
                str(report),
            ],
            cwd=self.git_root,
            input_text=ndjson,
        )
        return report

    def validate_cache(self, output: Path, schema_sha256: str) -> dict:
        validation = output.with_suffix(".validation.json")
        run_training(
            [
                "validate-cache", "--dataset", str(output),
                "--build-report", str(output) + ".build.json",
                "--manifest-hash", "streaming-test-manifest",
                "--schema-sha256", schema_sha256,
                "--rows", "257", "--train-rows", "86",
                "--validation-rows", "86", "--test-rows", "85",
                "--out", str(validation),
            ],
            cwd=self.git_root,
        )
        return json.loads(validation.read_text())


class StreamingTrainingTest(TrainingFixture):
    def test_recovery_cache_matches_independently_pinned_schema(self) -> None:
        rows = [recovery_decision_row(index) for index in range(257)]
        output = self.root / "recovery.parquet"
        report = json.loads(self.prepare(rows, output).read_text())
        recovery_path = ROOT / "artifacts/edger-training/recovery/edger_scaling_recovery_v1.json"
        recovery = json.loads(recovery_path.read_text())
        expected = recovery["expected"]["cache"]["schema_sha256"]
        self.assertEqual(report["parquet_schema_sha256"], expected)
        validated = self.validate_cache(output, expected)
        self.assertTrue(validated["passed"])
        self.assertEqual(validated["row_groups"], 2)
        self.assertEqual(
            validated["logical_content_sha256"], report["logical_content_sha256"],
        )
        self.assertEqual(validated["parquet_sha256"], sha256_file(output))
        self.assertEqual(pq.read_table(output).to_pylist(), rows)
        repeated = self.root / "recovery-repeat.parquet"
        self.prepare(rows, repeated)
        self.assertEqual(sha256_file(repeated), sha256_file(output))

        with self.assertRaises(subprocess.CalledProcessError) as rejected:
            self.validate_cache(output, "0" * 64)
        self.assertIn("schema checksum mismatch", rejected.exception.stderr)

    def test_cache_records_and_requires_the_observation_schema(self) -> None:
        rows = [decision_row(index, "train") for index in range(3)]
        output = self.root / "observation.parquet"
        report = json.loads(self.prepare(rows, output).read_text())
        self.assertEqual(report["observation_schema_version"], training.OBSERVATION_SCHEMA)
        metadata = training.parquet_metadata(output)
        training.require_cache_observation_schema(metadata, output)
        for stale in ({}, {"observation_schema_version": "edger_oracle_observation_v2"}):
            with self.assertRaisesRegex(ValueError, "re-derive"):
                training.require_cache_observation_schema(stale, output)

    def test_logical_hash_accepts_lossless_numeric_round_trip_only(self) -> None:
        rows = [recovery_decision_row(index) for index in range(257)]
        output = self.root / "numeric.parquet"
        report = json.loads(self.prepare(rows, output).read_text())
        self.assertNotEqual(
            canonical_json(rows[0]),
            canonical_json(pq.read_table(output).to_pylist()[0]),
        )
        self.assertTrue(self.validate_cache(output, report["parquet_schema_sha256"])["passed"])

        report["logical_content_sha256"] = "0" * 64
        Path(str(output) + ".build.json").write_text(json.dumps(report))
        with self.assertRaises(subprocess.CalledProcessError) as rejected:
            self.validate_cache(output, report["parquet_schema_sha256"])
        self.assertIn("logical replay-derived content mismatch", rejected.exception.stderr)

    def test_prepare_accepts_late_fractional_behavior_log_probability(self) -> None:
        rows = [recovery_decision_row(index) for index in range(257)]
        rows[-1]["behavior_log_probability"] = -0.25
        output = self.root / "league-mixed.parquet"
        report = json.loads(self.prepare(rows, output).read_text())
        persisted = pq.read_table(output).to_pylist()

        self.assertEqual(
            pq.ParquetFile(output).schema_arrow.field("behavior_log_probability").type,
            pa.float64(),
        )
        self.assertEqual(persisted[-1]["behavior_log_probability"], -0.25)
        self.assertEqual(persisted, rows)
        self.assertTrue(
            self.validate_cache(output, report["parquet_schema_sha256"])["passed"]
        )

    def test_prepare_rejects_late_lossy_casts_and_dropped_fields(self) -> None:
        for key, value in [("delay_ticks", 1.25), ("late_field", 1)]:
            with self.subTest(key=key):
                rows = [recovery_decision_row(index) for index in range(257)]
                rows[-1][key] = value
                output = self.root / f"lossy-{key}.parquet"
                with self.assertRaises(subprocess.CalledProcessError) as rejected:
                    self.prepare(rows, output)
                self.assertIn("lossless", rejected.exception.stderr)
                self.assertFalse(output.exists())
                self.assertFalse(output.with_suffix(".parquet.partial").exists())
                self.assertFalse(Path(str(output) + ".build.json").exists())

    def scaling_fixture(
        self,
        label: str,
        train_ids: list[str],
        loss: float,
        league_score: float,
    ) -> dict[str, Path]:
        manifest_content = {
            "schema_version": "edger_dataset_manifest_v1",
            "shards": [
                *({"episode_id": episode_id, "split": "train"} for episode_id in train_ids),
                {"episode_id": "validation-1", "split": "validation"},
                {"episode_id": "test-1", "split": "test"},
            ],
        }
        manifest = {
            **manifest_content,
            "manifest_hash": hashlib.sha256(
                canonical_json(manifest_content).encode(),
            ).hexdigest(),
        }
        manifest_path = self.root / f"manifest-{label}.json"
        manifest_path.write_text(json.dumps(manifest))

        checkpoint_id = f"checkpoint-{label}"
        checkpoint_path = self.root / f"checkpoint-{label}.pt"
        torch.save(
            {
                "schema_version": "edger_v2_checkpoint_v1",
                "checkpoint_id": checkpoint_id,
                "manifest_hash": manifest["manifest_hash"],
                "metrics": {"validation": {"joint_action_loss": loss}},
                "git_commit": f"source-{label}",
            },
            checkpoint_path,
        )

        model = {
            "schema_version": "edger_policy_model_v2",
            "model_id": f"model-{label}",
            "training": {"checkpoint_id": checkpoint_id},
        }
        model_path = self.root / f"model-{label}.json"
        model_path.write_text(json.dumps(model))

        league = {
            "schema_version": "edger_frozen_league_report_v1",
            "candidate_checkpoint_id": checkpoint_id,
            "candidate_model_id": model["model_id"],
            "candidate_model_checksum": sha256_file(model_path),
            "candidate_checkpoint_checksum": sha256_file(checkpoint_path),
            "illegal_actions": 0,
            "replay_checks": {"all_passed": True},
            "suite_spec_checksum": "fixed-suite",
            "frozen_league_score": league_score,
        }
        league_path = self.root / f"league-{label}.json"
        league_path.write_text(json.dumps(league))
        return {
            "checkpoint": checkpoint_path,
            "manifest": manifest_path,
            "model": model_path,
            "league": league_path,
        }

    def test_prepare_writes_stable_256_row_groups_without_changing_rows(self) -> None:
        rows = [recovery_decision_row(index) for index in range(257)]
        output = self.root / "logical.parquet"
        build_report = self.prepare(rows, output)
        parquet = pq.ParquetFile(output)

        self.assertEqual(parquet.num_row_groups, 2)
        self.assertEqual(
            [parquet.metadata.row_group(index).num_rows for index in range(2)],
            [256, 1],
        )
        self.assertEqual(parquet.schema_arrow.metadata[b"row_group_size"], b"256")
        self.assertEqual(parquet.read().to_pylist(), rows)
        cache_build = json.loads(build_report.read_text())
        validation = self.root / "cache-validation.json"
        run_training(
            [
                "validate-cache",
                "--dataset",
                str(output),
                "--build-report",
                str(build_report),
                "--manifest-hash",
                "streaming-test-manifest",
                "--schema-sha256",
                cache_build["parquet_schema_sha256"],
                "--rows",
                "257",
                "--train-rows",
                "86",
                "--validation-rows",
                "86",
                "--test-rows",
                "85",
                "--out",
                str(validation),
            ],
            cwd=self.git_root,
        )
        validated = json.loads(validation.read_text())
        self.assertTrue(validated["passed"])
        self.assertEqual(validated["compression"], "zstd")
        self.assertEqual(validated["row_group_size"], 256)
        self.assertEqual(validated["logical_content_sha256"], cache_build["logical_content_sha256"])

    def test_scaling_gate_uses_relative_loss_and_gameplay_non_regression(self) -> None:
        fixtures = {
            "one": self.scaling_fixture("1pct", ["train-1"], 5.66, 0.54),
            "ten": self.scaling_fixture(
                "10pct",
                ["train-1", "train-2"],
                4.21,
                0.795,
            ),
            "full": self.scaling_fixture(
                "100pct",
                ["train-1", "train-2", "train-3"],
                3.69,
                0.86,
            ),
        }
        output = self.root / "scaling-report.json"
        arguments = ["scaling-report"]
        for artifact in ["checkpoint", "manifest", "model", "league"]:
            arguments.extend([
                f"--one-{artifact}",
                str(fixtures["one"][artifact]),
                f"--ten-{artifact}",
                str(fixtures["ten"][artifact]),
                f"--full-{artifact}",
                str(fixtures["full"][artifact]),
            ])
        arguments.extend(["--out", str(output)])
        run_training(arguments, cwd=self.git_root)

        report = json.loads(output.read_text())
        self.assertEqual(report["schema_version"], "edger_data_scaling_report_v2")
        self.assertTrue(report["passed"])
        self.assertTrue(report["full_improves_held_out_joint_action_loss"])
        self.assertTrue(report["full_non_regressing_frozen_league_score"])
        self.assertNotIn("full_held_out_joint_action_loss_below_10pct", report)
        for label in ["1pct", "10pct", "100pct"]:
            self.assertEqual(
                report["scales"][label]["source_checkpoint_git_commit"],
                f"source-{label}",
            )
        run_training(
            ["league", "--scaling-report", str(output)],
            cwd=self.git_root,
        )

    def test_streaming_bc_offline_rollback_and_episode_vtrace_are_deterministic(self) -> None:
        rows = [
            decision_row(index, "train" if index < 6 else "validation")
            for index in range(8)
        ]
        dataset = self.root / "canary.parquet"
        self.prepare(rows, dataset)
        checkpoints = [self.root / "bc-a.pt", self.root / "bc-b.pt"]
        models = [self.root / "model-a.json", self.root / "model-b.json"]

        for checkpoint, model in zip(checkpoints, models, strict=True):
            run_training(
                [
                    "bc",
                    "--dataset",
                    str(dataset),
                    "--out",
                    str(checkpoint),
                    "--seed",
                    "20260718",
                    "--epochs",
                    "1",
                    "--batch-size",
                    "2",
                    "--learning-rate",
                    "1e-3",
                ],
                cwd=self.git_root,
            )
            run_training(
                [
                    "export",
                    "--checkpoint",
                    str(checkpoint),
                    "--out",
                    str(model),
                ],
                cwd=self.git_root,
            )

        first_model = json.loads(models[0].read_text())
        second_model = json.loads(models[1].read_text())
        self.assertEqual(first_model["weights"], second_model["weights"])

        fixture = self.root / "fixture.json"
        fixture.write_text(json.dumps({
            "observation": {
                "board": rows[0]["board"],
                "global": rows[0]["global"],
            },
            "legal_masks": rows[0]["legal_masks"],
            "forced_card_index": 0,
            "forced_placement_index": 0,
        }))
        parity_outputs = [self.root / "parity-a.json", self.root / "parity-b.json"]
        for model, output in zip(models, parity_outputs, strict=True):
            run_training(
                [
                    "parity",
                    "--model",
                    str(model),
                    "--fixture",
                    str(fixture),
                    "--out",
                    str(output),
                ],
                cwd=self.git_root,
            )
        self.assertEqual(
            json.loads(parity_outputs[0].read_text()),
            json.loads(parity_outputs[1].read_text()),
        )

        offline = self.root / "offline.pt"
        run_training(
            [
                "offline",
                "--dataset",
                str(dataset),
                "--checkpoint",
                str(checkpoints[0]),
                "--out",
                str(offline),
                "--seed",
                "20260718",
                "--epochs",
                "1",
                "--batch-size",
                "2",
                "--learning-rate",
                "10",
            ],
            cwd=self.git_root,
        )
        offline_payload = torch.load(offline, map_location="cpu", weights_only=False)
        self.assertLessEqual(
            offline_payload["metrics"]["validation_kl_from_bc"],
            0.05,
        )
        self.assertTrue(offline_payload["metrics"]["rollback_applied"])

        vtrace = self.root / "vtrace.pt"
        run_training(
            [
                "vtrace",
                "--dataset",
                str(dataset),
                "--checkpoint",
                str(checkpoints[0]),
                "--out",
                str(vtrace),
                "--seed",
                "20260718",
                "--epochs",
                "1",
                "--batch-size",
                "2",
            ],
            cwd=self.git_root,
        )
        vtrace_payload = torch.load(vtrace, map_location="cpu", weights_only=False)
        self.assertEqual(
            vtrace_payload["metrics"]["vtrace"]["target_refresh"],
            "before_each_episode_update",
        )
        self.assertEqual(vtrace_payload["metrics"]["vtrace"]["optimizer_updates"], 6)
        self.assertEqual(vtrace_payload["metrics"]["train_samples"], 6)
        # A bounded learner comparison needs the pre-clip gradient norm of every
        # episode update, not only the fact that training finished.
        gradients = vtrace_payload["metrics"]["vtrace"]["gradient_norms_per_epoch"]
        self.assertEqual(len(gradients), 1)
        self.assertEqual(gradients[0]["epoch"], 0)
        self.assertEqual(gradients[0]["updates"], 6)
        self.assertTrue(gradients[0]["all_finite"])
        self.assertEqual(gradients[0]["clip_threshold"], 1.0)
        self.assertGreaterEqual(gradients[0]["maximum"], gradients[0]["mean"])
        self.assertGreaterEqual(gradients[0]["mean"], gradients[0]["minimum"])
        self.assertGreaterEqual(gradients[0]["minimum"], 0.0)
        self.assertLessEqual(gradients[0]["clipped_updates"], 6)


class VtraceFreshnessTest(unittest.TestCase):
    def test_targets_refresh_after_each_update_and_microbatches_do_not_step(self):
        torch.set_num_threads(1)
        training.seed_everything(91)
        model = training.EdgerV2Policy(1)
        full_batch_model = copy.deepcopy(model)
        rows = [decision_row(index, "train") for index in range(5)]
        for row in rows:
            row["episode_id"] = "one-trajectory"
            row["reward"] = -0.1
        optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
        full_optimizer = torch.optim.SGD(full_batch_model.parameters(), lr=0.1)
        options = dict(value_loss_weight=0.5, entropy_bonus=0.001)
        vocab, device = {"edger_heuristic": 0}, torch.device("cpu")
        snapshots = []
        attach = training.attach_vtrace_targets

        def capture(*args):
            targets = attach(*args)
            snapshots.append([row["target_log_probability_before_update"] for row in targets])
            return targets

        with mock.patch.object(training, "attach_vtrace_targets", side_effect=capture), \
                mock.patch.object(optimizer, "step", wraps=optimizer.step) as step:
            update = training.train_vtrace_episode(model, rows, vocab, 2, device, optimizer, **options)
            self.assertEqual(step.call_count, 1)
            self.assertEqual(update["samples"], 5)
            self.assertTrue(math.isfinite(update["gradient_norm"]))
            full_update = training.train_vtrace_episode(
                full_batch_model, rows, vocab, 5, device, full_optimizer, **options
            )
            # Microbatched accumulation must also report the same pre-clip norm
            # as the equivalent single-batch update.
            self.assertAlmostEqual(
                update["gradient_norm"], full_update["gradient_norm"], places=5
            )
            for name, value in model.state_dict().items():
                torch.testing.assert_close(value, full_batch_model.state_dict()[name], rtol=1e-5, atol=1e-7)
            training.train_vtrace_episode(model, rows, vocab, 2, device, optimizer, **options)
            self.assertEqual(step.call_count, 2)
            self.assertNotEqual(snapshots[0], snapshots[2])

    def test_negative_advantage_is_reweighted_by_current_policy(self):
        class TinyPolicy(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.card = torch.nn.Parameter(torch.zeros(9))

            def actor_logits(self, board, global_features, selected_card, selected_placement):
                size = board.shape[0]
                return {
                    "card": self.card.expand(size, -1),
                    "placement": torch.zeros(size, 576),
                    "delay": torch.zeros(size, 200),
                    "fused": torch.zeros(size, 1),
                }

            def value(self, fused, stratum):
                return fused[:, 0]

        torch.set_num_threads(1)
        model = TinyPolicy()
        optimizer = torch.optim.SGD(model.parameters(), lr=1)
        row = decision_row(0, "train")
        row["reward"] = -1.0
        row["behavior_log_probability"] = -float(torch.log(torch.tensor(9.0 * 200)))
        vocab, device = {"edger_heuristic": 0}, torch.device("cpu")
        initial = training.attach_vtrace_targets(model, [row], vocab, 1, device)[0]
        for _ in range(100):
            training.train_vtrace_episode(model, [row], vocab, 1, device, optimizer,
                                         value_loss_weight=0, entropy_bonus=0)
        final = training.attach_vtrace_targets(model, [row], vocab, 1, device)[0]
        # Reusing the initial advantage would keep a near-unit gradient even
        # after the rejected action becomes vanishingly unlikely.
        self.assertLess(abs(final["vtrace_advantage"]), abs(initial["vtrace_advantage"]) / 50)
        self.assertGreater(final["target_log_probability_before_update"], -15)


class LogitScaleMetricTest(TrainingFixture):
    def _validation(self, model: "training.EdgerV2Policy") -> dict[str, object]:
        rows = [
            decision_row(index, "train" if index < 4 else "validation")
            for index in range(6)
        ]
        dataset = self.root / "logit-scale.parquet"
        self.prepare(rows, dataset)
        return training.evaluate_loss_parquet(
            model,
            dataset,
            "validation",
            {"edger_heuristic": 0},
            2,
            torch.device("cpu"),
        )

    def test_validation_reports_a_logit_scale_warning(self) -> None:
        torch.set_num_threads(1)
        training.seed_everything(23)
        model = training.EdgerV2Policy(1).eval()
        conditioned = self._validation(model)
        self.assertLess(
            conditioned["maximum_legal_logit_magnitude"],
            training.LOGIT_SCALE_WARNING_MAGNITUDE,
        )
        self.assertFalse(conditioned["logit_scale_warning"])

        # A shared bias raises magnitude without changing softmax probabilities.
        # This merits a scale warning, not a conclusion that parity is impossible.
        with torch.no_grad():
            model.delay_head.bias.add_(1_000.0)
        diverged = self._validation(model)
        self.assertGreater(
            diverged["maximum_legal_logit_magnitude"],
            training.LOGIT_SCALE_WARNING_MAGNITUDE,
        )
        self.assertTrue(diverged["logit_scale_warning"])
        self.assertEqual(diverged["logit_scale_warning_threshold"], training.LOGIT_SCALE_WARNING_MAGNITUDE)

    def test_logit_scale_warning_estimate_follows_the_absolute_tolerance(self) -> None:
        self.assertEqual(training.PARITY_ABSOLUTE_TOLERANCE, 1e-5)
        self.assertAlmostEqual(training.LOGIT_SCALE_WARNING_MAGNITUDE, 83.886, places=3)


class ActorExportFidelityTest(unittest.TestCase):
    def _checkpoint(self) -> dict[str, object]:
        return {
            "checkpoint_id": "edger_v2_bc_export_fidelity",
            "phase": "bc",
            "seed": 11,
            "git_commit": "0" * 40,
            "parent_checkpoint": None,
            "manifest_hash": "a" * 64,
            "dataset_checksum": "b" * 64,
            "environment": {"python": "test"},
            "metrics": {},
        }

    def _model(self) -> "training.EdgerV2Policy":
        torch.set_num_threads(1)
        training.seed_everything(17)
        model = training.EdgerV2Policy(1)
        # Weights this small lost trained digits under the old eight-decimal
        # export, which is exactly the range conv1 occupies after training.
        with torch.no_grad():
            model.conv1.weight.view(-1)[0] = 5.8231e-06
            model.conv1.weight.view(-1)[1] = -1.234567891e-03
            model.delay_head.weight.view(-1)[0] = 9.87654321e-05
        return model.eval()

    def test_exported_actor_reloads_as_the_trained_float32_weights(self) -> None:
        model = self._model()
        payload = training.export_model_payload(self._checkpoint(), model, None)
        reloaded = training.load_actor_payload(payload)
        trained = dict(model.named_parameters())
        for name, parameter in reloaded.named_parameters():
            if name.startswith(("value_head", "value_stratum")):
                continue
            self.assertTrue(
                torch.equal(trained[name].detach(), parameter.detach()),
                f"{name} did not reload as the trained float32 weights",
            )
        encoded = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
        self.assertLessEqual(len(encoded), 1_000_000)

    def test_eight_decimal_rounding_is_rejected_as_a_lossy_export(self) -> None:
        model = self._model()
        with mock.patch.object(training, "float32_json", lambda value: round(float(value), 8)):
            with self.assertRaises(ValueError) as caught:
                training.export_model_payload(self._checkpoint(), model, None)
        self.assertIn("lossy", str(caught.exception))

    def test_float32_json_round_trips_every_trained_weight(self) -> None:
        model = self._model()
        values = [
            float(value)
            for parameter in training.actor_parameters(model)
            for value in parameter.detach().cpu().flatten()
        ]
        encoded = [training.float32_json(value) for value in values]
        reloaded = torch.tensor(encoded, dtype=torch.float32).tolist()
        self.assertEqual(values, reloaded)


if __name__ == "__main__":
    unittest.main()
