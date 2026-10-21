// RAF timestamps can be fractional or privacy-rounded to whole milliseconds.
// A strict 33.333…ms comparison often rejects the second 60Hz frame and waits
// for a third (20fps). Tolerate half a millisecond; actual simulation deltas
// still use the timestamps, and input can independently request its next paint.
const FRAME_INTERVAL_MS = 1000 / 30;
const FRAME_TIME_TOLERANCE_MS = .5;

export function worldFrameDue(now: number, previous: number): boolean {
  return now - previous >= FRAME_INTERVAL_MS - FRAME_TIME_TOLERANCE_MS;
}
