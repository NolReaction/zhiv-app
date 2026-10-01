import { siteContactArea } from "./grounding";
import { previewPointInPolygon } from "./tiled/preview-state";
import { siteImagePoint } from "./tiled/site-image";
import type { FixedSite, FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

type BaseSample = { u: number; v: number };
type GroundMark = WorldPoint & { size: number; variant: number; kind: "grass" | "stone" | "chip" };
type GroundTexture = { canvas: HTMLCanvasElement; bounds: WorldBounds };
const bases = new WeakMap<HTMLImageElement, BaseSample[]>();
const textures = new WeakMap<FixedWorldScene, WeakMap<FixedSite, WeakMap<HTMLImageElement, GroundTexture | null>>>();
const noise = (value: number) => { const result = Math.sin(value * 127.1 + 53.7) * 43758.5453; return result - Math.floor(result); };

/** Read a tiny alpha copy once. A collision contour is a navigation boundary,
 * never the visible outline of the building's roots or stones. */
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
      const step = Math.max(2, Math.ceil(canvas.width / 26));
      for (let x = step; x < canvas.width - step; x += step) {
        for (let y = canvas.height - 1; y >= 0; y--) {
          if (data[(y * canvas.width + x) * 4 + 3] < 128) continue;
          samples.push({ u: (x + .5) / canvas.width, v: (y + .5) / canvas.height }); break;
        }
      }
    }
  } catch { /* Missing alpha is decorative only: never fall back to collision ink. */ }
  bases.set(image, samples);
  return samples;
}

/** Sparse joins only at actual opaque feet. No painted island or bridge fill. */
export function siteGroundMarks(scene: Pick<FixedWorldScene, "water">, site: FixedSite, samples: readonly BaseSample[]): GroundMark[] {
  if (site.id === "bridge") return [];
  const area = siteContactArea(site);
  if (!area) return [];
  const size = Math.max(.45, Math.min(1.5, Math.min(site.bounds.width, site.bounds.height) / 120));
  return samples.flatMap((sample, index): GroundMark[] => {
    const point = siteImagePoint(site, sample.u, sample.v), variant = noise(index + site.id.length * 9);
    if (variant < .22 || point.y < area.y || point.y > area.y + area.height + size * 2
      || point.x < area.x - size || point.x > area.x + area.width + size
      || Math.hypot(point.x - site.entry.x, point.y - site.entry.y) < 8 * size
      || site.doorway && Math.hypot(point.x - site.doorway.x, point.y - site.doorway.y) < 6 * size) return [];
    const wet = scene.water?.surfaces.some(surface => previewPointInPolygon(point, surface.points))
      && !scene.water?.exclusions.some(exclusion => previewPointInPolygon(point, exclusion.points));
    if (wet) return [];
    const kind = site.id === "quarry" || site.id === "lighthouse" ? (variant < .7 ? "stone" : "grass")
      : site.id === "workshop" && variant < .55 ? "chip" : "grass";
    return [{ ...point, size: size * (.65 + variant * .65), variant, kind }];
  });
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
    const padding = 4, bounds = { x: site.bounds.x - padding, y: site.bounds.y - padding,
      width: site.bounds.width + padding * 2, height: site.bounds.height + padding * 2 };
    const scale = Math.min(3, 512 / Math.max(bounds.width, bounds.height)), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale)); canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(scale, scale); ctx.translate(-bounds.x, -bounds.y);
      for (const mark of marks) {
        const { x, y, size: s, variant, kind } = mark;
        ctx.fillStyle = "rgba(41,50,25,.17)";
        ctx.beginPath(); ctx.ellipse(x + s * .35, y + s * .25, s * 1.2, s * .34, 0, 0, Math.PI * 2); ctx.fill();
        if (kind === "grass") {
          // Two low, asymmetric blades overlap only the very foot of the PNG.
          ctx.fillStyle = variant > .7 ? "rgba(106,126,43,.76)" : "rgba(73,99,40,.68)";
          ctx.beginPath(); ctx.moveTo(x - s, y + s * .3); ctx.lineTo(x - s * .8, y - s * 1.5);
          ctx.lineTo(x + s * .1, y - s * .15); ctx.lineTo(x + s * 1.35, y - s * 1.05);
          ctx.lineTo(x + s * .9, y + s * .4); ctx.closePath(); ctx.fill();
        } else {
          ctx.fillStyle = kind === "chip" ? "rgba(115,89,47,.68)" : "rgba(115,117,85,.74)";
          ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x - s * .3, y - s * .6);
          ctx.lineTo(x + s * 1.4, y - s * .15); ctx.lineTo(x + s * .7, y + s * .6); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = kind === "chip" ? "rgba(190,158,80,.63)" : "rgba(192,185,130,.68)";
          ctx.lineWidth = s * .3; ctx.beginPath(); ctx.moveTo(x - s * .5, y - s * .14); ctx.lineTo(x + s * .7, y - s * .12); ctx.stroke();
        }
      }
      texture = { canvas, bounds };
    }
  }
  byImage.set(image, texture); return texture;
}

/** Below the actor and above the building's feet; baked once for each geometry. */
export function drawBuildingGroundDetails(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, site: FixedSite, image: HTMLImageElement) {
  // The broken bridge has no ground across its water gap, even without a water mask.
  if (site.id === "bridge") return;
  const texture = groundTexture(scene, site, image);
  if (!texture) return;
  const { bounds } = texture;
  ctx.drawImage(texture.canvas, bounds.x, bounds.y, bounds.width, bounds.height);
}
