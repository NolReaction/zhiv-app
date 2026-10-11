/** Radix handles Escape during document capture, before the coach's own handler.
 * Activate the focused coach's real pause control so each flow keeps its state. */
export function pauseFocusedGuide(activeElement: Element | null = document.activeElement): boolean {
  const pause = activeElement?.closest("[data-guide-coach]")?.querySelector<HTMLButtonElement>("button[data-guide-pause]");
  if (!pause || pause.disabled) return false;
  pause.click();
  return true;
}
