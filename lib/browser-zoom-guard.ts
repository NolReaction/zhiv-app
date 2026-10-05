/** Block browser magnification, including gestures in body-mounted portals.
 * Pointer events still reach the map's own pan/zoom controller. One-finger
 * scrolling and normal taps are never canceled outside a pinch sequence. */
export function installBrowserZoomGuard(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
): () => void {
  const options: AddEventListenerOptions = { capture: true, passive: false };
  let pinching = false;
  const prevent = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const touchStart = (event: TouchEvent) => {
    pinching = event.touches.length > 1;
    if (pinching) prevent(event);
  };
  const touchMove = (event: TouchEvent) => {
    pinching ||= event.touches.length > 1;
    if (pinching) prevent(event);
  };
  const touchEnd = (event: TouchEvent) => {
    if (pinching) prevent(event);
    if (!event.touches.length) pinching = false;
  };
  // Safari's GestureEvents are a separate native zoom path. Viewport scale
  // limits alone do not prevent it. No propagation is stopped here.
  target.addEventListener("gesturestart", prevent, options);
  target.addEventListener("gesturechange", prevent, options);
  target.addEventListener("gestureend", prevent, options);
  target.addEventListener("touchstart", touchStart, options);
  target.addEventListener("touchmove", touchMove, options);
  target.addEventListener("touchend", touchEnd, options);
  target.addEventListener("touchcancel", touchEnd, options);
  return () => {
    target.removeEventListener("gesturestart", prevent, options);
    target.removeEventListener("gesturechange", prevent, options);
    target.removeEventListener("gestureend", prevent, options);
    target.removeEventListener("touchstart", touchStart, options);
    target.removeEventListener("touchmove", touchMove, options);
    target.removeEventListener("touchend", touchEnd, options);
    target.removeEventListener("touchcancel", touchEnd, options);
  };
}
