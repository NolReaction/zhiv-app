export type GuideBounds = { left: number; top: number; width: number; height: number };
type GuideStyle = Pick<CSSStyleDeclaration, "overflowX" | "overflowY" | "visibility" | "display" | "opacity">;
const clips = (overflow: string) => /^(auto|scroll|hidden|clip)$/.test(overflow);

/** Visible target bounds for placing the coach without covering its control.
 * The ring itself is painted on the target and clipped natively by the browser. */
export function measureGuideSpotlight(
  target: HTMLElement | null,
  viewport: GuideBounds,
  getStyle: (element: HTMLElement) => GuideStyle = element => window.getComputedStyle(element),
): GuideBounds | null {
  if (!target || target.closest?.('[hidden], [inert], [aria-hidden="true"]')) return null;
  const rect = target.getBoundingClientRect(), style = getStyle(target);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none" || style.opacity === "0") return null;
  let left = viewport.left + 3, top = viewport.top + 3;
  let right = viewport.left + viewport.width - 3, bottom = viewport.top + viewport.height - 3;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getStyle(parent);
    if (parentStyle.visibility === "hidden" || parentStyle.visibility === "collapse" || parentStyle.display === "none" || parentStyle.opacity === "0") return null;
    const clipX = clips(parentStyle.overflowX), clipY = clips(parentStyle.overflowY);
    if (!clipX && !clipY) continue;
    const parentRect = parent.getBoundingClientRect();
    // clientLeft/clientTop exclude borders; clientWidth/clientHeight also
    // exclude scrollbars. Keep those local dimensions in viewport coordinates.
    const scaleX = parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight > 0 ? parentRect.height / parent.offsetHeight : 1;
    const clientLeft = parentRect.left + parent.clientLeft * scaleX;
    const clientTop = parentRect.top + parent.clientTop * scaleY;
    if (clipX) {
      left = Math.max(left, clientLeft);
      right = Math.min(right, clientLeft + parent.clientWidth * scaleX);
    }
    if (clipY) {
      top = Math.max(top, clientTop);
      bottom = Math.min(bottom, clientTop + parent.clientHeight * scaleY);
    }
  }
  // A hidden control is not an obstacle for the coach, even if its decorative
  // margin would extend into the visible part of the panel.
  if (Math.min(rect.right, right) <= Math.max(rect.left, left)
    || Math.min(rect.bottom, bottom) <= Math.max(rect.top, top)) return null;
  const ringLeft = Math.max(left, rect.left - 5), ringTop = Math.max(top, rect.top - 5);
  const ringRight = Math.min(right, rect.right + 5), ringBottom = Math.min(bottom, rect.bottom + 5);
  return {
    left: ringLeft, top: ringTop, width: ringRight - ringLeft, height: ringBottom - ringTop,
  };
}
