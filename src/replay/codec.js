import { normalizeReplayPayload, REPLAY_SCHEMA_VERSION } from "./schema.js";

export function saveReplay({ seed, actions, events }) {
  return JSON.stringify(
    {
      version: REPLAY_SCHEMA_VERSION,
      seed,
      actions,
      events,
    },
    null,
    2,
  );
}

export function loadReplay(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  return normalizeReplayPayload(payload);
}
