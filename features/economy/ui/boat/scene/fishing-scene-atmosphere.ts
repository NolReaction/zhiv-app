import { isTimeZone } from "@/lib/time-zone";

export type FishingSceneAmbience = { now: number; timeZone: string };
export type FishingSceneExclusion = { x: number; y: number; width: number; height: number };
export type FishingAtmospherePhase = "dawn" | "day" | "sunset" | "night";
type Weights = Record<FishingAtmospherePhase, number>;
const labels = { dawn: "Утренний туман", day: "Солнечный плёс", sunset: "Закат на реке", night: "Ночная тишина" } as const;
const clocks = new Map<string, Intl.DateTimeFormat>();
let cached: { now: number; zone: string; value: ReturnType<typeof atmosphereAtHour> } | undefined;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const wrap = (value: number, period: number) => ((value % period) + period) % period;
const seed = (key: number) => { const value = Math.sin(key * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

/** Only civil profile time changes the light. No location, weather service or game draw is consulted. */
export function atmosphereAtHour(hour: number) {
  const time = wrap(Number.isFinite(hour) ? hour : 12, 24);
  const keys: readonly [number, FishingAtmospherePhase][] = [[0, "night"], [5, "night"], [6.2, "dawn"], [8, "day"],
    [16.5, "day"], [18.5, "sunset"], [21, "night"], [24, "night"]];
  let index = 0;
  while (index < keys.length - 2 && time >= keys[index + 1][0]) index++;
  const [fromHour, from] = keys[index], [toHour, to] = keys[index + 1];
  const blend = smooth((time - fromHour) / (toHour - fromHour));
  const weights: Weights = { dawn: 0, day: 0, sunset: 0, night: 0 };
  weights[from] += 1 - blend; weights[to] += blend;
  const phase = (Object.keys(weights) as FishingAtmospherePhase[]).reduce((best, key) => weights[key] > weights[best] ? key : best, from);
  return { ...weights, phase, label: labels[phase], hour: time, daylight: weights.day + weights.dawn * .6 + weights.sunset * .34,
    mist: weights.dawn * .75 + weights.night * .12 };
}

export function fishingSceneAtmosphere(ambience?: FishingSceneAmbience) {
  if (!ambience || !Number.isFinite(ambience.now)) return atmosphereAtHour(12);
  const zone = isTimeZone(ambience.timeZone) ? ambience.timeZone : "UTC";
  if (cached?.now === ambience.now && cached.zone === zone) return cached.value;
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (clocks.size >= 4) clocks.delete(clocks.keys().next().value!);
    clocks.set(zone, clock);
  }
  const parts = clock.formatToParts(ambience.now);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value ?? 0);
  const hour = part("hour") + part("minute") / 60 + part("second") / 3600 + wrap(ambience.now, 1000) / 3_600_000;
  const value = atmosphereAtHour(hour); cached = { now: ambience.now, zone, value }; return value;
}

type AmbientKind = "leaf" | "dragonfly" | "distant-ripple" | "bubbles" | "firefly";
export type FishingAmbientEvent = { kind: AmbientKind; x: number; y: number; progress: number; opacity: number; size: number };
const schedule: readonly { kind: AmbientKind; period: number; offset: number; duration: number; extentX: number; extentY: number }[] = [
  { kind: "leaf", period: 38, offset: 5, duration: 13, extentX: 38, extentY: 20 },
  { kind: "dragonfly", period: 53, offset: 14, duration: 5.5, extentX: 76, extentY: 28 },
  { kind: "distant-ripple", period: 29, offset: 22, duration: 2.1, extentX: 40, extentY: 17 },
  { kind: "bubbles", period: 43, offset: 31, duration: 3, extentX: 18, extentY: 26 },
  { kind: "firefly", period: 43, offset: 11, duration: 11, extentX: 45, extentY: 22 },
];

const overlaps = (a: FishingSceneExclusion, b: FishingSceneExclusion) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Sparse decoration uses a separate clock and excludes the entire future motion path from active controls. */
export function fishingAmbientEvents(width: number, height: number, elapsed: number, ambience?: FishingSceneAmbience,
  exclusions: readonly FishingSceneExclusion[] = []): FishingAmbientEvent[] {
  if (!(width > 0 && height > 0) || !Number.isFinite(elapsed) || elapsed < 0) return [];
  const mood = fishingSceneAtmosphere(ambience), events: FishingAmbientEvent[] = [];
  for (let index = 0; index < schedule.length; index++) {
    const event = schedule[index], age = elapsed - event.offset;
    if (age < 0) continue;
    const cycle = Math.floor(age / event.period), progress = wrap(age, event.period) / event.duration;
    if (progress >= 1 || event.kind === "dragonfly" && mood.daylight < .3 || event.kind === "firefly" && mood.night < .4) continue;
    const extentX = Math.min(event.extentX, width * .1), extentY = Math.min(event.extentY, height * .06);
    let anchor: { x: number; y: number } | undefined;
    for (let attempt = 0; attempt < 14; attempt++) {
      const key = index * 73 + cycle * 131 + attempt * 17;
      const x = extentX + 12 + seed(key + 1) * Math.max(0, width - extentX * 2 - 24);
      const y = extentY + 72 + seed(key + 5) * Math.max(0, height - extentY * 2 - 104);
      const bounds = { x: x - extentX - 8, y: y - extentY - 8, width: extentX * 2 + 16, height: extentY * 2 + 16 };
      if (!exclusions.some(rect => overlaps(bounds, rect))) { anchor = { x, y }; break; }
    }
    if (!anchor) continue;
    const visibility = event.kind === "firefly" ? mood.night : event.kind === "dragonfly" ? mood.daylight : .7 + mood.daylight * .3;
    const opacity = Math.sin(Math.PI * progress) ** .8 * visibility;
    const x = anchor.x + (event.kind === "dragonfly" ? Math.sin(progress * Math.PI * 2) * extentX * .7
      : event.kind === "leaf" ? (progress - .5) * extentX : Math.sin(progress * Math.PI * 3) * extentX * .4);
    const y = anchor.y + (event.kind === "dragonfly" || event.kind === "firefly" ? Math.sin(progress * Math.PI * 3.4) * extentY * .65
      : event.kind === "leaf" ? (progress - .5) * extentY : 0);
    events.push({ kind: event.kind, x, y, progress, opacity, size: event.kind === "leaf" ? 9 + seed(cycle + 8) * 4 : 1 });
  }
  return events;
}

/** Painted behind the gameplay. Ambient rings never dip the controlled float or play a bite cue. */
export function paintFishingAtmosphere(ctx: CanvasRenderingContext2D, width: number, height: number, time: number,
  ambience?: FishingSceneAmbience, exclusions: readonly FishingSceneExclusion[] = []) {
  const mood = fishingSceneAtmosphere(ambience);
  if (mood.mist > .01) for (let index = 0; index < 4; index++) {
    const y = height * (.14 + index * .18) + Math.sin(time * .035 + index) * 9;
    const haze = ctx.createLinearGradient(0, y - 38, 0, y + 38);
    haze.addColorStop(0, "rgba(216,234,225,0)"); haze.addColorStop(.5, `rgba(216,234,225,${mood.mist * .1})`); haze.addColorStop(1, "rgba(216,234,225,0)");
    ctx.fillStyle = haze; ctx.fillRect(0, y - 38, width, 76);
  }
  if (mood.night > .01) {
    ctx.save(); ctx.lineCap = "round";
    for (let index = 0; index < 9; index++) {
      const p = index / 9, x = width * .81 + Math.sin(time * .25 + index) * (4 + p * 12), y = height * (.12 + p * .4);
      ctx.strokeStyle = `rgba(205,227,237,${mood.night * (.13 - p * .08)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 10 - p * 34, y); ctx.quadraticCurveTo(x, y + 2, x + 10 + p * 34, y - 1); ctx.stroke();
    }
    ctx.restore();
  }
  for (const event of fishingAmbientEvents(width, height, time, ambience, exclusions)) {
    ctx.save(); ctx.translate(event.x, event.y); ctx.globalAlpha *= event.opacity;
    if (event.kind === "leaf") {
      ctx.rotate(Math.sin(time * .7) * .12 + .3); ctx.fillStyle = "#879f51"; ctx.strokeStyle = "#c0bd6b"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, event.size, event.size * .38, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-event.size, 0); ctx.lineTo(event.size * .8, 0); ctx.stroke();
    } else if (event.kind === "dragonfly") {
      ctx.fillStyle = "rgba(204,235,224,.65)";
      const wing = 1 + Math.sin(time * 35) * .25;
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(0, side * 4, 9 * wing, 2.2, side * .25, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = "#74b5ba"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.stroke();
    } else if (event.kind === "distant-ripple") {
      ctx.strokeStyle = "rgba(194,225,218,.35)"; ctx.lineWidth = 1;
      for (let ring = 0; ring < 2; ring++) { const r = 5 + event.progress * 22 + ring * 5;
        ctx.beginPath(); ctx.ellipse(0, 0, r, r * .36, -.12, .2, Math.PI * 1.8); ctx.stroke(); }
    } else if (event.kind === "bubbles") {
      ctx.strokeStyle = "rgba(194,225,218,.38)"; ctx.lineWidth = 1;
      for (let bubble = 0; bubble < 3; bubble++) { ctx.beginPath(); ctx.arc((bubble - 1) * 7, -event.progress * 16 + bubble * 3, 2 + bubble % 2, 0, Math.PI * 2); ctx.stroke(); }
    } else {
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 7);
      glow.addColorStop(0, "rgba(186,231,191,.45)"); glow.addColorStop(1, "rgba(186,231,191,0)");
      ctx.fillStyle = glow; ctx.fillRect(-7, -7, 14, 14);
    }
    ctx.restore();
  }
}

/** A gentle final wash unifies the authored hull and character with the river's time of day. */
export function paintFishingSceneTint(ctx: CanvasRenderingContext2D, width: number, height: number, ambience?: FishingSceneAmbience) {
  const mood = fishingSceneAtmosphere(ambience);
  if (mood.night > .01) { ctx.fillStyle = `rgba(14,29,67,${mood.night * .16})`; ctx.fillRect(0, 0, width, height); }
  if (mood.sunset > .01) { ctx.fillStyle = `rgba(221,147,77,${mood.sunset * .055})`; ctx.fillRect(0, 0, width, height); }
}
