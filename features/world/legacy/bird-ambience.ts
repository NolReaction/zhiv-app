import { FOREST_MAP, type MapPoint } from "./map-manifest";

const TAU = Math.PI * 2;
const outside = FOREST_MAP.size + 40;

// Small flocks cross between the trees, with long quiet intervals between passes.
export const BIRD_FLIGHTS = [
  { from: { x: -40, y: 330 }, bend: { x: 580, y: 115 }, to: { x: outside, y: 510 }, startsAt: 6, period: 47, duration: 17, count: 2 },
  { from: { x: outside, y: 1030 }, bend: { x: 660, y: 455 }, to: { x: -40, y: 720 }, startsAt: 31, period: 71, duration: 21, count: 3 },
] as const;
type BirdFlight = typeof BIRD_FLIGHTS[number];

export function birdFlightPose(flight: BirdFlight, seconds: number, index: number) {
  const start = flight.startsAt + index * .44;
  if (seconds < start) return null;
  const elapsed = (seconds - start) % flight.period;
  if (elapsed >= flight.duration) return null;
  const t = elapsed / flight.duration, inverse = 1 - t;
  const position: MapPoint = {
    x: inverse * inverse * flight.from.x + 2 * inverse * t * flight.bend.x + t * t * flight.to.x,
    y: inverse * inverse * flight.from.y + 2 * inverse * t * flight.bend.y + t * t * flight.to.y + index * 11,
  };
  const dx = 2 * inverse * (flight.bend.x - flight.from.x) + 2 * t * (flight.to.x - flight.bend.x);
  const dy = 2 * inverse * (flight.bend.y - flight.from.y) + 2 * t * (flight.to.y - flight.bend.y);
  return { ...position, angle: Math.atan2(dy, dx),
    wing: Math.sin(seconds * TAU * 3.8 + index * 1.7),
    opacity: Math.min(1, t / .08, (1 - t) / .08),
  };
}

/** Called by the existing map renderer: no independent clock, timer or animation loop. */
export function drawBirdAmbience(ctx: CanvasRenderingContext2D, seconds: number, reducedMotion: boolean, dusk: number, rain: number) {
  if (reducedMotion) return;
  const daylight = Math.max(0, 1 - dusk) ** 2 * Math.max(0, 1 - rain);
  if (daylight < .01) return;
  ctx.save();
  for (const flight of BIRD_FLIGHTS) for (let index = 0; index < flight.count; index++) {
    const pose = birdFlightPose(flight, seconds, index);
    if (!pose) continue;
    ctx.save();
    ctx.globalAlpha = daylight * pose.opacity * .1; ctx.fillStyle = "#15261d";
    ctx.beginPath(); ctx.ellipse(pose.x + 8, pose.y + 16, 6, 2, pose.angle, 0, TAU); ctx.fill();
    ctx.translate(pose.x, pose.y); ctx.rotate(pose.angle);
    ctx.globalAlpha = daylight * pose.opacity * .83;
    ctx.fillStyle = "#35463d";
    const spread = Math.round(3 + (pose.wing + 1) * 2.5);
    // Pixel wings fold towards the body and open again during each downstroke.
    ctx.fillRect(-2, -spread, 3, spread * 2);
    ctx.fillRect(-4, -spread, 3, 2); ctx.fillRect(-4, spread - 2, 3, 2);
    ctx.fillRect(-3, -1, 8, 3); ctx.fillRect(-6, -2, 3, 4);
    ctx.fillStyle = "#9dad98";
    ctx.fillRect(-1, -spread + 1, 2, Math.max(1, spread - 2));
    ctx.fillRect(-1, 2, 2, Math.max(1, spread - 3));
    ctx.fillStyle = "#d1d2b6";
    ctx.fillRect(-2, -1, 5, 2); ctx.fillRect(2, 0, 2, 1);
    ctx.fillStyle = "#7d7860"; ctx.fillRect(5, 0, 2, 1);
    ctx.restore();
  }
  ctx.restore();
}
