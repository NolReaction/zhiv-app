export const TOUCH_CLICK_SUPPRESSION_MS = 900;
export const GAME_TAP_SLOP_PX = 16;

export function isWithinGameTapArea(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  const radius = Math.min(bounds.width, bounds.height) / 2 + GAME_TAP_SLOP_PX;
  const offsetX = clientX - (bounds.left + bounds.width / 2);
  const offsetY = clientY - (bounds.top + bounds.height / 2);
  return offsetX * offsetX + offsetY * offsetY <= radius * radius;
}

export function shouldCountGamePointer(pointerType: string): boolean {
  return pointerType === "touch";
}

export function shouldCountGameClick(
  detail: number,
  nowMs: number,
  lastTouchAtMs: number,
): boolean {
  if (detail === 0) return true;
  return nowMs - lastTouchAtMs >= TOUCH_CLICK_SUPPRESSION_MS;
}
