export const REFERENCE_SCREEN = Object.freeze({
  width: 750,
  height: 1334,
});

const REFERENCE_RECTS = Object.freeze({
  topBanner: Object.freeze({ x: 8, y: 8, width: 476, height: 82 }),
  timerBox: Object.freeze({ x: 618, y: 6, width: 126, height: 82 }),
  arenaViewport: Object.freeze({ x: 0, y: 86, width: 750, height: 980 }),
  crownRail: Object.freeze({ x: 690, y: 384, width: 60, height: 384 }),
  bottomTray: Object.freeze({ x: 126, y: 1088, width: 624, height: 246 }),
  closeButton: Object.freeze({ x: 32, y: 1100, width: 78, height: 78 }),
  nextCardRect: Object.freeze({ x: 36, y: 1220, width: 70, height: 92 }),
  elixirBar: Object.freeze({ x: 126, y: 1284, width: 598, height: 34 }),
  statusRect: Object.freeze({ x: 140, y: 1248, width: 560, height: 20 }),
  handSlots: Object.freeze([
    Object.freeze({ x: 143, y: 1114, width: 126, height: 158 }),
    Object.freeze({ x: 288, y: 1114, width: 126, height: 158 }),
    Object.freeze({ x: 433, y: 1114, width: 126, height: 158 }),
    Object.freeze({ x: 578, y: 1114, width: 126, height: 158 }),
  ]),
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scaleRect(frame, rect) {
  return {
    x: frame.x + rect.x * frame.scale,
    y: frame.y + rect.y * frame.scale,
    width: rect.width * frame.scale,
    height: rect.height * frame.scale,
  };
}

export function computePortraitBattleLayout(width, height) {
  const scale = Math.max(0.0001, Math.min(width / REFERENCE_SCREEN.width, height / REFERENCE_SCREEN.height));
  const frameWidth = REFERENCE_SCREEN.width * scale;
  const frameHeight = REFERENCE_SCREEN.height * scale;
  const frame = {
    x: (width - frameWidth) * 0.5,
    y: (height - frameHeight) * 0.5,
    width: frameWidth,
    height: frameHeight,
    scale,
  };

  return {
    scale,
    frame,
    topBanner: scaleRect(frame, REFERENCE_RECTS.topBanner),
    timerBox: scaleRect(frame, REFERENCE_RECTS.timerBox),
    arenaViewport: scaleRect(frame, REFERENCE_RECTS.arenaViewport),
    crownRail: scaleRect(frame, REFERENCE_RECTS.crownRail),
    bottomTray: scaleRect(frame, REFERENCE_RECTS.bottomTray),
    closeButton: scaleRect(frame, REFERENCE_RECTS.closeButton),
    nextCardRect: scaleRect(frame, REFERENCE_RECTS.nextCardRect),
    elixirBar: scaleRect(frame, REFERENCE_RECTS.elixirBar),
    statusRect: scaleRect(frame, REFERENCE_RECTS.statusRect),
    handSlots: REFERENCE_RECTS.handSlots.map((slot, index) => ({
      ...scaleRect(frame, slot),
      index,
    })),
  };
}

export function pointInRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function findHandSlotHit(layout, point) {
  for (const slot of layout.handSlots) {
    if (pointInRect(point, slot)) {
      return slot.index;
    }
  }
  return null;
}

export function worldToViewport(position, bounds, viewport) {
  return {
    x: viewport.x + ((position.x - bounds.minX) / (bounds.maxX - bounds.minX)) * viewport.width,
    y: viewport.y + ((position.y - bounds.minY) / (bounds.maxY - bounds.minY)) * viewport.height,
  };
}

export function viewportToWorld(position, bounds, viewport) {
  const normalizedX = clamp((position.x - viewport.x) / viewport.width, 0, 1);
  const normalizedY = clamp((position.y - viewport.y) / viewport.height, 0, 1);
  return {
    x: bounds.minX + normalizedX * (bounds.maxX - bounds.minX),
    y: bounds.minY + normalizedY * (bounds.maxY - bounds.minY),
  };
}
