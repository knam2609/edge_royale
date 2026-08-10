from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import pyarrow.parquet as pq
import torch


ROOT = Path(__file__).resolve().parents[1]
TRAINING_SCRIPT = ROOT / "scripts" / "edger-v2-training.py"


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
        ["python3", str(TRAINING_SCRIPT), *arguments],
        cwd=cwd,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
    )


def decision_row(index: int, split: str) -> dict[str, object]:
    return {
        "episode_id": f"episode-{index:04d}",
        "actor": "red",
        "tick": index + 1,
        "board": [0.0] * (32 * 18 * 24),
        "global": [0.0] * 96,
        "legal_masks": {
            "card": [True] * 9,
            "placement": [True] * (32 * 18),
            "delay": [True] * 200,
        },
        "selected": {
            "card_index": 0,
            "placement_index": 0,
            "delay_index": 0,
        },
        "discounted_return": 0.0,
        "sample_weight": 1.0,
        "opponent_stratum": "edger_heuristic",
        "is_winner": False,
        "policy_league_rating": None,
        "split": split,
        "vtrace_eligible": True,
        "behavior_log_probability": -6.0,
        "delay_ticks": 1,
        "per_tick_gamma": 0.9997,
        "reward": 0.0,
    }


class StreamingTrainingTest(unittest.TestCase):
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

    def prepare(self, rows: list[dict[str, object]], output: Path) -> None:
        ndjson = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
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
            ],
            cwd=self.git_root,
            input_text=ndjson,
        )

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
        rows = [
            {
                "ordinal": index,
                "split": ["train", "validation", "test"][index % 3],
                "sample_weight": 0.5 + index,
                "legal_masks": {"card": [True, False, True]},
                "selected": {"card_index": index % 3},
            }
            for index in range(257)
        ]
        output = self.root / "logical.parquet"
        self.prepare(rows, output)
        parquet = pq.ParquetFile(output)

        self.assertEqual(parquet.num_row_groups, 2)
        self.assertEqual(
            [parquet.metadata.row_group(index).num_rows for index in range(2)],
            [256, 1],
        )
        self.assertEqual(parquet.schema_arrow.metadata[b"row_group_size"], b"256")
        self.assertEqual(parquet.read().to_pylist(), rows)

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
        self.assertTrue(
            vtrace_payload["metrics"]["vtrace"]["episode_grouped_target_parquet"],
        )
        self.assertEqual(
            vtrace_payload["metrics"]["vtrace"]["target_row_group_size"],
            256,
        )
        self.assertEqual(vtrace_payload["metrics"]["train_samples"], 6)


if __name__ == "__main__":
    unittest.main()
