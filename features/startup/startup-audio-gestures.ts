type StartupGestureEntry = { playFromGesture: () => void };

/** A normal tap on the visible splash can authorize its sound. There is no
 * extra button and no listener that replays branding after entering the app. */
export function attachStartupAudioGestures(entry: StartupGestureEntry, page: Document) {
  const gesture = (event: Event) => {
    if (!event.isTrusted || page.hidden) return;
    const splash = page.querySelector("[data-startup-splash][data-logo-ready='true']:not([data-phase='leaving'])");
    if (!splash) return;
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (key.repeat || key.altKey || key.ctrlKey || key.metaKey || !["Enter", " "].includes(key.key)) return;
    } else if (!(event.target instanceof Node) || !splash.contains(event.target)) return;
    entry.playFromGesture();
  };
  // Touch/pen activation occurs on release, not pointerdown. Click also covers
  // mouse and assistive activation; the entry consumes the signature only once.
  const events = ["pointerup", "touchend", "click", "keydown"] as const;
  for (const type of events) page.addEventListener(type, gesture, { capture: true, passive: true });
  return () => { for (const type of events) page.removeEventListener(type, gesture, true); };
}
