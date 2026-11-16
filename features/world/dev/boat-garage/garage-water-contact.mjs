import { garageWaterHeight } from "./garage-water-motion.mjs";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const coordinate = value => Number(value.toFixed(3));
const path = points => points.map((point, index) => `${index ? "L" : "M"}${coordinate(point.x)} ${coordinate(point.y)}`).join(" ");

/** The water remains in world space while the actual artwork supplies its alpha.
 * A single sampled contour drives the immersion mask, wet edge and refraction clip.
 * @param {{x:number,y:number}} center
 * @param {number} beam
 * @param {number} seconds
 * @param {number} amplitude
 * @param {number} bottomY
 * @param {number} canvasWidth
 */
export function garageWaterContactFrame(center, beam, seconds = 0, amplitude = 7, bottomY = center.y + 500, canvasWidth = 0) {
  const width = clamp(finite(beam, 700), 1, 40000), time = Math.max(0, finite(seconds, 0));
  const x = finite(center.x, 0), y = finite(center.y, 0), wave = clamp(finite(amplitude, 7), 0, 30);
  // Cover the whole authored rig, including an outboard motor outside the nominal displacement beam.
  const left = Math.min(0, x - width * .74), right = Math.max(finite(canvasWidth, 0), x + width * .74);
  const points = Array.from({ length: 49 }, (_, index) => {
    const px = left + (right - left) * index / 48;
    return { x: px, y: y + garageWaterHeight(px, time, wave) };
  });
  const surface = path(points), bottom = Math.max(finite(bottomY, y + 500), y + wave + 1);
  const submerged = `${surface} L${coordinate(right)} ${coordinate(bottom)} L${coordinate(left)} ${coordinate(bottom)} Z`;
  const wavelets = Array.from({ length: 8 }, (_, index) => {
    const phase = (time * .19 + index * .137) % 1, centerX = x + (index / 7 - .5) * width * .9;
    const span = width * (.022 + phase * .026), spread = 3 + phase * 25;
    return { d: path(Array.from({ length: 7 }, (_, sample) => {
      const along = sample / 6, px = centerX + (along - .5) * span * 2;
      return { x: px, y: y + garageWaterHeight(px, time, wave) + spread + Math.sin(along * Math.PI) * (1 + phase * 2) };
    })), opacity: Math.sin(phase * Math.PI) * .24 };
  });
  const reflections = Array.from({ length: 8 }, (_, index) => ({
    x: Math.sin(time * .83 + index * 1.7) * (1.2 + index * .34),
    y: y + 2 + index * 7.5, height: 2.2 + index * .3,
    opacity: .19 * (1 - index / 9),
  }));
  return { points, surface, submerged, wavelets, reflections, left, right };
}
