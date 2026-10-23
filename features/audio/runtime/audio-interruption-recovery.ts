const RETRY_DELAYS_MS = [250, 1000, 2500, 5000];

/** A phone call may leave an authorized, visible context suspended. Retry a
 * bounded number of times; a new foreground notification starts a new window.
 * This never acquires first-play permission or overrides the saved mixer. */
export function createAudioInterruptionRecovery(options: {
  allowed: () => boolean;
  running: () => boolean;
  resume: () => Promise<boolean>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0, generation = 0, pending = false;
  const cancel = () => {
    generation++; attempts = 0; pending = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    if (timer !== null || pending || attempts >= RETRY_DELAYS_MS.length || !options.allowed() || options.running()) return;
    const token = generation;
    timer = setTimeout(() => {
      timer = null;
      if (token !== generation || !options.allowed() || options.running()) return;
      attempts++; pending = true;
      void options.resume().catch(() => false).then(() => {
        if (token !== generation) return;
        pending = false;
        if (options.running()) cancel(); else schedule();
      });
    }, RETRY_DELAYS_MS[attempts]);
  };
  return { schedule, cancel, restart: () => { cancel(); schedule(); } };
}
