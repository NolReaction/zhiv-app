/** A fixed coach can mount or move after the scene, without resizing the canvas. */
export function observeMapGuideInset(world: HTMLElement, canvas: HTMLCanvasElement, onChange: (bottom: number) => void) {
  let coach: HTMLElement | null = null, frame = 0, disposed = false, previous = NaN;
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const position = new MutationObserver(schedule);
  const bindCoach = () => {
    const next = world.querySelector<HTMLElement>('[data-guide-coach="world"]');
    if (next === coach) return false;
    if (coach) resize.unobserve(coach);
    position.disconnect(); coach = next;
    if (coach) {
      resize.observe(coach);
      position.observe(coach, { attributes: true, attributeFilter: ["style", "class", "hidden", "data-inline"] });
    }
    return true;
  };
  function measure() {
    frame = 0;
    if (disposed) return;
    bindCoach();
    const viewport = canvas.getBoundingClientRect(), card = coach?.getBoundingClientRect();
    const bottom = card && card.height > 0 && viewport.height > 0
      ? Math.max(0, (viewport.bottom - card.top) * canvas.clientHeight / viewport.height + 12) : 0;
    if (bottom !== previous) { previous = bottom; onChange(bottom); }
  }
  // Watch mounting separately: map anchors update their own styles every pan.
  // Those unrelated mutations must not schedule another layout measurement.
  const children = new MutationObserver(() => { if (!disposed && bindCoach()) schedule(); });
  children.observe(world, { childList: true, subtree: true });
  resize.observe(canvas); bindCoach(); schedule();
  return () => {
    disposed = true; cancelAnimationFrame(frame);
    children.disconnect(); position.disconnect(); resize.disconnect();
  };
}
