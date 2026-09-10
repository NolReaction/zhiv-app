import { RAIN_END_SECONDS, RAIN_PERIOD_SECONDS } from "@/features/mochlik/habitat";
import { FOREST_MAP } from "./map-manifest";

export type WeatherVisitorState = {
  elapsed: number; ecologyTime: number; rain: number; dusk: number;
};
type GroundVisitor = { x: number; y: number; opacity: number; lift: number };
type MothPose = { x: number; y: number; opacity: number; wings: number };
type WeatherVisitors = { snail: GroundVisitor | null; frog: GroundVisitor | null; moths: MothPose[] };
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const phaseAt = (seconds: number, period: number) => ((seconds % period) + period) % period;
const fade = (age: number, duration: number) => smooth(Math.min(age / 2, (duration - age) / 3));

/** Pure poses use the habitat's clocks: both cameras see the same visitors.
 * Brief appearances are decorative; they never issue rewards or schedule work. */
export function weatherVisitorsAt(state: WeatherVisitorState, reducedMotion = false): WeatherVisitors {
  const visitors: WeatherVisitors = { snail: null, frog: null, moths: [] };
  if (reducedMotion || ![state.elapsed, state.ecologyTime, state.rain, state.dusk].every(Number.isFinite)
    || state.rain >= .1) return visitors;

  const afterRain = phaseAt(state.ecologyTime, RAIN_PERIOD_SECONDS) - RAIN_END_SECONDS;
  const snailAge = afterRain - 3;
  if (snailAge >= 0 && snailAge < 40) {
    const travel = snailAge / 40;
    visitors.snail = { x: 574 + travel * 24, y: 694 - Math.sin(travel * Math.PI) * 3,
      opacity: fade(snailAge, 40), lift: 0 };
  }
  const frogAge = afterRain - 15;
  if (frogAge >= 0 && frogAge < 15) {
    const firstHop = clamp((frogAge - 3) / .7), secondHop = clamp((frogAge - 10) / .7);
    const travel = firstHop + secondHop;
    visitors.frog = { x: 838 + travel * 7, y: 931 - travel,
      lift: (Math.sin(firstHop * Math.PI) + Math.sin(secondHop * Math.PI)) * 3.5,
      opacity: fade(frogAge, 15) };
  }

  const mothAge = phaseAt(state.elapsed, 180) - 48;
  if (state.dusk > .6 && mothAge >= 0 && mothAge < 18) {
    const lamp = FOREST_MAP.house.lamp;
    for (let i = 0; i < 2; i++) {
      const phase = mothAge * .9 + i * 2.1;
      visitors.moths.push({
        x: lamp.x + (i === 0 ? -5 : 11) + Math.cos(phase) * (i === 0 ? 5 : 4),
        y: lamp.y + (i === 0 ? -7 : -1) + Math.sin(phase * 1.2) * (i === 0 ? 3 : 6),
        opacity: fade(mothAge, 18) * smooth((state.dusk - .6) / .4),
        wings: Math.sin(state.elapsed * TAU * 4 + i * 1.7) > 0 ? 2 : 1,
      });
    }
  }
  return visitors;
}

/** Source-map coordinates. Paint on top of the ground, before scene lighting. */
export function drawWeatherGround(ctx: CanvasRenderingContext2D, state: WeatherVisitorState, reducedMotion: boolean) {
  const { snail, frog } = weatherVisitorsAt(state, reducedMotion);
  if (snail?.opacity) {
    ctx.save(); ctx.translate(Math.round(snail.x), Math.round(snail.y));
    ctx.globalAlpha = snail.opacity * .8;
    ctx.fillStyle = "#4c5237"; ctx.fillRect(-4, -1, 8, 1); ctx.fillRect(2, -3, 2, 2); ctx.fillRect(3, -4, 1, 1);
    ctx.fillStyle = "#58482e"; ctx.fillRect(-3, -4, 4, 3); ctx.fillRect(-2, -5, 2, 1);
    ctx.fillStyle = "#ae8951"; ctx.fillRect(-2, -4, 2, 3); ctx.fillRect(-1, -3, 2, 1);
    ctx.fillStyle = "#685034"; ctx.fillRect(-1, -3, 1, 1);
    ctx.restore();
  }
  if (frog?.opacity) {
    ctx.save(); ctx.translate(Math.round(frog.x), Math.round(frog.y));
    ctx.globalAlpha = frog.opacity * .15; ctx.fillStyle = "#293928"; ctx.fillRect(-4, 0, 8, 1);
    ctx.translate(0, -Math.round(frog.lift)); ctx.globalAlpha = frog.opacity * .9;
    ctx.fillStyle = "#344e2d"; ctx.fillRect(-4, -2, 8, 2); ctx.fillRect(-3, -4, 6, 3);
    ctx.fillStyle = "#829750"; ctx.fillRect(-2, -3, 4, 2); ctx.fillRect(-2, -5, 2, 2); ctx.fillRect(1, -5, 2, 2);
    ctx.fillStyle = "#b5b875"; ctx.fillRect(-1, -2, 3, 1);
    ctx.fillStyle = "#263526"; ctx.fillRect(-1, -5, 1, 1); ctx.fillRect(2, -5, 1, 1);
    ctx.restore();
  }
}

/** Small warm wings catch the lantern light; no extra light source or halo. */
export function drawWeatherAir(ctx: CanvasRenderingContext2D, state: WeatherVisitorState, reducedMotion: boolean) {
  const { moths } = weatherVisitorsAt(state, reducedMotion);
  if (!moths.length) return;
  ctx.save();
  for (const moth of moths) {
    const x = Math.round(moth.x), y = Math.round(moth.y);
    ctx.globalAlpha = moth.opacity * .7; ctx.fillStyle = "#c6b181";
    ctx.fillRect(x - moth.wings, y - 1, moth.wings, 1); ctx.fillRect(x + 1, y - 1, moth.wings, 1);
    ctx.globalAlpha = moth.opacity * .8; ctx.fillStyle = "#8c7650"; ctx.fillRect(x, y, 1, 2);
  }
  ctx.restore();
}
