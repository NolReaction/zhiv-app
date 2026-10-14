import type { ObjectCatalog } from "@/packages/engine/src/scene/contracts";
import { drawTree, drawShrub } from "./rendering/foliage";
import { drawRock, drawRuins, drawBridge, drawJetty } from "./rendering/props";

const sprite = { bounds: { x: -96, y: -172, width: 192, height: 192 }, scale: 1.5 };
function contactShadow(radius: number) {
  return { bounds: { x: -100, y: -40, width: 208, height: 80 }, scale: 2, draw(ctx: CanvasRenderingContext2D) {
    const shadow = ctx.createRadialGradient(18, 2, 4, 20, 3, radius);
    shadow.addColorStop(0, "#122b2490"); shadow.addColorStop(.6, "#142e2460"); shadow.addColorStop(1, "#142e2400");
    ctx.scale(1.2, .48); ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(20, 3, radius, 0, Math.PI * 2); ctx.fill();
  } };
}
function ellipseHit(rx: number, ry: number, centerY: number) { return (_: unknown, local: { x: number; y: number }) => (local.x / rx) ** 2 + ((local.y - centerY) / ry) ** 2 < 1; }
function propHit(bounds: { x: number; y: number; width: number }, maxY: number) { return (_: unknown, local: { x: number; y: number }) => local.x >= bounds.x && local.x <= bounds.x + bounds.width && local.y >= bounds.y && local.y <= maxY; }
export const FOREST_CATALOG: ObjectCatalog = Object.freeze({
  tree: { bounds: { x: -80, y: -158, width: 179, height: 190 }, shadowHeight: 160, folderId: "trees", sprite, contactShadow: contactShadow(61), hitTest: ellipseHit(66, 81, -69), draw: (ctx, object) => drawTree(ctx, object.variant) },
  shrub: { bounds: { x: -32, y: -45, width: 85, height: 61 }, shadowHeight: 44, folderId: "shrubs", sprite, contactShadow: contactShadow(22), hitTest: ellipseHit(30, 27, -20), draw: (ctx, object) => drawShrub(ctx, object.variant) },
  rock: { bounds: { x: -33, y: -36, width: 86, height: 52 }, shadowHeight: 24, folderId: "rocks", sprite, contactShadow: contactShadow(22), hitTest: ellipseHit(30, 21, -12), draw: (ctx, object) => drawRock(ctx, object.variant) },
  ruins: { bounds: { x: -75, y: -101, width: 198, height: 158 }, shadowHeight: 92, depthOffset: 20, folderId: "props", hitTest: propHit({ x: -75, y: -101, width: 198 }, 37), draw: ctx => drawRuins(ctx) },
  bridge: { bounds: { x: -67, y: -46, width: 144, height: 101 }, intrinsicAngle: .22, shadowHeight: 20, depthOffset: 31, folderId: "props", hitTest: propHit({ x: -67, y: -46, width: 144 }, 29), draw: ctx => drawBridge(ctx) },
  jetty: { bounds: { x: -9, y: -13, width: 145, height: 86 }, intrinsicAngle: .36, shadowHeight: 16, depthOffset: 70, folderId: "props", hitTest: propHit({ x: -9, y: -13, width: 145 }, 55), draw: ctx => drawJetty(ctx) },
  image: { bounds: object => ({ x: -(object.imageWidth ?? 0) / 2, y: -(object.imageHeight ?? 0), width: object.imageWidth ?? 0, height: object.imageHeight ?? 0 }), shadowHeight: 140, folderId: "images" },
});
