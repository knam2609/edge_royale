export const REPLAY_SCHEMA_VERSION = "1.1";

function toVersionTuple(version) {
  const [major, minor] = String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor };
}

function isOlderThanV11(version) {
  const tuple = toVersionTuple(version);
  return tuple.major < 1 || (tuple.major === 1 && tuple.minor < 1);
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return event;
  }

  if (event.type === "spell_impact") {
    return {
      ...event,
      knockback_events: Array.isArray(event.knockback_events) ? event.knockback_events : [],
    };
  }

  return event;
}

export function normalizeReplayPayload(payload) {
  const version = payload?.version ?? "1.0";
  const base = {
    version,
    seed: payload?.seed ?? 1,
    actions: Array.isArray(payload?.actions) ? payload.actions : [],
    events: Array.isArray(payload?.events) ? payload.events.map(normalizeEvent) : [],
  };

  if (isOlderThanV11(version)) {
    base.events = base.events.map((event) => {
      if (event?.type !== "spell_impact") {
        return event;
      }
      return {
        ...event,
        knockback_events: Array.isArray(event.knockback_events) ? event.knockback_events : [],
      };
    });
  }

  return base;
}
