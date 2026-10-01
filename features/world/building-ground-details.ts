import { siteContactArea } from "./grounding";
import { previewPointInPolygon } from "./tiled/preview-state";
import { drawSiteImage, siteImagePoint } from "./tiled/site-image";
import type { FixedSite, FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

type BaseSample = { u: number; v: number };
type GroundMark = WorldPoint & { size: number; variant: number; kind: "grass" | "stone" | "chip" };
type GroundTexture = { canvas: HTMLCanvasElement; bounds: WorldBounds };
const bases = new WeakMap<HTMLImageElement, BaseSample[]>();
const textures = new WeakMap<FixedWorldScene, WeakMap<FixedSite, WeakMap<HTMLImageElement, GroundTexture | null>>>();
const noise = (value: number) => { const result = Math.sin(value * 127.1 + 53.7) * 43758.5453; return result - Math.floor(result); };

/** The actual opaque feet supply attachment points; the collision is only a
 * coarse foundation band. Never draw a visible navigation contour. */
function artworkBase(image: HTMLImageElement): BaseSample[] {
  const cached = bases.get(image);
  if (cached) return cached;
  const samples: BaseSample[] = [];
  if (!image.naturalWidth || !image.naturalHeight || typeof document === "undefined") return samples;
  try {
    const canvas = document.createElement("canvas"), scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const step = Math.max(2, Math.ceil(canvas.width / 48));
      for (let x = step; x < canvas.width - step; x += step) {
        for (let y = canvas.height - 1; y >= 0; y--) {
          if (data[(y * canvas.width + x) * 4 + 3] < 128) continue;
          samples.push({ u: (x + .5) / canvas.width, v: (y + .5) / canvas.height }); break;
        }
      }
    }
  } catch { /* Missing alpha means no dressing, not collision-shaped ink. */ }
  bases.set(image, samples);
  return samples;
}

function wet(scene: Pick<FixedWorldScene, "water">, point: WorldPoint) {
  return scene.water?.surfaces.some(surface => previewPointInPolygon(point, surface.points))
    && !scene.water?.exclusions.some(exclusion => previewPointInPolygon(point, exclusion.points));
}

function nearEntrance(site: FixedSite, point: WorldPoint) {
  if (Math.hypot(point.x - site.entry.x, point.y - site.entry.y) < 9) return true;
  if (!site.doorway) return false;
  const dx = site.doorway.x - site.entry.x, dy = site.doorway.y - site.entry.y;
  const length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, ((point.x - site.entry.x) * dx + (point.y - site.entry.y) * dy) / length)) : 0;
  return Math.hypot(point.x - site.entry.x - along * dx, point.y - site.entry.y - along * dy) < 7;
}

/** Three to five separated groups, not a regular fringe. Bridge dressing needs
 * explicit water data and is confined to opaque feet at the two outer ends. */
export function siteGroundMarks(scene: Pick<FixedWorldScene, "water">, site: FixedSite, samples: readonly BaseSample[]): GroundMark[] {
  const bridge = site.id === "bridge";
  if (bridge && !scene.water?.surfaces.length) return [];
  const area = siteContactArea(site);
  if (!area) return [];
  const size = Math.max(.8, Math.min(2.3, Math.min(site.bounds.width, site.bounds.height) / 65));
  const candidates = samples.flatMap((sample, index): GroundMark[] => {
    if (bridge && sample.u > .13 && sample.u < .87) return [];
    const point = siteImagePoint(site, sample.u, sample.v), variant = noise(index + site.id.length * 9);
    if (point.y < area.y || point.y > area.y + area.height + size * 2
      || point.x < area.x - size || point.x > area.x + area.width + size
      || nearEntrance(site, point)
      || wet(scene, point)) return [];
    if (bridge && [-1, 1].some(direction => wet(scene, { x: point.x + direction * size * 3, y: point.y + size * 2 }))) return [];
    const kind = site.id === "quarry" || site.id === "lighthouse" ? (variant < .77 ? "stone" : "grass")
      : site.id === "workshop" && variant < .62 ? "chip" : "grass";
    return [{ ...point, size: size * (.82 + variant * .35), variant, kind }];
  });
  // Select by a stable hash, then enforce spacing in world space. Different
  // foundations and levels get their own composition while repeated frames match.
  candidates.sort((a, b) => noise(b.variant * 631) - noise(a.variant * 631));
  const selected: GroundMark[] = [];
  const limit = bridge ? 2 : site.id === "lighthouse" ? 3 : site.id === "quarry" ? 4 : 5;
  const separation = Math.max(8, area.width * .12);
  for (const point of candidates) {
    if (selected.some(other => Math.hypot(point.x - other.x, point.y - other.y) < separation)) continue;
    selected.push(point);
    if (selected.length === limit) break;
  }
  return selected.sort((a, b) => a.y - b.y);
}

function dab(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string, opacity: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, `rgba(${color},${opacity})`);
  gradient.addColorStop(.48, `rgba(${color},${opacity * .62})`);
  gradient.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = gradient; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

function groundBed(ctx: CanvasRenderingContext2D, mark: GroundMark, stone: boolean, bridge: boolean) {
  const { x, y, size: s, variant } = mark;
  // Several overlapping soft dabs leave a broken, airy edge. The PNG is removed
  // from this layer afterwards, so soil never washes over the painted foundation.
  for (let i = 0; i < 4; i++) {
    const phase = noise(variant * 91 + i * 7);
    const dx = (phase - .5) * s * (bridge ? 3 : 6), dy = (.2 + noise(i + variant * 13)) * s * 1.25;
    dab(ctx, x + dx, y + dy, s * (bridge ? 2.6 : 3.4 + phase * 1.5), s * (1.15 + phase * .7),
      stone ? "114,106,69" : "100,84,41", .16);
    if (!bridge) dab(ctx, x + dx - s, y + dy + s * .3, s * (1.5 + phase), s * .8, "102,121,39", .14);
  }
  // Ground flecks share the map's larger, low-contrast grain instead of a line.
  for (let i = 0; i < 8; i++) {
    const dx = (noise(i * 3 + variant * 47) - .5) * s * 8;
    const dy = noise(i * 5 + variant * 17) * s * 2.5;
    const radius = s * (.1 + noise(i + variant) * .16);
    ctx.fillStyle = i % 3 ? "rgba(106,96,49,.25)" : "rgba(187,164,85,.27)";
    ctx.beginPath(); ctx.ellipse(x + dx, y + dy, radius * 1.5, radius * .65, -.3, 0, Math.PI * 2); ctx.fill();
  }
}

function grass(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, variant: number) {
  dab(ctx, x + s * .5, y + s * .35, s * 2.2, s * .7, "32,45,23", .37);
  for (let blade = 0; blade < 3; blade++) {
    const lean = (blade - 1) * s * (.82 + variant * .2), height = s * (1.25 + noise(blade + variant * 31) * .85);
    const base = x + (blade - 1) * s * .3;
    const tint = ctx.createLinearGradient(x, y - height, x, y + s * .2);
    tint.addColorStop(0, ["#698032", "#83913e", "#708833"][blade]);
    tint.addColorStop(.55, "#60772f"); tint.addColorStop(1, "#3f5627"); ctx.fillStyle = tint;
    ctx.beginPath(); ctx.moveTo(base - s * .32, y + s * .12);
    ctx.quadraticCurveTo(base + lean * .4, y - height * .6, x + lean, y - height);
    ctx.quadraticCurveTo(base + lean * .55 + s * .52, y - height * .25, base + s * .4, y + s * .16);
    ctx.closePath(); ctx.fill();
  }
}

function pebble(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, variant: number) {
  dab(ctx, x + s * .8, y + s * .6, s * 2, s * .66, "29,40,25", .34);
  // Broad lit top, olive stone side and a modest seam match the background rocks.
  ctx.fillStyle = "#646a48"; ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x - s * .65, y - s * .74);
  ctx.lineTo(x + s * .5, y - s * (.85 + variant * .35)); ctx.lineTo(x + s * 1.25, y - s * .15);
  ctx.lineTo(x + s * .76, y + s * .62); ctx.lineTo(x - s * .55, y + s * .46); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#a1a276"; ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x - s * .65, y - s * .74);
  ctx.lineTo(x + s * .5, y - s * (.85 + variant * .35)); ctx.lineTo(x + s * .72, y - s * .13);
  ctx.lineTo(x - s * .1, y + s * .12); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(216,205,147,.57)"; ctx.lineWidth = s * .19;
  ctx.beginPath(); ctx.moveTo(x - s * .65, y - s * .6); ctx.lineTo(x + s * .4, y - s * (.76 + variant * .3)); ctx.stroke();
}

function chips(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, variant: number) {
  for (let i = 0; i < 3; i++) {
    const px = x + (i - 1) * s * 1.2, py = y + (i % 2) * s * .8, length = s * (1.25 + noise(i + variant * 19));
    dab(ctx, px + s * .5, py + s * .3, length * 1.1, s * .42, "42,43,22", .3);
    ctx.save(); ctx.translate(px, py); ctx.rotate((noise(i * 7 + variant) - .5) * .9);
    ctx.fillStyle = "#796333"; ctx.beginPath(); ctx.moveTo(-length, -s * .16); ctx.lineTo(length, -s * .38);
    ctx.lineTo(length * .75, s * .37); ctx.lineTo(-length * .84, s * .24); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(191,156,74,.83)"; ctx.lineWidth = s * .24;
    ctx.beginPath(); ctx.moveTo(-length * .8, -s * .1); ctx.lineTo(length * .8, -s * .23); ctx.stroke(); ctx.restore();
  }
}

function waterMask(ctx: CanvasRenderingContext2D, scene: FixedWorldScene) {
  const polygon = (points: WorldPoint[]) => {
    if (!points.length) return;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath(); ctx.fill();
  };
  ctx.fillStyle = "#000";
  for (const surface of scene.water?.surfaces ?? []) polygon(surface.points);
  ctx.globalCompositeOperation = "destination-out";
  for (const exclusion of scene.water?.exclusions ?? []) polygon(exclusion.points);
}

function groundTexture(scene: FixedWorldScene, site: FixedSite, image: HTMLImageElement): GroundTexture | null {
  let bySite = textures.get(scene);
  if (!bySite) { bySite = new WeakMap(); textures.set(scene, bySite); }
  let byImage = bySite.get(site);
  if (!byImage) { byImage = new WeakMap(); bySite.set(site, byImage); }
  if (byImage.has(image)) return byImage.get(image) ?? null;
  let texture: GroundTexture | null = null;
  const marks = siteGroundMarks(scene, site, artworkBase(image));
  if (marks.length && typeof document !== "undefined") {
    const padding = 24, bounds = { x: site.bounds.x - padding, y: site.bounds.y - padding,
      width: site.bounds.width + padding * 2, height: site.bounds.height + padding * 2 };
    const scale = Math.min(3, 640 / Math.max(bounds.width, bounds.height));
    const surface = () => {
      const layer = document.createElement("canvas"); layer.width = Math.max(1, Math.ceil(bounds.width * scale));
      layer.height = Math.max(1, Math.ceil(bounds.height * scale)); return layer;
    };
    const canvas = surface(), mask = surface(), ctx = canvas.getContext("2d"), maskCtx = mask.getContext("2d");
    if (ctx && maskCtx) {
      const world = (target: CanvasRenderingContext2D) => { target.scale(scale, scale); target.translate(-bounds.x, -bounds.y); };
      const stone = site.id === "quarry" || site.id === "lighthouse", bridge = site.id === "bridge";
      ctx.save(); world(ctx);
      for (const mark of marks) groundBed(ctx, mark, stone, bridge);
      ctx.restore();
      maskCtx.save(); world(maskCtx); drawSiteImage(maskCtx, site, image); maskCtx.restore();
      // Identity-space subtraction: soil is visually behind the PNG even though
      // this cached composite is drawn after it. Only small plants cross the foot.
      ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.save(); world(ctx);
      for (const mark of marks) {
        const { x, y, size: s, variant, kind } = mark;
        if (kind === "grass") grass(ctx, x, y, s * .82, variant);
        else if (kind === "chip") { chips(ctx, x, y + s * .45, s * .88, variant); grass(ctx, x - s * 2.2, y, s * .48, variant); }
        else {
          pebble(ctx, x, y + s * .2, s * .95, variant);
          pebble(ctx, x + s * 2, y + s * .75, s * .5, 1 - variant);
          grass(ctx, x - s * 1.8, y, s * .44, variant);
        }
      }
      ctx.restore();
      if (scene.water?.surfaces.length) {
        maskCtx.clearRect(0, 0, mask.width, mask.height);
        maskCtx.save(); world(maskCtx); waterMask(maskCtx, scene); maskCtx.restore();
        ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(mask, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      texture = { canvas, bounds };
    }
  }
  byImage.set(image, texture); return texture;
}

/** Cached groups belong above the foundation's lowest pixels and below actors. */
export function drawBuildingGroundDetails(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, site: FixedSite, image: HTMLImageElement) {
  if (site.id === "bridge" && !scene.water?.surfaces.length) return;
  const texture = groundTexture(scene, site, image);
  if (!texture) return;
  const { bounds } = texture;
  ctx.drawImage(texture.canvas, bounds.x, bounds.y, bounds.width, bounds.height);
}
