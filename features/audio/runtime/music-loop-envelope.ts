const FADE_SECONDS = 2.5;
const CHECK_MS = 200;
const CLOCK_TOLERANCE_SECONDS = .12;

type Point = { time: number; value: number };
type Timeline = { time: number; position: number; duration: number; rate: number; end: number };

/** Soften the native media loop without decoding the song or allocating another deck. */
export function createMusicLoopEnvelope(context: AudioContext, gain: AudioParam, media: HTMLAudioElement, ownsPlayback: () => boolean) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeline: Timeline | null = null;
  let points: Point[] = [{ time: context.currentTime, value: gain.value }];

  function valueAt(time: number) {
    let previous = points[0];
    for (const point of points.slice(1)) {
      if (time <= point.time) {
        const fraction = Math.max(0, Math.min(1, (time - previous.time) / (point.time - previous.time)));
        return previous.value + (point.value - previous.value) * fraction;
      }
      previous = point;
    }
    return previous.value;
  }
  function hold() {
    const time = context.currentTime, value = valueAt(time);
    if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(time);
    else {
      gain.cancelScheduledValues(time);
      gain.linearRampToValueAtTime(value, time);
      gain.setValueAtTime(value, time);
    }
    points = [{ time, value }];
    timeline = null;
  }
  function append(value: number, time: number) {
    if (time <= points[points.length - 1].time) return;
    gain.linearRampToValueAtTime(value, time);
    points.push({ time, value });
  }
  function refresh() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (disposed) return;
    if (!ownsPlayback()) { hold(); return; }
    // Static menus do not publish render frames. AudioParam automation spans
    // the actual loop boundary; this small watchdog only corrects drift/stalls.
    timer = setTimeout(refresh, CHECK_MS);
    if (media.paused === true || media.readyState < 3) {
      if (points.length > 1) hold();
      return;
    }
    const time = context.currentTime, duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(media.currentTime)) {
      // Metadata can arrive after play(). Keep a live/unknown-duration stream
      // audible, with an attack instead of a volume jump.
      if (timeline || points[points.length - 1].value !== 1) { hold(); append(1, time + .25); }
      return;
    }
    const position = Math.max(0, media.currentTime) % duration;
    const rate = Number.isFinite(media.playbackRate) && media.playbackRate > 0 ? media.playbackRate : 1;
    if (timeline && timeline.duration === duration && timeline.rate === rate && time < timeline.end) {
      const expected = (timeline.position + (time - timeline.time) * rate) % duration;
      const drift = Math.abs(position - expected);
      if (Math.min(drift, duration - drift) <= CLOCK_TOLERANCE_SECONDS) return;
    }
    hold();
    const fade = Math.min(FADE_SECONDS, duration / 4);
    const envelope = (position: number) => Math.max(0, Math.min(1, position / fade, (duration - position) / fade));
    const end = time + (duration - position) / rate;
    // A metadata update/seek corrects the current level gently. Normal clock
    // progression retains the already scheduled ramp, including at 60 fps.
    const correction = Math.min(.05, (end - time) / 2);
    append(envelope(position + correction * rate), time + correction);
    if (position < fade) append(1, time + (fade - position) / rate);
    if (position < duration - fade) append(1, time + (duration - fade - position) / rate);
    append(0, end);
    // Schedule the next attack before the native loop happens, even if the
    // browser delays its timeupdate callback around the end of the recording.
    append(1, end + fade / rate);
    timeline = { time, position, duration, rate, end };
  }
  return {
    refresh,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      hold();
    },
  };
}
