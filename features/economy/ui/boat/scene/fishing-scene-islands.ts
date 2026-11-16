import { fishingSceneAtmosphere, type FishingAtmospherePhase, type FishingSceneAmbience, type FishingSceneExclusion } from "./fishing-scene-atmosphere";

export type FishingSceneIsland = Readonly<FishingSceneExclusion & {
  seed: number; kind: "reed-bank" | "pebble-islet" | "low-willow";
}>;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const seed = (key: number) => { const value = Math.sin(key * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
const overlaps = (a: FishingSceneExclusion, b: FishingSceneExclusion) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const anchors = [[.83, .10], [.11, .48], [.47, .08], [.88, .64], [.15, .73], [.025, .34], [.68, .73], [.97, .28], [.04, .43], [.96, .46], [.05, .59], [.95, .64]] as const;
let layoutCache: { key: string; value: readonly FishingSceneIsland[] } | undefined;

/** A voyage changes only these small banks. Complete rims, reeds and reflections avoid gameplay and HUD bounds. */
export function fishingIslandLayout(width: number, height: number, sceneKey?: string,
  exclusions: readonly FishingSceneExclusion[] = []): readonly FishingSceneIsland[] {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return [];
  const key = `${width}:${height}:${sceneKey ?? ""}:${exclusions.map(rect => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`;
  if (layoutCache?.key === key) return layoutCache.value;
  let hash = 2166136261;
  for (const character of sceneKey ?? "quiet-reach") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const islands: FishingSceneIsland[] = [], count = width < 700 || height < 420 ? 2 : 3;
  for (let index = 0; index < anchors.length && islands.length < count; index++) {
    const anchor = anchors[(index + hash % anchors.length) % anchors.length], value = hash % 100003 + index * 37;
    // Side channels can be narrow on phones. Try three bounded sizes before omitting a bank entirely.
    for (const size of [1, .82, .67]) {
      const islandWidth = Math.min(width * .22, clamp(width * (.11 + seed(value) * .015), 78, 204)) * size;
      const islandHeight = Math.min(height * .22, islandWidth * (.62 + seed(value + 1) * .1));
      const x = clamp(width * (anchor[0] + (seed(value + 2) - .5) * .035) - islandWidth / 2, 4, Math.max(4, width - islandWidth - 4));
      const y = clamp(height * (anchor[1] + (seed(value + 3) - .5) * .025) - islandHeight / 2, 4, Math.max(4, height - islandHeight - 4));
      const bounds = { x, y, width: islandWidth, height: islandHeight };
      if (exclusions.some(rect => overlaps(bounds, rect)) || islands.some(rect => overlaps(bounds, rect))) continue;
      const kind = (["reed-bank", "pebble-islet", "low-willow"] as const)[(hash + index) % 3];
      islands.push(Object.freeze({ ...bounds, seed: value, kind })); break;
    }
  }
  const value = Object.freeze(islands); layoutCache = { key, value }; return value;
}

const palettes = {
  day: { shelf: "#438c83", rim: "#88b6a0", bank: "#596452", soil: "#7d8258", grass: "#728b49", light: "#93a35c", shade: "#476b43", stem: "#77734d", rock: "#89958b", rockLight: "#abb4a0" },
  dawn: { shelf: "#648d89", rim: "#a1b5a4", bank: "#596759", soil: "#8e8a6d", grass: "#788c58", light: "#a0aa75", shade: "#526b51", stem: "#827e5c", rock: "#929e94", rockLight: "#b8bdac" },
  sunset: { shelf: "#548478", rim: "#afad85", bank: "#5d604b", soil: "#998563", grass: "#8a8b47", light: "#b0a15e", shade: "#576541", stem: "#948150", rock: "#938b78", rockLight: "#c3ad87" },
  night: { shelf: "#244a56", rim: "#5c7c7a", bank: "#303e3c", soil: "#50594b", grass: "#3e5a43", light: "#617954", shade: "#2b4b3e", stem: "#515d4a", rock: "#596e6d", rockLight: "#81918a" },
} satisfies Record<FishingAtmospherePhase, Record<string, string>>;
type Palette = typeof palettes.day;

function landPath(ctx: CanvasRenderingContext2D, width: number, height: number, key: number, offset = 0, spread = 1) {
  const points = Array.from({ length: 12 }, (_, index) => {
    const angle = index / 12 * Math.PI * 2, radius = .80 + seed(key + index * 11) * .2;
    return { x: width * .5 + Math.cos(angle) * width * .4 * radius * spread,
      y: height * .63 + Math.sin(angle) * height * .19 * radius * spread + offset };
  });
  const last = points[points.length - 1], first = points[0];
  ctx.beginPath(); ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  points.forEach((point, index) => { const next = points[(index + 1) % points.length];
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2); });
  ctx.closePath();
}

function paintIslandTile(ctx: CanvasRenderingContext2D, width: number, height: number, island: FishingSceneIsland, palette: Palette) {
  const key = island.seed;
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  // Shallow silt, then a submerged dark bank: neither reads as a detached floating shadow.
  landPath(ctx, width, height, key, height * .045, 1.13); ctx.globalAlpha = .28; ctx.fillStyle = palette.shelf; ctx.fill();
  ctx.globalAlpha = .42; ctx.strokeStyle = palette.rim; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.globalAlpha = 1; landPath(ctx, width, height, key, height * .055); ctx.fillStyle = palette.bank; ctx.fill();
  landPath(ctx, width, height, key); ctx.fillStyle = palette.soil; ctx.fill();
  ctx.strokeStyle = palette.shade; ctx.lineWidth = 1.3; ctx.stroke();
  landPath(ctx, width, height, key + 4, -height * .025, .87); ctx.fillStyle = palette.grass; ctx.fill();
  // Small painted grass patches follow the land rather than a uniform noise texture.
  for (let index = 0; index < 15; index++) {
    const angle = seed(key + index * 7) * Math.PI * 2, distance = Math.sqrt(seed(key + index * 9 + 2)) * .73;
    const x = width * (.5 + Math.cos(angle) * .34 * distance), y = height * (.6 + Math.sin(angle) * .135 * distance);
    ctx.fillStyle = index % 3 ? palette.light : palette.shade; ctx.globalAlpha = .3;
    ctx.beginPath(); ctx.ellipse(x, y, width * (.018 + seed(index + key) * .035), height * .018, -.18, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const stones = island.kind === "pebble-islet" ? 5 : 2;
  for (let index = 0; index < stones; index++) {
    const x = width * (.28 + seed(key + index * 13) * .48), y = height * (.64 + seed(key + index * 17) * .12);
    const size = width * (.025 + seed(key + index * 23) * .027);
    ctx.fillStyle = palette.bank; ctx.beginPath(); ctx.ellipse(x, y + 2, size * 1.1, size * .53, -.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = palette.rock; ctx.beginPath(); ctx.ellipse(x, y, size, size * .62, -.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = palette.rockLight; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - size * .6, y - size * .25); ctx.quadraticCurveTo(x, y - size * .6, x + size * .55, y - size * .28); ctx.stroke();
  }
  const reeds = island.kind === "reed-bank" ? 12 : 6;
  for (let index = 0; index < reeds; index++) {
    const x = width * (.24 + seed(key + index * 31) * .52), y = height * (.53 + seed(key + index * 19) * .13);
    const length = height * (.14 + seed(key + index * 29) * .18), bend = (seed(key + index * 43) - .5) * width * .07;
    ctx.strokeStyle = index % 3 ? palette.shade : palette.light; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + bend * .2, y - length * .55, x + bend, y - length); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - length * .2); ctx.quadraticCurveTo(x - width * .025, y - length * .7, x - width * .045, y - length * .55); ctx.stroke();
    if (index % 3 === 0) { ctx.strokeStyle = palette.stem; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x + bend, y - length); ctx.lineTo(x + bend * .9, y - length * .78); ctx.stroke(); }
  }
  if (island.kind === "low-willow") {
    const x = width * .51, y = height * .49;
    ctx.strokeStyle = palette.stem; ctx.lineWidth = width * .022;
    ctx.beginPath(); ctx.moveTo(x + width * .02, height * .65); ctx.quadraticCurveTo(x + width * .04, y, x - width * .03, height * .29); ctx.stroke();
    for (let index = 0; index < 8; index++) {
      const angle = index / 8 * Math.PI * 2;
      const lx = x + Math.cos(angle) * width * .12, ly = y - height * .13 + Math.sin(angle) * height * .09;
      ctx.fillStyle = index % 3 ? palette.grass : palette.shade; ctx.beginPath(); ctx.ellipse(lx, ly, width * .105, height * .105, -.13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = palette.light; ctx.lineWidth = 1.1; ctx.globalAlpha = .6;
      ctx.beginPath(); ctx.moveTo(lx - width * .05, ly - height * .025); ctx.quadraticCurveTo(lx, ly - height * .06, lx + width * .04, ly - height * .035); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

const tiles = new Map<string, HTMLCanvasElement>();
function islandTile(island: FishingSceneIsland, phase: FishingAtmospherePhase) {
  const width = Math.ceil(island.width), height = Math.ceil(island.height), key = `${width}:${height}:${island.seed}:${island.kind}:${phase}`;
  const existing = tiles.get(key); if (existing) return existing;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) return null;
  paintIslandTile(context, width, height, island, palettes[phase]);
  if (tiles.size >= 24) tiles.delete(tiles.keys().next().value!);
  tiles.set(key, canvas); return canvas;
}

/** Small cached banks sit behind the public gameplay. The shared civil-time mood changes light, never rewards. */
export function paintFishingIslands(ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number,
  sceneKey?: string, ambience?: FishingSceneAmbience, exclusions: readonly FishingSceneExclusion[] = []) {
  const mood = fishingSceneAtmosphere(ambience), phases = (["day", "dawn", "sunset", "night"] as const).filter(phase => mood[phase] > .0001);
  const time = Number.isFinite(elapsed) ? elapsed : 0;
  for (const island of fishingIslandLayout(width, height, sceneKey, exclusions)) {
    ctx.save(); ctx.translate(island.x, island.y);
    phases.forEach((phase, index) => {
      const tile = islandTile(island, phase); ctx.save(); ctx.globalAlpha *= index ? mood[phase] : 1;
      if (tile) ctx.drawImage(tile, 0, 0, island.width, island.height);
      else paintIslandTile(ctx, island.width, island.height, island, palettes[phase]);
      ctx.restore();
    });
    // One open contact arc breathes gently at the waterline; the island itself never bobs.
    ctx.strokeStyle = `rgba(191,220,198,${(.06 + mood.daylight * .06) * (.8 + Math.sin(time * .8 + island.seed) * .2)})`;
    ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(island.width * .5, island.height * .69, island.width * .46,
      island.height * .23, -.025, .1, Math.PI * .9); ctx.stroke(); ctx.restore();
  }
}
