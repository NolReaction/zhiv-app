// A modal focus trap parks focus on its container when the previous water control
// is removed. Hand it to the next cast phase without taking it from a HUD control.
export function focusBoatWaterIfIdle(water: HTMLButtonElement | null) {
  if (!water || document.hidden) return;
  const focused = document.activeElement;
  if (!focused || focused === document.body || focused === water.closest?.("[data-boat-dialog]"))
    water.focus({ preventScroll: true });
}
