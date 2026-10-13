import { WATER_TOUCH_LIFETIME, type ForestWaterDynamics } from "./forest-water-dynamics";
import { isWaterBoundsVisible } from "./forest-water-render-mask";
import { dynamicsPathIsWet } from "./water-dynamics-geometry";

const TAU = Math.PI * 2;

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Cosmetic crests follow the initial impact. Exact clipping is owned by the
 * parent; radial visibility also prevents a ring reappearing behind an island
 * or on the opposite side of a thin strip of land. Reflected waves belong to
 * the shared height field underneath, not to these short impact accents. */
function ripple(ctx: CanvasRenderingContext2D, state: ForestWaterDynamics,
  touch: ForestWaterDynamics["touches"][number], age: number, echo: number, dusk: number) {
  const local = age - echo * .145;
  if (local <= 0) return;
  const strength = Math.max(.4, Math.min(1.5, Math.abs(touch.strength)));
  const radius = (2.7 + local * 25) * state.scale * Math.sqrt(strength), flatten = .47;
  const opacity = (1 - smooth(age / WATER_TOUCH_LIFETIME)) * Math.min(1, local / .07)
    * (1 - echo * .23) * (1 - dusk * .35);
  if (opacity < .005) return;
  ctx.beginPath();
  for (let segment = 0; segment < 32; segment++) {
    const start = segment * TAU / 32, end = (segment + 1) * TAU / 32;
    const middle = (start + end) / 2;
    const point = { x: touch.x + Math.cos(middle) * radius, y: touch.y + Math.sin(middle) * radius * flatten };
    if (!dynamicsPathIsWet(state.geometry, touch, point)) continue;
    const first = start + (segment % 8 === 0 ? .035 : 0), last = end - (segment % 8 === 7 ? .035 : 0);
    ctx.moveTo(touch.x + Math.cos(first) * radius, touch.y + Math.sin(first) * radius * flatten);
    ctx.ellipse(touch.x, touch.y, radius, radius * flatten, 0, first, last);
  }
  const alpha = ctx.globalAlpha;
  ctx.lineWidth = (echo ? .93 : 1.15) * state.scale;
  ctx.strokeStyle = "#21626a"; ctx.globalAlpha = alpha * opacity * .19; ctx.stroke();
  ctx.lineWidth = (echo ? .43 : .64) * state.scale;
  ctx.strokeStyle = dusk > .55 ? "#b4d7df" : "#d9ebe0";
  ctx.globalAlpha = alpha * opacity * .73; ctx.stroke(); ctx.globalAlpha = alpha;
}

function impact(ctx: CanvasRenderingContext2D, state: ForestWaterDynamics,
  touch: ForestWaterDynamics["touches"][number], age: number, dusk: number) {
  if (age >= .44) return;
  const scale = state.scale, opacity = (1 - dusk * .36), alpha = ctx.globalAlpha;
  if (age < .19) {
    const fade = 1 - smooth(age / .19), radius = (2.5 + age * 10) * scale;
    ctx.fillStyle = "#205c68"; ctx.globalAlpha = alpha * opacity * fade * .25;
    ctx.beginPath(); ctx.ellipse(touch.x, touch.y + .2 * scale, radius, radius * .41, 0, 0, TAU); ctx.fill();
  }
  if (age < .22) {
    const lift = Math.sin(age / .22 * Math.PI), width = (1.8 + age * 9) * scale;
    ctx.globalAlpha = alpha * opacity * (1 - smooth(age / .22)) * .62;
    ctx.strokeStyle = "#d3e9dd"; ctx.lineWidth = .65 * scale;
    ctx.beginPath(); ctx.moveTo(touch.x - width, touch.y);
    ctx.quadraticCurveTo(touch.x - width * .6, touch.y - lift * 2.4 * scale, touch.x - width * .35, touch.y - lift * .7 * scale);
    ctx.quadraticCurveTo(touch.x, touch.y - lift * 4.1 * scale, touch.x + width * .35, touch.y - lift * .7 * scale);
    ctx.quadraticCurveTo(touch.x + width * .7, touch.y - lift * 2.2 * scale, touch.x + width, touch.y); ctx.stroke();
  }
  ctx.fillStyle = dusk > .55 ? "#b9dbe1" : "#dbeee2";
  for (let drop = 0; drop < 5; drop++) {
    const life = .3 + (drop % 3) * .055, phase = age / life;
    if (phase <= 0 || phase >= 1) continue;
    const angle = drop * TAU / 5 + touch.id * 1.31, travel = (2 + phase * (5 + drop % 2 * 2)) * scale;
    const landing = { x: touch.x + Math.cos(angle) * travel, y: touch.y + Math.sin(angle) * travel * .47 };
    if (!dynamicsPathIsWet(state.geometry, touch, landing)) continue;
    const lift = 4 * phase * (1 - phase) * (4.5 + drop % 3) * scale;
    const radius = (.36 + drop % 2 * .12) * scale * (1 - phase * .35);
    ctx.globalAlpha = alpha * opacity * (1 - smooth(phase)) * .82;
    ctx.beginPath(); ctx.ellipse(landing.x, landing.y - lift, radius, radius * 1.32, angle * .17, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = alpha;
}

/** Bounded, deterministic and read-only; two cameras observe the same age. */
export function drawForestWaterTouches(ctx: CanvasRenderingContext2D, state: ForestWaterDynamics, dusk: number) {
  if (!state.touches?.length) return;
  ctx.save(); ctx.lineCap = "round";
  for (const touch of state.touches) {
    const age = state.elapsed - touch.startedAt;
    if (age < 0 || age >= WATER_TOUCH_LIFETIME) continue;
    const extent = 44 * state.scale;
    if (!isWaterBoundsVisible(ctx, { x: touch.x - extent, y: touch.y - extent, width: extent * 2, height: extent * 2 })) continue;
    for (let echo = 0; echo < 3; echo++) ripple(ctx, state, touch, age, echo, dusk);
    impact(ctx, state, touch, age, dusk);
  }
  ctx.restore();
}
