export const TOUCH_CLICK_SUPPRESSION_MS = 900;

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
