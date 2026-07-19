import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

import { PROFILE_STORAGE_KEY } from "../src/client/storageKeys.js";

const SERVER_READY_RE = /Dev server listening at (http:\/\/[^\s]+)/;

async function startDevServer() {
  const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const failTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`dev server did not start\n${output}`));
      }
    }, 10_000);

    function handleData(chunk) {
      output += chunk.toString();
      const match = output.match(SERVER_READY_RE);
      if (!settled && match) {
        settled = true;
        clearTimeout(failTimer);
        resolve({ child, url: match[1] });
      }
    }

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(new Error(`dev server exited before ready with code ${code}\n${output}`));
      }
    });
  });
}

async function stopDevServer(server) {
  if (!server?.child || server.child.killed) {
    return;
  }
  server.child.kill("SIGTERM");
  await delay(100);
}

async function readGameText(page) {
  return JSON.parse(await page.evaluate(() => window.render_game_to_text()));
}

async function readStoredJson(page, key) {
  return page.evaluate((storageKey) => {
    const payload = window.localStorage.getItem(storageKey);
    return payload ? JSON.parse(payload) : null;
  }, key);
}

async function runSmoke() {
  console.log("browser smoke: starting dev server");
  const server = await startDevServer();
  console.log(`browser smoke: dev server ready at ${server.url}`);
  let browser;

  try {
    console.log("browser smoke: launching chromium");
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    console.log("browser smoke: chromium launched");
  } catch (error) {
    await stopDevServer(server);
    throw new Error(`Playwright Chromium is required for browser smoke: ${error.message}`);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  try {
    console.log("browser smoke: navigating");
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.locator("#start-btn").waitFor({ state: "visible" });
    console.log("browser smoke: page ready");

    assert.equal(await page.locator("#bot-tier-select").count(), 0);
    assert.equal(await page.locator("#train-btn").count(), 0);
    assert.equal(await page.locator("#start-btn").count(), 1);
    assert.equal(await page.locator("#reset-btn").count(), 1);

    const initial = await readGameText(page);
    console.log("browser smoke: initial state read");
    assert.equal(initial.bot_tier, "edger");
    assert.equal(initial.bot_source, "oracle");
    assert.match(initial.profile_summary_text, /Opponent: Edger/);
    assert.equal(initial.profile.total_matches, 0);

    await page.locator("#start-btn").click();

    const afterBattle = await readGameText(page);
    console.log("browser smoke: started state read");
    assert.equal(afterBattle.bot_tier, "edger");
    assert.equal(afterBattle.mode, "playing");

    await page.evaluate(() => window.__edgeRoyaleSmokeFinishMatch());
    console.log("browser smoke: forced terminal state");

    const finalState = await readGameText(page);
    assert.equal(finalState.mode, "game_over");
    assert.equal(finalState.profile.total_matches, 1);
    assert.equal(
      finalState.profile.wins + finalState.profile.losses + finalState.profile.draws,
      1,
    );

    const storedProfile = await readStoredJson(page, PROFILE_STORAGE_KEY);
    assert.equal(storedProfile.total_matches, 1);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-replay-btn").click();
    const download = await downloadPromise;
    const replayPayload = JSON.parse(
      await (await download.createReadStream()).toArray().then((chunks) =>
        Buffer.concat(chunks).toString("utf8")),
    );
    assert.equal(replayPayload.schema_version, "edger_manual_replay_export_v1");
    assert.equal(replayPayload.replay.seed, replayPayload.seed);
    assert.ok(Array.isArray(replayPayload.replay.actions));
    assert.ok(Array.isArray(replayPayload.replay.events));
    assert.equal(replayPayload.result.tick, finalState.match_result.tick);
    assert.equal(typeof replayPayload.final_state_hash, "string");
    assert.ok(replayPayload.final_state_hash.length > 0);
    const forbiddenIdentityKeys = new Set([
      "email",
      "identity",
      "name",
      "player_id",
      "profile",
      "user_id",
      "username",
    ]);
    const inspectIdentity = (value) => {
      if (!value || typeof value !== "object") {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        assert.equal(
          forbiddenIdentityKeys.has(key.toLowerCase()),
          false,
          `replay download contains forbidden identity field ${key}`,
        );
        inspectIdentity(child);
      }
    };
    inspectIdentity(replayPayload);
    assert.equal(pageErrors.length, 0, pageErrors.map((error) => error.stack || error.message).join("\n"));

    console.log("browser smoke: Edger-only runtime and identity-free replay export OK");
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopDevServer(server);
  }
}

runSmoke().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
