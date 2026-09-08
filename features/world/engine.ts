import { pixelSprite, type PixelDirection } from "@/lib/mochlik/pixel-sprite";
import { drawOwnedDecor } from "@/lib/mochlik/ambience";
import type { WorldState } from "./model";

export type WorldPlace = "house" | "workshop" | "journeys";
type Point = { x: number; y: number };
const SIZE = 320;
const places: { id: WorldPlace; x: number; y: number; w: number; h: number; cell: number }[] = [
  { id: "house", x: 191, y: 96, w: 80, h: 92, cell: 0 },
  { id: "workshop", x: 48, y: 165, w: 66, h: 64, cell: 3 },
  { id: "journeys", x: 273, y: 77, w: 29, h: 35, cell: 4 },
];
const blocked = (x: number, y: number, workshop = true) => x < 39 || x > 280 || y < 115 || y > 278
  || places.some(p => p.id !== "journeys" && (p.id !== "workshop" || workshop) && x > p.x - 9 && x < p.x + p.w + 9 && y > p.y + p.h - 32 && y < p.y + p.h + 9);

/** Small bounded grid: no per-frame pathfinding or network-position writes. */
export function worldPath(start: Point, target: Point, workshop = true): Point[] {
  const cell = (p: Point) => ({ x: Math.floor(p.x / 10), y: Math.floor(p.y / 10) });
  const a = cell(start), b = cell(target), key = (p: Point) => p.y * 32 + p.x;
  if (blocked(b.x * 10 + 5, b.y * 10 + 5, workshop)) return [];
  const queue = [a], previous = new Map<number, Point | null>([[key(a), null]]);
  for (let i = 0; i < queue.length && i < 1024; i++) {
    const p = queue[i];
    if (key(p) === key(b)) {
      const path: Point[] = []; let node: Point | null = p;
      while (node && key(node) !== key(a)) { path.unshift({ x: node.x * 10 + 5, y: node.y * 10 + 5 }); node = previous.get(key(node)) ?? null; }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: p.x + dx, y: p.y + dy };
      if (previous.has(key(next)) || blocked(next.x * 10 + 5, next.y * 10 + 5, workshop)) continue;
      previous.set(key(next), p); queue.push(next);
    }
  }
  return [];
}
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Не удалось загрузить полянку")); image.src = src; });
}
/** Cache keying happens once at texture load, never in the animation loop. */
function keyedAtlas(source: HTMLImageElement) {
  const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(source, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const r = data.data[i], g = data.data[i + 1], b = data.data[i + 2];
    if (Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 16) data.data[i + 3] = 0;
  }
  ctx.putImageData(data, 0, 0);
  // Tight bounds preserve consistent prop scale despite differently sized atlas cells.
  return Array.from({ length: 5 }, (_, cell) => {
    const sx = cell % 3 * 418, sy = Math.floor(cell / 3) * 627;
    let x0 = 418, y0 = 627, x1 = 0, y1 = 0;
    for (let y = 0; y < 627; y++) for (let x = 0; x < 418; x++) {
      if (data.data[((sy + y) * canvas.width + sx + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    const sprite = document.createElement("canvas"); sprite.width = x1 - x0 + 1; sprite.height = y1 - y0 + 1;
    sprite.getContext("2d")!.drawImage(canvas, sx + x0, sy + y0, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
    return sprite;
  });
}
let textures: Promise<{ ground: HTMLImageElement; props: HTMLCanvasElement[] }> | null = null;
function loadTextures() {
  return textures ??= Promise.all([loadImage("/world/clearing-v1.webp"), loadImage("/world/buildings-v1.webp")])
    .then(([ground, props]) => ({ ground, props: keyedAtlas(props) })).catch(e => { textures = null; throw e; });
}
export async function createWorldEngine(canvas: HTMLCanvasElement, initial: WorldState, options: { night: boolean; reduced: boolean; gifts: readonly string[]; onPlace: (place: WorldPlace) => void }) {
  const { ground, props } = await loadTextures();
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Браузер не поддерживает полянку");
  canvas.width = SIZE; canvas.height = SIZE; ctx.imageSmoothingEnabled = false;
  let inView = true;
  let state = initial, frame = 0, running = true, raf = 0, last = 0, lastDraw = 0;
  let actor = { x: 165, y: 225 }, path: Point[] = [], direction: PixelDirection = "front", greetingUntil = 0;
  let travelMotion: "leaving" | "returning" | null = null, fadeStarted = 0;
  const draw = (time: number) => {
    ctx.drawImage(ground, 0, 0, SIZE, SIZE);
    const entries = places.filter(p => p.id !== "workshop" || state.workshop).map(p => ({ depth: p.y + p.h, draw: () => {
      const image = props[p.id === "house" ? state.houseLevel - 1 : p.cell];
      ctx.drawImage(image, Math.round(p.x), Math.round(p.y), p.w, p.h);
      if (p.id === "house") { ctx.save(); ctx.translate(44, 66); drawOwnedDecor(ctx, options.gifts, options.reduced ? 0 : time / 1000); ctx.restore(); }
    } }));
    if (!state.journeys.length || travelMotion === "leaving") entries.push({ depth: actor.y, draw: () => {
      const idle = Math.floor(time / 12000) % 4;
      const pose = path.length ? "walk" : time < greetingUntil ? "greet" : frame % 40 === 0 ? "blink" : frame % 70 < 8 ? (["idle", "groom", "scratch", "wonder"] as const)[idle] : "idle";
      if (travelMotion === "leaving" && fadeStarted) ctx.globalAlpha = Math.max(0, 1 - (time - fadeStarted) / 450);
      ctx.drawImage(pixelSprite(pose, direction, options.reduced ? 0 : frame % 4, state.equipment), Math.round(actor.x - 19), Math.round(actor.y - 35), 38, 38);
      ctx.globalAlpha = 1;
    } });
    entries.sort((a, b) => a.depth - b.depth).forEach(entry => entry.draw());
    if (path.length) { const goal = path[path.length - 1]; ctx.strokeStyle = "#d9e8b580"; ctx.strokeRect(goal.x - 3, goal.y - 1, 6, 3); }
    if (options.night) { ctx.fillStyle = "#0a183a66"; ctx.fillRect(0, 0, SIZE, SIZE); }
    for (let i = 0; i < 6; i++) {
      const t = options.reduced ? i : time / 2200 + i * 8;
      const x = 60 + (i * 37) % 200 + Math.sin(t) * 10, y = 150 + (i * 43) % 115 + Math.cos(t * .7) * 7;
      ctx.globalAlpha = .35 + Math.sin(t) ** 2 * .5;
      ctx.fillStyle = options.night ? "#f1df80" : ["#eecb7d", "#dbc4ce", "#c9d792"][i % 3];
      if (options.night) { ctx.fillRect(x - 1, y - 1, 3, 3); ctx.globalAlpha *= .18; ctx.fillRect(x - 3, y - 3, 7, 7); }
      else { ctx.fillRect(x - 2, y, 2, 2); ctx.fillRect(x + 1, y + Math.round(Math.sin(t * 8)), 2, 2); }
    }
    ctx.globalAlpha = 1;
  };
  const tick = (time: number) => {
    if (!running || document.hidden || !inView) return;
    const dt = Math.min((time - last) / 1000, .08); last = time;
    if (path.length && (!state.journeys.length || travelMotion === "leaving")) {
      const next = path[0], dx = next.x - actor.x, dy = next.y - actor.y, distance = Math.hypot(dx, dy), speed = 34 * dt;
      direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";
      if (distance <= speed) { actor = next; path.shift(); } else { actor.x += dx / distance * speed; actor.y += dy / distance * speed; }
    }
    if (travelMotion && !path.length) {
      if (travelMotion === "returning") { travelMotion = null; greetingUntil = time + 1800; }
      else { if (!fadeStarted) fadeStarted = time; if (time - fadeStarted > 450) travelMotion = null; }
    }
    if (time - lastDraw > (options.reduced ? 100 : 1000 / 30)) { frame = Math.floor(time / 170); draw(time); lastDraw = time; }
    raf = requestAnimationFrame(tick);
  };
  const visible = () => { cancelAnimationFrame(raf); if (!document.hidden && running && inView) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  const pointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect(), point = { x: (event.clientX - rect.left) / rect.width * SIZE, y: (event.clientY - rect.top) / rect.height * SIZE };
    const hit = places.find(p => (p.id !== "workshop" || state.workshop) && point.x >= p.x && point.x <= p.x + p.w && point.y >= p.y && point.y <= p.y + p.h);
    if (hit) { options.onPlace(hit.id); return; }
    if (state.journeys.length) return;
    if (Math.hypot(point.x - actor.x, point.y - actor.y + 15) < 22) { greetingUntil = performance.now() + 1800; return; }
    const route = worldPath(actor, point, state.workshop); if (route.length) path = route;
  };
  const keydown = (event: KeyboardEvent) => {
    const move = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!move || state.journeys.length) return;
    event.preventDefault(); path = worldPath(actor, { x: actor.x + move[0], y: actor.y + move[1] }, state.workshop);
  };
  canvas.addEventListener("pointerup", pointer); canvas.addEventListener("keydown", keydown); document.addEventListener("visibilitychange", visible);
  const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visible(); });
  observer.observe(canvas); visible();
  return {
    update(next: WorldState, night: boolean, gifts: readonly string[]) {
      const wasAway = state.journeys.length > 0;
      state = next; options.night = night; options.gifts = gifts;
      if (!options.reduced && !wasAway && state.journeys.length) {
        travelMotion = "leaving"; fadeStarted = 0; path = worldPath(actor, { x: 275, y: 125 }, state.workshop);
      } else if (!options.reduced && wasAway && !state.journeys.length) {
        actor = { x: 275, y: 125 }; travelMotion = "returning"; path = worldPath(actor, { x: 165, y: 225 }, state.workshop);
      }
      if (blocked(actor.x, actor.y, state.workshop)) actor = { x: 165, y: 225 };
      if (state.journeys.length && travelMotion !== "leaving") path = [];
      else if (path.length) path = worldPath(actor, path[path.length - 1], state.workshop);
    },
    dispose() { observer.disconnect(); running = false; cancelAnimationFrame(raf); canvas.removeEventListener("pointerup", pointer); canvas.removeEventListener("keydown", keydown); document.removeEventListener("visibilitychange", visible); },
  };
}
