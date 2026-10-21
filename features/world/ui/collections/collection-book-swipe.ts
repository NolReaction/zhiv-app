type Point = { pointerId: number; pointerType: string; isPrimary: boolean; clientX: number; clientY: number; timeStamp: number };
type Context = { key: string; page: number; pages: number };

/** One short, horizontal contact may turn one page. Native scroll/pinch owns cancellation. */
export function createCollectionBookSwipe() {
  const pointers = new Set<number>();
  let active: { point: Point; context: Context } | null = null;
  const sameContext = (context: Context) => active?.context.key === context.key
    && active.context.page === context.page && active.context.pages === context.pages;
  return {
    down(point: Point, context: Context) {
      if (point.pointerType !== "touch" && point.pointerType !== "pen") return;
      pointers.add(point.pointerId);
      active = pointers.size === 1 && point.isPrimary ? { point: { ...point }, context: { ...context } } : null;
    },
    move(point: Point, context: Context) {
      if (!active || active.point.pointerId !== point.pointerId) return;
      const dx = point.clientX - active.point.clientX, dy = point.clientY - active.point.clientY;
      if (!sameContext(context) || Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) active = null;
    },
    up(point: Point, context: Context): number | null {
      pointers.delete(point.pointerId);
      if (!active || active.point.pointerId !== point.pointerId) return null;
      const initial = active.point, current = sameContext(context);
      active = null;
      const dx = point.clientX - initial.clientX, dy = point.clientY - initial.clientY, elapsed = point.timeStamp - initial.timeStamp;
      if (!current || pointers.size > 0 || !point.isPrimary || elapsed < 0 || elapsed > 650
        || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.6) return null;
      const next = context.page + (dx < 0 ? 1 : -1);
      return next >= 0 && next < context.pages ? next : null;
    },
    cancel(pointerId?: number) {
      active = null;
      if (pointerId === undefined) pointers.clear();
      else pointers.delete(pointerId);
    },
  };
}
