import { execFileSync, spawn, spawnSync } from "node:child_process";

function isTranslatedMacProcess() {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    return execFileSync(
      "/usr/sbin/sysctl",
      ["-in", "sysctl.proc_translated"],
      { encoding: "utf8" },
    ).trim() === "1";
  } catch {
    return false;
  }
}

export function getNativePythonCommand(python = process.env.PYTHON ?? "python3") {
  if (isTranslatedMacProcess()) {
    return {
      command: "/usr/bin/arch",
      prefixArgs: ["-arm64", python],
    };
  }
  return { command: python, prefixArgs: [] };
}

export function spawnNativePython(args, options = {}) {
  const { python, ...spawnOptions } = options;
  const launch = getNativePythonCommand(python);
  return spawnSync(
    launch.command,
    [...launch.prefixArgs, ...args],
    spawnOptions,
  );
}

export function spawnNativePythonAsync(args, options = {}) {
  const { python, ...spawnOptions } = options;
  const launch = getNativePythonCommand(python);
  return spawn(
    launch.command,
    [...launch.prefixArgs, ...args],
    spawnOptions,
  );
}
