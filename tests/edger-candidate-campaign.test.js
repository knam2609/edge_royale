// Candidate campaign tooling (docs/EDGER_CANDIDATE_CAMPAIGN.md, owner decision
// of November 23, 2026): the final evaluator's schedule seeds, the selection
// seed set, the external QA report writer and the lineage-checked candidate
// export.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HEURISTIC_BOT_ID } from "../src/ai/botRuntime.js";
import { createEdgerV2BootstrapModel, validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { makeMatchSpecs } from "../scripts/edger-league-core.mjs";
import { deriveLabelledSeeds } from "../scripts/edger-v2-cadence-core.mjs";
import {
  CANDIDATE_SELECTION_SEED_PLAN_SCHEMA,
  buildCadenceSeedPlan,
  buildCandidateSelectionSeedPlan,
  buildReplicationSeedPlans,
  candidateFinalEvaluationSeeds,
  collectPlanSeedSets,
  frozenSuiteSeeds,
  selectEvaluationSeeds,
} from "../scripts/edger-v2-cadence-experiment.mjs";
import {
  EDGER_V2_EVALUATION_PROFILES,
  EDGER_V2_WEAK_BASELINES,
  assertEdgerV2ModelPromotable,
  buildEdgerV2EvaluationSpecs,
  edgerV2EvaluationScheduleSeeds,
  edgerV2ReferenceMatchSeeds,
  validateExternalCampaignReport,
} from "../scripts/edger-v2-evaluation-core.mjs";
import {
  EDGER_EXTERNAL_QA_REPORT_SCHEMA,
  buildEdgerExternalQaReport,
  edgerExternalQaCommand,
  serializeEdgerExternalQaReport,
  writeEdgerExternalQaReport,
} from "../scripts/edger-qa-report.mjs";
import { spawnNativePython } from "../scripts/python-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("the evaluator's schedule seeds are the seeds its full schedule plays", () => {
  const bot = (policyId) => ({ kind: "bot", policy_id: policyId, checkpoint_id: null });
  const specs = buildEdgerV2EvaluationSpecs({
    seed: 20260718,
    profile: EDGER_V2_EVALUATION_PROFILES.full,
    champion: { kind: "model", policy_id: "live", checkpoint_id: null, model_path: "/live.json" },
    heuristic: bot(HEURISTIC_BOT_ID),
    anchors: [],
    weakBaselines: EDGER_V2_WEAK_BASELINES.map(bot),
  });
  const seeds = edgerV2EvaluationScheduleSeeds({ seed: 20260718 });
  assert.deepEqual(seeds, [...new Set(specs.map((spec) => spec.seed))]);
  // 400 champion, 100 heuristic and 150 weak pairs, 5,000 safety repeats.
  assert.equal(seeds.length, 5650);
  // Why 20260718 is replaced: its schedule holds every September league
  // training seed, and the frozen suites already exclude all of it.
  const league = makeMatchSpecs({
    matches: 1000, seed: 20260718,
    league: { champion: { kind: "model", policy_id: "champion", score: 0.5 }, historical: [], contenders: [] },
  });
  const scheduled = new Set(seeds);
  assert.ok(league.every((spec) => scheduled.has(spec.seed)));
  const frozen = frozenSuiteSeeds();
  assert.ok(seeds.every((seed) => frozen.has(seed)));
  // Every pair draws one value from the seed's stream, so an anchor adds the
  // next 100 draws: the same stream, regrouped.
  const anchored = edgerV2EvaluationScheduleSeeds({ seed: 5, anchorCount: 1 });
  assert.equal(anchored.length, 5750);
  assert.deepEqual(anchored.slice(0, 5650), edgerV2EvaluationScheduleSeeds({ seed: 5 }));
  assert.equal(edgerV2EvaluationScheduleSeeds({ seed: 5, profileName: "smoke" }).length, 8);
  assert.throws(() => edgerV2EvaluationScheduleSeeds({ seed: 5, profileName: "nope" }), /unknown evaluation profile/);
  assert.throws(() => edgerV2EvaluationScheduleSeeds({ seed: "5" }), /must be an integer/);
  assert.deepEqual(edgerV2ReferenceMatchSeeds({ seed: 100, gamesPerOpponent: 6 }), [100, 101, 102]);
  assert.equal(edgerV2ReferenceMatchSeeds({ seed: 100 }).length, 100);
  const final = candidateFinalEvaluationSeeds(20260718);
  assert.deepEqual(final.schedule, seeds);
  assert.deepEqual(final.reference, edgerV2ReferenceMatchSeeds({ seed: 20260718 }));
});

test("selection seeds avoid the frozen suites, every excluded plan and the final evaluation", () => {
  const base = buildCadenceSeedPlan({ development: 30, probe: 4, training: 20 });
  const replication = buildReplicationSeedPlans(base, { replicates: ["r1"], training: 20, confirmation: 25 });
  const finalSeed = 424242;
  const final = candidateFinalEvaluationSeeds(finalSeed);
  const options = {
    label: "edger-candidate-select-test", count: 40, finalEvaluationSeed: finalSeed,
    excludePlans: [base, replication], extraExclusions: { archived: [7, 8] },
  };
  const plan = buildCandidateSelectionSeedPlan(options);
  assert.deepEqual(buildCandidateSelectionSeedPlan(options), plan);
  assert.equal(plan.schema_version, CANDIDATE_SELECTION_SEED_PLAN_SCHEMA);
  assert.equal(plan.selection.length, 40);
  assert.equal(new Set(plan.selection).size, 40);
  assert.deepEqual(plan.final_evaluation, {
    seed: finalSeed, profile: "full", anchors: 0, reference_games_per_opponent: 200,
    schedule_match_seeds: 5650, reference_match_seeds: 100,
  });
  assert.deepEqual(plan.exclusions.extra, { archived: 2 });
  const excluded = new Set([
    ...frozenSuiteSeeds(), ...final.schedule, ...final.reference,
    ...[base, replication].flatMap((other) => Object.values(collectPlanSeedSets(other)).flat()),
  ]);
  assert.ok(plan.selection.every((seed) => !excluded.has(seed)));
  // Only the selection set is a seed set in the file.
  assert.deepEqual(Object.keys(collectPlanSeedSets(plan)), ["selection"]);

  // An extra exclusion removes exactly that seed from the labelled order.
  const first = deriveLabelledSeeds({ label: options.label, count: 1 })[0];
  assert.equal(plan.selection[0], first);
  const shifted = buildCandidateSelectionSeedPlan({ ...options, extraExclusions: { archived: [first] } });
  assert.deepEqual(shifted.selection.slice(0, 39), plan.selection.slice(1));

  assert.deepEqual(
    selectEvaluationSeeds(plan, { set: "selection", pairs: 40, excludePlans: [base, replication] }),
    plan.selection,
  );
  const tamper = (seed) => ({ ...plan, selection: [...plan.selection.slice(0, 39), seed] });
  assert.throws(() => selectEvaluationSeeds(tamper(final.schedule[17]), { set: "selection", pairs: 3 }),
    /also appears in the final evaluation schedule of seed 424242/);
  assert.throws(() => selectEvaluationSeeds(tamper(final.reference[3]), { set: "selection", pairs: 3 }),
    /also appears in the final evaluation reference of seed 424242/);
  assert.throws(
    () => selectEvaluationSeeds(tamper(replication.replicates.r1.training[0]), { set: "selection", pairs: 3, excludePlans: [replication] }),
    /also appears in excluded plan 0 replicates\.r1\.training/,
  );
  assert.throws(() => selectEvaluationSeeds({ ...plan, final_evaluation: {} }, { set: "selection", pairs: 3 }),
    /must name its final evaluation seed/);
  assert.throws(() => selectEvaluationSeeds(replication, { set: "selection", pairs: 3 }),
    /selection seeds come from a edger_v2_candidate_selection_seed_plan_v1 plan/);
  assert.throws(() => selectEvaluationSeeds(plan, { set: "confirmation", pairs: 3 }),
    /confirmation seeds come from a edger_v2_cadence_replication_seed_plan_v1 plan/);
  assert.throws(() => buildCandidateSelectionSeedPlan({ ...options, label: "" }), /needs a label/);
  assert.throws(() => buildCandidateSelectionSeedPlan({ ...options, finalEvaluationSeed: undefined }), /final evaluation seed/);
  assert.throws(() => buildCandidateSelectionSeedPlan({ ...options, extraExclusions: { bad: [1.5] } }), /integer seeds/);
});

test("selection-seeds records its exclusion files and evaluate plays only the selection set", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-candidate-selection-"));
  try {
    const base = buildCadenceSeedPlan({ development: 3, probe: 1, training: 2 });
    const files = {
      base: path.join(directory, "base.json"),
      archived: path.join(directory, "archived.json"),
      plan: path.join(directory, "selection.json"),
      model: path.join(directory, "model.json"),
      report: path.join(directory, "report.json"),
    };
    fs.writeFileSync(files.base, JSON.stringify(base));
    const label = "edger-candidate-select-cli-test";
    const blocked = deriveLabelledSeeds({ label, count: 1 })[0];
    fs.writeFileSync(files.archived, JSON.stringify({ evaluation: [blocked] }));
    const cli = (...argv) => spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "edger-v2-cadence-experiment.mjs"), ...argv,
    ], { cwd: ROOT, encoding: "utf8" });
    const seedsArgs = ["selection-seeds", "--label", label, "--count", "2", "--final-evaluation-seed", "99",
      "--exclude-seed-plans", files.base, "--exclude-seed-lists", files.archived, "--out", files.plan];
    const made = cli(...seedsArgs);
    assert.equal(made.status, 0, made.stderr);
    const plan = JSON.parse(fs.readFileSync(files.plan, "utf8"));
    assert.ok(!plan.selection.includes(blocked));
    assert.deepEqual(plan.exclusions.extra, { "archived.json:evaluation": 1 });
    assert.deepEqual(plan.exclusion_files.seed_plans, [{ path: files.base, sha256: sha256(files.base) }]);
    assert.deepEqual(plan.exclusion_files.seed_lists, [{ path: files.archived, sha256: sha256(files.archived) }]);
    const again = cli(...seedsArgs);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);

    fs.writeFileSync(files.model, JSON.stringify(createEdgerV2BootstrapModel({ modelId: "selection-test" })));
    const played = cli("evaluate", "--model", files.model, "--cadence", "learned", "--opponent", "aggressive",
      "--pairs", "1", "--workers", "2", "--seeds", files.plan, "--seed-set", "selection",
      "--exclude-seed-plans", files.base, "--out", files.report);
    assert.equal(played.status, 0, played.stderr);
    const report = JSON.parse(fs.readFileSync(files.report, "utf8"));
    assert.equal(report.seed_selection.set, "selection");
    assert.equal(report.seed_selection.plan_schema_version, CANDIDATE_SELECTION_SEED_PLAN_SCHEMA);
    assert.deepEqual(report.results.map((result) => result.seed), [plan.selection[0], plan.selection[0]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

test("QA reports are written only after a passing command in an unchanged clean checkout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-qa-report-"));
  try {
    const repo = path.join(directory, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "file.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    const commit = git(repo, "rev-parse", "HEAD");
    const out = (name) => path.join(directory, name);
    const calls = [];
    const pass = (file, args) => {
      calls.push([file, ...args]);
      return { status: 0 };
    };

    const report = writeEdgerExternalQaReport({
      kind: "npm-test", out: out("test.json"), extraArgs: ["--test-concurrency=2"], cwd: repo, run: pass,
    });
    assert.deepEqual(calls, [["npm", "test", "--", "--test-concurrency=2"]]);
    assert.deepEqual(report, {
      schema_version: EDGER_EXTERNAL_QA_REPORT_SCHEMA, kind: "npm-test",
      command: "npm test -- --test-concurrency=2", git_commit: commit, passed: true,
    });
    assert.equal(fs.readFileSync(out("test.json"), "utf8"), serializeEdgerExternalQaReport(report));
    assert.equal(validateExternalCampaignReport(report, { label: "npm test", expectedGitCommit: commit }).passed, true);
    assert.throws(() => writeEdgerExternalQaReport({ kind: "npm-test", out: out("test.json"), cwd: repo, run: pass }),
      /already exists/);

    const browser = writeEdgerExternalQaReport({ kind: "browser-smoke", out: out("browser.json"), cwd: repo, run: pass });
    assert.equal(browser.command, "npm run smoke:browser");
    // The production driver's reports are the same bytes.
    assert.equal(
      serializeEdgerExternalQaReport(buildEdgerExternalQaReport({ kind: "browser-smoke", command: "npm run smoke:browser", gitCommit: commit })),
      fs.readFileSync(out("browser.json"), "utf8"),
    );

    assert.throws(() => writeEdgerExternalQaReport({
      kind: "npm-test", out: out("failed.json"), cwd: repo, run: () => ({ status: 1 }),
    }), /exited 1; no report written/);
    assert.equal(fs.existsSync(out("failed.json")), false);
    assert.throws(() => writeEdgerExternalQaReport({
      kind: "npm-test", out: out("dirtied.json"), cwd: repo,
      run: () => {
        fs.writeFileSync(path.join(repo, "left-behind.txt"), "x\n");
        return { status: 0 };
      },
    }), /the checkout changed/);
    assert.equal(fs.existsSync(out("dirtied.json")), false);
    assert.throws(() => writeEdgerExternalQaReport({ kind: "npm-test", out: out("dirty.json"), cwd: repo, run: pass }),
      /clean checkout/);
    fs.rmSync(path.join(repo, "left-behind.txt"));
    assert.throws(() => edgerExternalQaCommand("lint"), /--kind must be one of npm-test, browser-smoke/);
    assert.throws(() => buildEdgerExternalQaReport({ kind: "npm-test", command: "npm test", gitCommit: "abc" }),
      /full Git commit/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The lineage checker on a real two-iteration arm, trained from a clean
// clone of the current scripts so every provenance record is clean. The
// command line always checks the measured 24 x 32 recipe; the positive path
// runs through the same functions with the arm's smaller recipe.
const LINEAGE_SCRIPT = String.raw`
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("cadence", "scripts/edger-v2-cadence-experiment.py")
cadence = importlib.util.module_from_spec(spec)
sys.modules["cadence"] = cadence
spec.loader.exec_module(cadence)
work = Path(sys.argv[1])
recipe = {**cadence.CANDIDATE_RECIPE, "iterations": 2, "pairs_per_iteration": 1}
dataset = "d" * 64
entry = {"run": "c1", "bc_seed": 77, "bc_checkpoint": str(work / "bc.pt"), "plan": str(work / "plan.json"),
         "work_dir": str(work / "c1")}
missing = {"run": "c2", "bc_seed": 78, "bc_checkpoint": str(work / "missing.pt"), "plan": str(work / "plan.json"),
           "work_dir": str(work / "c2")}
# c3 stopped in its second iteration: a record without a checkpoint.
import shutil
shutil.copytree(work / "c1", work / "c3")
status = json.loads((work / "c3" / "arm-status.json").read_text())
status["iterations"][1] = {key: value for key, value in status["iterations"][1].items()
                           if key not in ("checkpoint", "checkpoint_sha256", "model", "model_sha256")}
status["stop_reason"] = "collapse: zero successful deployments in iteration 1"
(work / "c3" / "arm-status.json").write_text(json.dumps(status))
stopped = {**entry, "run": "c3", "work_dir": str(work / "c3")}
broken = {**entry, "run": "c4", "work_dir": str(work / "c4")}
(work / "c4").mkdir()
(work / "c4" / "arm-status.json").write_text("{}")
out = {}

def error(call):
    try:
        call()
    except Exception as caught:
        return f"{type(caught).__name__}: {caught}"
    return None

manifest = cadence.build_candidate_manifest([entry, missing, stopped, broken], campaign_id="test",
                                            bc_dataset_sha256=dataset, out=work / "manifest.json", recipe=recipe)
out["valid"] = {item["run"]: item["lineage_valid"] for item in manifest["runs"]}
out["c2_problems"] = manifest["runs"][1]["problems"]
out["c3_problems"] = manifest["runs"][2]["problems"]
out["c3_chain"] = [link["iteration"] for link in manifest["runs"][2]["lineage"]["chain"]]
out["c4_problems"] = manifest["runs"][3]["problems"]
out["strict_problems"] = cadence.lineage_problems(entry, manifest["runs"][0]["lineage"],
    git_commit=manifest["git_commit"], bc_dataset_sha256=dataset)
out["wrong_bc_seed"] = cadence.lineage_problems({**entry, "bc_seed": 99}, manifest["runs"][0]["lineage"],
    git_commit=manifest["git_commit"], bc_dataset_sha256=dataset, recipe=recipe)
out["wrong_dataset"] = cadence.lineage_problems(entry, manifest["runs"][0]["lineage"],
    git_commit=manifest["git_commit"], bc_dataset_sha256="e" * 64, recipe=recipe)
manifest_sha = cadence.training.sha256_file(work / "manifest.json")
def selection(name, selected, sha=manifest_sha):
    path = work / name
    path.write_text(json.dumps({"schema_version": cadence.CANDIDATE_SELECTION_SCHEMA,
                                "manifest_sha256": sha, "selected": selected}))
    return path
chosen = selection("selection.json", "c1")
out["unselected"] = error(lambda: cadence.export_candidate(work / "manifest.json", selection("s2.json", "c2"), "c1",
    work / "x.json", work / "xb.json", recipe=recipe))
out["invalid_run"] = error(lambda: cadence.export_candidate(work / "manifest.json", selection("s3.json", "c2"), "c2",
    work / "x.json", work / "xb.json", recipe=recipe))
out["other_manifest"] = error(lambda: cadence.export_candidate(work / "manifest.json", selection("s4.json", "c1", "0" * 64),
    "c1", work / "x.json", work / "xb.json", recipe=recipe))
out["strict_recipe"] = error(lambda: cadence.export_candidate(work / "manifest.json", chosen, "c1",
    work / "x.json", work / "xb.json"))
untracked = Path("left-behind.txt")
untracked.write_text("x")
out["dirty"] = error(lambda: cadence.export_candidate(work / "manifest.json", chosen, "c1",
    work / "x.json", work / "xb.json", recipe=recipe))
untracked.unlink()
out["binding"] = cadence.export_candidate(work / "manifest.json", chosen, "c1", work / "candidate.json",
                                          work / "binding.json", recipe=recipe)
out["again"] = error(lambda: cadence.export_candidate(work / "manifest.json", chosen, "c1", work / "candidate.json",
    work / "b2.json", recipe=recipe))
collection = work / "c1" / "iter1" / "collection.json"
collection.write_text(collection.read_text() + " ")
out["tampered"] = error(lambda: cadence.export_candidate(work / "manifest.json", chosen, "c1",
    work / "y.json", work / "yb.json", recipe=recipe))
print(json.dumps(out))
`;

test("only the selected run, with its whole lineage verified, is exported as a candidate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "edger-candidate-export-"));
  try {
    const clone = path.join(directory, "clone");
    fs.mkdirSync(clone);
    for (const name of ["scripts", "src"]) {
      fs.cpSync(path.join(ROOT, name), path.join(clone, name), {
        recursive: true, filter: (source) => !source.includes("__pycache__"),
      });
    }
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(clone, "package.json"));
    fs.writeFileSync(path.join(clone, ".gitignore"), "__pycache__/\n");
    git(clone, "init", "-q");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "campaign");
    const commit = git(clone, "rev-parse", "HEAD");
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    const python = (argv) => {
      const result = spawnNativePython(argv, { cwd: clone, encoding: "utf8", env });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    // A small BC-phase parent (default data recipe), then the full-grid start.
    python(["-c", [
      "import importlib.util, sys, torch",
      "spec = importlib.util.spec_from_file_location('t', 'scripts/edger-v2-training.py')",
      "t = importlib.util.module_from_spec(spec); sys.modules['t'] = t; spec.loader.exec_module(t)",
      "torch.manual_seed(7); m = t.EdgerV2Policy(5)",
      "vocab = {'aggressive': 0, 'defender': 1, 'edger': 2, 'edger_heuristic': 3, 'random': 4}",
      "metrics = {'data_recipe': {'card_teacher_filter': 'none', 'opportunity_oversample': 1}}",
      "p = t.checkpoint_payload(model=m, optimizer=torch.optim.Adam(m.parameters()), phase='bc', seed=77, manifest_hash='test', dataset_checksum='d' * 64, parent_checkpoint=None, vocab=vocab, metrics=metrics)",
      `t.save_checkpoint(${JSON.stringify(path.join(directory, "bc.pt"))}, p)`,
    ].join("\n")]);
    const arm = path.join(directory, "c1");
    python(["scripts/edger-v2-training.py", "initialize-full-grid", "--checkpoint", path.join(directory, "bc.pt"),
      "--out", path.join(arm, "initial.pt"), "--model-out", path.join(arm, "initial.json")]);
    const base = buildCadenceSeedPlan({ development: 3, probe: 1, training: 2 });
    const plan = buildReplicationSeedPlans(base, { replicates: ["r1"], training: 2, confirmation: 2 }).replicates.r1;
    fs.writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan));
    const trained = spawnSync(process.execPath, [
      "scripts/edger-v2-cadence-experiment.mjs", "train-arm", "--arm", "A-c1", "--cadence", "learned",
      "--seeds", path.join(directory, "plan.json"), "--iterations", "2", "--pairs-per-iteration", "1",
      "--workers", "2", "--torch-seed", "20260926", "--parent-checkpoint", path.join(arm, "initial.pt"),
      "--parent-model", path.join(arm, "initial.json"), "--work-dir", arm,
      "--reward", "edger_potential_reward_v1", "--prune-episodes",
    ], { cwd: clone, encoding: "utf8", env });
    assert.equal(trained.status, 0, trained.stderr);
    assert.equal(git(clone, "status", "--porcelain"), "");

    fs.writeFileSync(path.join(directory, "lineage.py"), LINEAGE_SCRIPT);
    const out = JSON.parse(python([path.join(directory, "lineage.py"), directory]).trim().split("\n").at(-1));
    assert.deepEqual(out.valid, { c1: true, c2: false, c3: false, c4: false });
    assert.deepEqual(out.c2_problems, ["the run did not train"]);
    assert.deepEqual(out.c3_chain, [0]);
    assert.ok(out.c3_problems.includes("the arm stopped with 'collapse: zero successful deployments in iteration 1'"));
    assert.ok(out.c3_problems.includes("the arm did not complete every iteration"));
    assert.match(out.c4_problems[0], /^the lineage could not be read: FileNotFoundError/);
    assert.ok(out.strict_problems.includes("arm setting iterations is 2, not 24"));
    assert.ok(out.strict_problems.includes("arm setting pairs_per_iteration is 1, not 32"));
    assert.deepEqual(out.wrong_bc_seed, ["the BC parent's seed 77 is not 99"]);
    assert.deepEqual(out.wrong_dataset, ["the BC parent was trained on another dataset"]);
    assert.match(out.unselected, /LineageError: run c1 was not selected \(selected: c2\)/);
    assert.match(out.invalid_run, /LineageError: run c2 failed its lineage check/);
    assert.match(out.other_manifest, /LineageError: the selection was made on another manifest/);
    assert.match(out.strict_recipe, /LineageError: the manifest's recipe is not the measured recipe/);
    assert.match(out.dirty, /LineageError: export a candidate only from a clean checkout/);
    assert.match(out.again, /FileExistsError/);
    assert.match(out.tampered, /LineageError: run c1's files no longer match the manifest/);
    for (const name of ["x.json", "xb.json", "y.json", "yb.json", "b2.json"]) {
      assert.equal(fs.existsSync(path.join(directory, name)), false, name);
    }

    const candidatePath = path.join(directory, "candidate.json");
    const candidate = validateEdgerV2PolicyModel(JSON.parse(fs.readFileSync(candidatePath, "utf8")));
    const selected = JSON.parse(fs.readFileSync(path.join(arm, "iter1", "model.json"), "utf8"));
    assert.deepEqual(candidate.weights, selected.weights);
    assert.equal(candidate.model_id, "edger_v2_candidate_test_c1");
    assert.equal(candidate.training.promotion_status, "shadow_candidate_unreviewed");
    assert.equal(candidate.training.git_commit, commit);
    assert.deepEqual(candidate.training.campaign, {
      campaign_id: "test",
      manifest_sha256: sha256(path.join(directory, "manifest.json")),
      selection_sha256: sha256(path.join(directory, "selection.json")),
      run: "c1",
      checkpoint_sha256: sha256(path.join(arm, "iter1", "checkpoint.pt")),
      bc_checkpoint_sha256: sha256(path.join(directory, "bc.pt")),
    });
    const binding = JSON.parse(fs.readFileSync(path.join(directory, "binding.json"), "utf8"));
    assert.deepEqual(out.binding, binding);
    assert.equal(binding.export_sha256, sha256(candidatePath));
    assert.equal(binding.model_id, candidate.model_id);
    assert.doesNotThrow(() => assertEdgerV2ModelPromotable(candidate, { context: "test" }));
    assert.throws(() => assertEdgerV2ModelPromotable(selected, { context: "test" }), /diagnostic_only_not_promotable/);

    // The command line refuses the two-iteration arm: the recipe is fixed.
    const refused = spawnNativePython(["scripts/edger-v2-cadence-experiment.py", "export-candidate",
      "--manifest", path.join(directory, "manifest.json"), "--selection", path.join(directory, "selection.json"),
      "--run", "c1", "--out", path.join(directory, "z.json"), "--binding-out", path.join(directory, "zb.json")],
    { cwd: clone, encoding: "utf8", env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /the manifest's recipe is not the measured recipe/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
