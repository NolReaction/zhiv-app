export type GuideBounds = { left: number; top: number; width: number; height: number };
export type GuideSpotlight = GuideBounds & { borderRadius: string; clipPath: string };
type GuideStyle = Pick<CSSStyleDeclaration, "overflowX" | "overflowY" | "borderRadius" | "visibility">;
const clips = (overflow: string) => /^(auto|scroll|hidden|clip)$/.test(overflow);

/** A fixed outline does not inherit the target's scroll clipping. Intersect the
 * actual client boxes, independently on each overflow axis, before drawing it. */
export function measureGuideSpotlight(
  target: HTMLElement | null,
  viewport: GuideBounds,
  getStyle: (element: HTMLElement) => GuideStyle = element => window.getComputedStyle(element),
): GuideSpotlight | null {
  if (!target) return null;
  const rect = target.getBoundingClientRect(), style = getStyle(target);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.visibility === "collapse") return null;
  let left = viewport.left + 3, top = viewport.top + 3;
  let right = viewport.left + viewport.width - 3, bottom = viewport.top + viewport.height - 3;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getStyle(parent);
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
  // Test the button itself before adding the decorative margin: a hidden
  // button must not leave a 5px ghost outline at the edge of its scroll panel.
  if (Math.min(rect.right, right) <= Math.max(rect.left, left)
    || Math.min(rect.bottom, bottom) <= Math.max(rect.top, top)) return null;
  const ringLeft = Math.max(left, rect.left - 5), ringTop = Math.max(top, rect.top - 5);
  const ringRight = Math.min(right, rect.right + 5), ringBottom = Math.min(bottom, rect.bottom + 5);
  return {
    left: ringLeft, top: ringTop, width: ringRight - ringLeft, height: ringBottom - ringTop,
    borderRadius: style.borderRadius,
    // Clip the CSS glow as well as the border, allowing its normal spread only
    // where the visible ancestor/viewport area has room for it.
    clipPath: `inset(${top - ringTop}px ${ringRight - right}px ${ringBottom - bottom}px ${left - ringLeft}px)`,
  };
}
