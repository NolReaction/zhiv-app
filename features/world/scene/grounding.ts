import { pixelSprite, pixelSpriteContact, type PixelDirection, type PixelPose, type PixelRigOptions } from "@/features/mochlik/pixel-sprite";
import type { FixedSite, WorldBounds } from "@/features/world/tiled/types";
import { drawSiteImage } from "@/features/world/tiled/site-image";
import { worldArtworkMipCache } from "./artwork-mip-cache";

export const HERO_SOURCE_SIZE = 48;
export const HERO_SOURCE_FEET_Y = 45;
type SpriteContact = { bottom: number; left: number; right: number };
const spriteContacts = new WeakMap<HTMLCanvasElement, SpriteContact | null>();

/** Source-space contact follows the opaque paws, including alternating walk frames. */
export function heroSpriteContact(sprite: HTMLCanvasElement, pose: PixelPose, frame: number): SpriteContact {
  const generated = pixelSpriteContact(sprite);
  if (generated) return generated;
  if (!spriteContacts.has(sprite)) {
    let contact: SpriteContact | null = null;
    try {
      const pixels = sprite.getContext("2d")?.getImageData(0, 0, HERO_SOURCE_SIZE, HERO_SOURCE_SIZE).data;
      if (pixels) {
        let bottom = 0;
        for (let y = HERO_SOURCE_SIZE - 1; y >= 0 && !bottom; y--) {
          for (let x = 0; x < HERO_SOURCE_SIZE; x++) {
            if (pixels[(y * HERO_SOURCE_SIZE + x) * 4 + 3]) { bottom = y + 1; break; }
          }
        }
        if (bottom) {
          let left = HERO_SOURCE_SIZE, right = 0;
          for (let y = Math.max(0, bottom - 3); y < bottom; y++) {
            for (let x = 0; x < HERO_SOURCE_SIZE; x++) {
              if (pixels[(y * HERO_SOURCE_SIZE + x) * 4 + 3]) { left = Math.min(left, x); right = Math.max(right, x + 1); }
            }
          }
          contact = { bottom, left, right };
        }
      }
    } catch { /* Unreadable canvases retain the rig's known contact instead. */ }
    spriteContacts.set(sprite, contact);
  }
  const walking = pose === "walk" || pose === "carry" || pose === "fishing-walk";
  return spriteContacts.get(sprite) ?? {
    bottom: HERO_SOURCE_FEET_Y + (walking && Number.isFinite(frame) && Math.abs(Math.trunc(frame) % 2) === 1 ? 1 : 0),
    left: 12, right: 37,
  };
}

export function drawGroundedHero(ctx: CanvasRenderingContext2D, actor: {
  x: number; y: number; size: number; pose: PixelPose; direction: PixelDirection; frame: number;
  appearance?: { palette: string; head: string | null; neck: string | null }; breathe?: number; shadow?: boolean; lift?: number; compression?: number;
  rig?: PixelRigOptions;
}) {
  if (![actor.x, actor.y, actor.size].every(Number.isFinite) || actor.size <= 0) return;
  const sprite = pixelSprite(actor.pose, actor.direction, actor.frame, actor.appearance, actor.rig);
  const compression = Number.isFinite(actor.compression) ? Math.max(0, Math.min(1, actor.compression!)) : 0;
  const width = actor.size * (1 - .14 * compression);
  const contact = heroSpriteContact(sprite, actor.pose, actor.frame), scale = width / HERO_SOURCE_SIZE;
  const footWidth = (contact.right - contact.left) * scale;
  const footX = actor.x + ((contact.left + contact.right) / 2 - HERO_SOURCE_SIZE / 2) * scale;
  const breathe = Number.isFinite(actor.breathe) ? Math.max(-.008, Math.min(.008, actor.breathe!)) : 0;
  const height = actor.size * (1 + breathe) * (1 - .35 * compression);
  const lift = Number.isFinite(actor.lift) ? Math.max(0, Math.min(actor.size, actor.lift!)) : 0;
  ctx.save();
  if (actor.shadow !== false) {
    const shadowScale = 1 - lift / actor.size * .4;
    ctx.save(); ctx.globalAlpha *= 1 - lift / actor.size * .65;
    ctx.fillStyle = "rgba(24,38,25,.045)";
    ctx.beginPath(); ctx.ellipse(footX, actor.y + actor.size * .01, footWidth * .54 * shadowScale, actor.size * .04, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(24,38,25,.16)";
    ctx.beginPath(); ctx.ellipse(footX, actor.y, footWidth * .44 * shadowScale, actor.size * .024, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, actor.x - width / 2, actor.y - lift - contact.bottom / HERO_SOURCE_SIZE * height, width, height);
  ctx.restore();
}

function intersect(a: WorldBounds, b: WorldBounds): WorldBounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function collisionBounds(site: FixedSite): WorldBounds | null {
  if (site.collision.length < 3 || !site.collision.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const xs = site.collision.map(point => point.x), ys = site.collision.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return intersect(site.bounds, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
}

/** Authored collision defines the foundation; unmarked artwork uses its anchor. */
export function siteContactArea(site: FixedSite): WorldBounds | null {
  if (!Object.values(site.bounds).every(Number.isFinite) || site.bounds.width <= 0 || site.bounds.height <= 0) return null;
  const footprint = collisionBounds(site);
  if (footprint) return { ...footprint, y: footprint.y + footprint.height * .28, height: footprint.height * .72 };
  const { bounds, anchor } = site, width = bounds.width * .44, height = bounds.height * .08;
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width, Number.isFinite(anchor.x) ? anchor.x : bounds.x + bounds.width / 2));
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height, Number.isFinite(anchor.y) ? anchor.y : bounds.y + bounds.height * .92));
  return intersect(bounds, { x: x - width / 2, y: y - height / 2, width, height });
}

type SiteShadow = { contact: HTMLCanvasElement; diffuse: HTMLCanvasElement; bounds: WorldBounds };
const siteShadows = new WeakMap<HTMLImageElement, WeakMap<FixedSite, SiteShadow | null>>();

function siteShadow(site: FixedSite, image: HTMLImageElement): SiteShadow | null {
  let bySite = siteShadows.get(image);
  if (!bySite) { bySite = new WeakMap(); siteShadows.set(image, bySite); }
  if (bySite.has(site)) return bySite.get(site) ?? null;
  const area = siteContactArea(site), { bounds } = site;
  let shadow: SiteShadow | null = null;
  if (area && bounds.width > 0 && bounds.height > 0 && typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    const scale = Math.min(2, 512 / Math.max(bounds.width, bounds.height));
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.save();
      ctx.scale(canvas.width / bounds.width, canvas.height / bounds.height);
      ctx.translate(-bounds.x, -bounds.y);
      if (collisionBounds(site)) {
        ctx.beginPath();
        site.collision.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.closePath(); ctx.clip();
      } else {
        ctx.beginPath();
        ctx.ellipse(area.x + area.width / 2, area.y + area.height / 2, area.width / 2, area.height / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.beginPath(); ctx.rect(area.x, area.y, area.width, area.height); ctx.clip();
      drawSiteImage(ctx, site, image);
      ctx.restore();
      // Geometry is already encoded in the painted alpha. Tint the complete
      // bitmap in identity space, without carrying world-space clips/transforms
      // into compositing (which differs between Canvas implementations).
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#22231e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Bake blur once per artwork/geometry. Padding prevents a rectangular blur cutoff.
      const padding = Math.min(16, Math.max(bounds.width, bounds.height) * .09);
      const shadowBounds = { x: bounds.x - padding, y: bounds.y - padding,
        width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
      const shadowScale = Math.min(2, 512 / Math.max(shadowBounds.width, shadowBounds.height));
      const contact = document.createElement("canvas"), diffuse = document.createElement("canvas");
      for (const layer of [contact, diffuse]) {
        layer.width = Math.max(1, Math.ceil(shadowBounds.width * shadowScale));
        layer.height = Math.max(1, Math.ceil(shadowBounds.height * shadowScale));
      }
      const contactCtx = contact.getContext("2d"), diffuseCtx = diffuse.getContext("2d");
      if (contactCtx && diffuseCtx) {
        const paint = (target: CanvasRenderingContext2D, alpha: number, blur: number,
          dx: number, dy: number, widthScale = 1, heightScale = 1) => {
          target.globalAlpha = alpha;
          target.filter = `blur(${blur * shadowScale}px)`;
          // Compress toward the foundation, never project a standing duplicate of the house.
          const bottom = area.y + area.height - bounds.y;
          target.drawImage(canvas,
            (padding + dx + bounds.width * (1 - widthScale) / 2) * shadowScale,
            (padding + dy + bottom * (1 - heightScale)) * shadowScale,
            bounds.width * widthScale * shadowScale, bounds.height * heightScale * shadowScale);
        };
        const size = Math.min(bounds.width, bounds.height);
        const bridge = site.id === "bridge";
        paint(contactCtx, bridge ? .24 : .32, Math.min(1.2, size * (bridge ? .003 : .006)), 0, size * .008);
        // A broken bridge keeps two separate short shadows. Do not stretch its
        // planks into a dark platform across the river or fill the central gap.
        paint(diffuseCtx, bridge ? .07 : .14, Math.min(5, size * (bridge ? .008 : .026)), 0, size * .012, bridge ? 1 : 1.025);
        paint(diffuseCtx, bridge ? .1 : .23, Math.min(4, size * (bridge ? .005 : .022)),
          size * (bridge ? .016 : .045), size * (bridge ? .018 : .029), 1, bridge ? .98 : .85);
        shadow = { contact, diffuse, bounds: shadowBounds };
      }
    }
  }
  bySite.set(site, shadow);
  return shadow;
}

/** Draw immediately under the original image; no colored rectangle or art mutation. */
export function drawSiteGrounding(ctx: CanvasRenderingContext2D, site: FixedSite, image: HTMLImageElement, night = 0) {
  const shadow = siteShadow(site, image);
  if (!shadow) return;
  const { bounds } = shadow;
  const darkness = Number.isFinite(night) ? Math.max(0, Math.min(1, night)) : 0;
  ctx.save();
  const opacity = ctx.globalAlpha;
  ctx.globalAlpha = opacity * (1 - darkness * .58);
  ctx.drawImage(worldArtworkMipCache.image(ctx, shadow, shadow.diffuse), bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = opacity * (1 - darkness * .15);
  ctx.drawImage(worldArtworkMipCache.image(ctx, shadow, shadow.contact), bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
