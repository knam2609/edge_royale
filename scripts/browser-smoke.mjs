import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

import { buildBrowserSmokeFixtures } from "./browser-smoke-fixtures.mjs";

const DEV_SERVER_READY_TIMEOUT_MS = 15_000;
const DEV_SERVER_READY_PATTERN = /Dev server listening at (http:\/\/\S+)/;
const PLAYWRIGHT_INSTALL_HINT =
  "Playwright Chromium browser missing. Run `npx playwright install chromium` before `npm run smoke:browser`. Command will not install browsers automatically.";

function getChromiumExecutablePath() {
  try {
    const executablePath = chromium.executablePath();
    if (!executablePath || !existsSync(executablePath)) {
      throw new Error(PLAYWRIGHT_INSTALL_HINT);
    }
    return executablePath;
  } catch {
    throw new Error(PLAYWRIGHT_INSTALL_HINT);
  }
}

function startDevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let settled = false;

    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    const fail = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          `${message}\nstdout:\n${stdout.join("") || "(empty)"}\nstderr:\n${stderr.join("") || "(empty)"}`,
        ),
      );
    };

    const onStdout = (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      const match = text.match(DEV_SERVER_READY_PATTERN);
      if (!match || settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        child,
        url: match[1],
        stdout,
        stderr,
      });
    };

    const onStderr = (chunk) => {
      stderr.push(chunk.toString());
    };

    const onExit = (code, signal) => {
      fail(`Dev server exited before ready (code ${code}, signal ${signal ?? "none"}).`);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);

    setTimeout(() => {
      fail(`Timed out waiting ${DEV_SERVER_READY_TIMEOUT_MS}ms for dev server.`);
    }, DEV_SERVER_READY_TIMEOUT_MS).unref();
  });
}

async function stopDevServer(server) {
  if (!server?.child || server.child.killed) {
    return;
  }
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    delay(2_000),
  ]);
  if (!server.child.killed) {
    server.child.kill("SIGKILL");
  }
}

async function readGameState(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()));
}

async function openScenarioPage(browser, url, storageState) {
  const context = await browser.newContext();
  await context.addInitScript(({ storageState: nextState }) => {
    window.localStorage.clear();
    for (const [key, value] of Object.entries(nextState)) {
      if (value === null || value === undefined) {
        window.localStorage.removeItem(key);
        continue;
      }
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  }, { storageState });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(`console error: ${message.text()}`);
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof window.render_game_to_text === "function" &&
      typeof document.getElementById("profile-summary")?.textContent === "string" &&
      document.getElementById("profile-summary").textContent.length > 0,
  );

  return { context, page, pageErrors };
}

function assertNoPageErrors(label, errors) {
  assert.equal(errors.length, 0, `${label} emitted browser errors:\n${errors.join("\n")}`);
}

async function readStoredJson(page, key) {
  return page.evaluate((storageKey) => {
    const payload = window.localStorage.getItem(storageKey);
    return payload ? JSON.parse(payload) : null;
  }, key);
}

async function runUnderThresholdScenario(browser, url, fixtures) {
  const { page, context, pageErrors } = await openScenarioPage(browser, url, fixtures.underThreshold.storageState);
  try {
    const initialState = await readGameState(page);
    assert.match(initialState.profile_summary_text, /Training samples: 119\b/);

    await page.locator("#train-btn").click();
    const state = await readGameState(page);
    assert.equal(state.status_message, fixtures.underThreshold.expectedStatusMessage);

    const storedTraining = await readStoredJson(page, fixtures.keys.training);
    const storedModel = await readStoredJson(page, fixtures.keys.selfModel);
    assert.equal(storedTraining.version, 2);
    assert.equal(storedModel, null);
    assertNoPageErrors("under-threshold smoke", pageErrors);
  } finally {
    await context.close();
  }
}

async function runAcceptedScenario(browser, url, fixtures) {
  const { page, context, pageErrors } = await openScenarioPage(browser, url, fixtures.rlAccepted.storageState);
  try {
    const expectedSampleCount = fixtures.rlAccepted.trainingStore.samples.length;
    await page.locator("#train-btn").click();
    await page.waitForFunction(
      () => JSON.parse(window.render_game_to_text()).status_message.endsWith("RL accepted."),
    );

    const state = await readGameState(page);
    const storedTraining = await readStoredJson(page, fixtures.keys.training);
    const storedModel = await readStoredJson(page, fixtures.keys.selfModel);

    assert.match(state.profile_summary_text, new RegExp(`Training samples: ${expectedSampleCount}\\b`));
    assert.match(
      state.status_message,
      new RegExp(`Self-play model trained \\(${expectedSampleCount} samples\\)\\. RL accepted\\.$`),
    );
    assert.equal(storedTraining.version, 2);
    assert.equal(storedModel.ready, true);
    assert.equal(storedModel.training_config.rl_gate.accepted, true);
    assert.equal(storedModel.training_config.rl_gate.reason, "accepted");
    assertNoPageErrors("accepted smoke", pageErrors);
  } finally {
    await context.close();
  }
}

async function runFallbackScenario(browser, url, fixtures) {
  const { page, context, pageErrors } = await openScenarioPage(browser, url, fixtures.rlFallback.storageState);
  try {
    const expectedAccepted = fixtures.rlFallback.result.accepted;
    const expectedSuffix = expectedAccepted ? "RL accepted." : "RL kept imitation baseline.";
    const expectedSampleCount = fixtures.rlFallback.trainingStore.samples.length;
    await page.locator("#train-btn").click();
    await page.waitForFunction(
      (suffix) => JSON.parse(window.render_game_to_text()).status_message.endsWith(suffix),
      expectedSuffix,
    );

    const state = await readGameState(page);
    const storedTraining = await readStoredJson(page, fixtures.keys.training);
    const storedModel = await readStoredJson(page, fixtures.keys.selfModel);

    const expectedPattern = expectedAccepted
      ? new RegExp(`Self-play model trained \\(${expectedSampleCount} samples\\)\\. RL accepted\\.$`)
      : new RegExp(`Self-play model trained \\(${expectedSampleCount} samples\\)\\. RL kept imitation baseline\\.$`);
    assert.match(state.status_message, expectedPattern);
    assert.equal(storedTraining.version, 2);
    assert.equal(storedModel.ready, true);
    assert.equal(storedModel.training_config.rl_gate.accepted, expectedAccepted);
    assert.equal(storedModel.training_config.rl_gate.reason, fixtures.rlFallback.result.reason);
    assertNoPageErrors("fallback smoke", pageErrors);
  } finally {
    await context.close();
  }
}

async function runSelfRuntimeScenario(browser, url, fixtures) {
  const { page, context, pageErrors } = await openScenarioPage(browser, url, fixtures.selfRuntime.storageState);
  try {
    await page.locator("#bot-tier-select").selectOption("self");
    let state = await readGameState(page);
    assert.equal(state.bot_tier, "self");
    assert.equal(state.bot_source, "model");
    assert.equal(state.training.model_ready, true);
    assert.match(state.profile_summary_text, /Self model: ready/);

    await page.locator("#start-btn").click();
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).mode === "playing");

    const beforeTick = (await readGameState(page)).tick;
    await page.evaluate(() => {
      window.advanceTime(2000);
    });

    state = await readGameState(page);
    assert.equal(state.bot_tier, "self");
    assert.equal(state.bot_source, "model");
    assert.ok(state.tick > beforeTick);
    assert.ok(state.entities.length > 0);
    assertNoPageErrors("self-runtime smoke", pageErrors);
  } finally {
    await context.close();
  }
}

async function main() {
  getChromiumExecutablePath();
  const fixtures = buildBrowserSmokeFixtures();
  const server = await startDevServer();
  const browser = await chromium.launch({ headless: true });

  try {
    await runUnderThresholdScenario(browser, server.url, fixtures);
    console.log("browser smoke: under-threshold self-training OK");

    await runAcceptedScenario(browser, server.url, fixtures);
    console.log("browser smoke: RL accepted path OK");

    await runFallbackScenario(browser, server.url, fixtures);
    console.log("browser smoke: RL fallback path OK");

    await runSelfRuntimeScenario(browser, server.url, fixtures);
    console.log("browser smoke: self runtime model path OK");
  } finally {
    await browser.close();
    await stopDevServer(server);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
