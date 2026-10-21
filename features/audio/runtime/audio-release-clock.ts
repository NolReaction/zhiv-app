export const AUDIO_VISIBILITY_RELEASE_SECONDS = .18;
export const AUDIO_VISIBILITY_CLEANUP_MS = 220;

/** One silent native source owns the audio deadline, independently of throttled
 * JavaScript clocks. The single timer is a fallback, never a polling loop.
 */
export function createAudioReleaseClock(context: AudioContext, output: AudioNode, endsAt: number, complete: () => void) {
  let source: AudioScheduledSourceNode | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  function cancel() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* A completed native source only needs disconnection. */ }
      source.disconnect(); source = null;
    }
  }
  function finish() {
    if (disposed) return false;
    cancel(); complete(); return true;
  }
  function check() {
    if (context.state === "running" && context.currentTime < endsAt) return false;
    return finish();
  }
  try {
    if (typeof context.createConstantSource === "function") {
      const clock = context.createConstantSource(); clock.offset.value = 0; source = clock;
    } else {
      // A null AudioBuffer ends immediately. A tiny zero-initialized loop is the
      // scheduled-source equivalent for older implementations without constants.
      const clock = context.createBufferSource();
      clock.buffer = context.createBuffer(1, 128, context.sampleRate); clock.loop = true; source = clock;
    }
    // Native ended confirms the scheduled stop even when a browser rounds its
    // public currentTime. Only the JavaScript fallback needs to sample it.
    source.onended = finish;
    source.connect(output); source.start(); source.stop(endsAt);
  } catch {
    if (source) { source.onended = null; try { source.stop(); } catch { /* Not yet started. */ } source.disconnect(); source = null; }
  }
  timer = setTimeout(check, AUDIO_VISIBILITY_CLEANUP_MS);
  return { check, cancel };
}
