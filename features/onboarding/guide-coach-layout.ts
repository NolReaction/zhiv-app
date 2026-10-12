import type { GuideBounds } from "./guide-spotlight";

/** Free map lessons sit between the real HUD rows, including device safe areas. */
export function worldCoachLayout(viewport: GuideBounds, bubbleHeight: number, options: {
  topHud?: GuideBounds;
  bottomHud?: GuideBounds;
  sideInset?: number;
  highlight?: GuideBounds | null;
}) {
  const sideInset = Math.max(12, options.sideInset ?? 0);
  const width = Math.max(0, Math.min(384, viewport.width - sideInset * 2));
  const left = viewport.left + (viewport.width - width) / 2;
  const top = Math.max(viewport.top + 12, options.topHud ? options.topHud.top + options.topHud.height + 12 : viewport.top + 12);
  const lowerEdge = Math.min(viewport.top + viewport.height - 88, options.bottomHud ? options.bottomHud.top - 20 : Infinity);
  const maxHeight = Math.max(0, Math.min(260, viewport.height * .45, lowerEdge - top));
  const height = Math.min(bubbleHeight, maxHeight), bottom = Math.max(top, lowerEdge - height);
  const clamp = (value: number) => Math.max(top, Math.min(bottom, value));
  const highlight = options.highlight;
  const candidates = [bottom, top];
  if (highlight) candidates.push(clamp(highlight.top - height - 14), clamp(highlight.top + highlight.height + 14));
  const overlap = (candidate: number) => highlight
    ? Math.max(0, Math.min(left + width, highlight.left + highlight.width) - Math.max(left, highlight.left))
      * Math.max(0, Math.min(candidate + height, highlight.top + highlight.height) - Math.max(candidate, highlight.top))
    : 0;
  candidates.sort((a, b) => (overlap(a) - overlap(b)) * 100 + Math.abs(a - bottom) - Math.abs(b - bottom));
  return { left, top: candidates[0], width, maxHeight };
}
