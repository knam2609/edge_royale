import test from "node:test";
import assert from "node:assert/strict";

import { bootstrapCommands } from "../scripts/edger-campaign-remote.mjs";

test("remote bootstrap installs Playwright Chromium for Amazon Linux 2023", () => {
  const commands = bootstrapCommands({
    campaignUri: "s3://example/campaign",
    corpusStore: "s3://example/corpus",
    gitSha: "f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33",
  });
  const install = commands.find((command) => command.startsWith("dnf install -y"));

  assert.ok(install);
  for (const packageName of [
    "alsa-lib",
    "at-spi2-atk",
    "cairo",
    "cups-libs",
    "libdrm",
    "mesa-libgbm",
    "nss",
    "pango",
    "libX11",
    "libXcomposite",
    "libXdamage",
    "libXrandr",
    "libxkbcommon",
    "fontconfig",
    "liberation-fonts",
    "google-noto-emoji-color-fonts",
  ]) {
    assert.match(install, new RegExp(`(?:^| )${packageName}(?: |$)`));
  }
  assert.ok(commands.includes("npx playwright install chromium"));
  assert.ok(!commands.some((command) => command.includes("--with-deps")));
  assert.ok(commands.includes("python3.11 -m venv /opt/edge_royale_venv"));
  assert.ok(commands.includes("source /opt/edge_royale_venv/bin/activate"));
  assert.ok(!commands.some((command) => command.includes("/opt/edge_royale/.venv")));
});
