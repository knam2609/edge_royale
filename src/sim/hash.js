export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${pairs.join(",")}}`;
}

function updateFnv(hash, content) {
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function writeStableHash(value, writeToken, { objectValue = false } = {}) {
  if (value === null || typeof value !== "object") {
    const token = JSON.stringify(value);
    if (token === undefined) {
      if (objectValue) {
        writeToken("undefined");
      }
      return;
    }
    writeToken(token);
    return;
  }

  if (Array.isArray(value)) {
    writeToken("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        writeToken(",");
      }
      writeStableHash(value[index], writeToken);
    }
    writeToken("]");
    return;
  }

  writeToken("{");
  const keys = Object.keys(value).sort();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index > 0) {
      writeToken(",");
    }
    writeToken(JSON.stringify(key));
    writeToken(":");
    writeStableHash(value[key], writeToken, { objectValue: true });
  }
  writeToken("}");
}

export function hashState(state) {
  let hash = 0x811c9dc5;
  writeStableHash(state, (token) => {
    hash = updateFnv(hash, token);
  });
  return hash.toString(16).padStart(8, "0");
}
