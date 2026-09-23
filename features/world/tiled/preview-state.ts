import type { FixedSite, FixedWorldScene, PreviewLevels, WorldPoint } from "./types";

/** Preview state contains levels only. Coordinates always belong to the authored scene. */
export function initialPreviewLevels(scene: FixedWorldScene): PreviewLevels {
  return Object.fromEntries(scene.sites.map(site => [site.id, site.initialLevel]));
}

export function previewSiteVisual(site: FixedSite, levels: PreviewLevels) {
  return site.states.find(state => state.level === levels[site.id])
    ?? site.states.find(state => state.level === site.initialLevel)
    ?? site.states[0];
}

export function setPreviewLevel(scene: FixedWorldScene, levels: PreviewLevels, siteId: string, level: number): PreviewLevels {
  const site = scene.sites.find(item => item.id === siteId);
  if (!site?.states.some(state => state.level === level) || levels[siteId] === level) return levels;
  return { ...levels, [siteId]: level };
}

export function upgradePreviewSite(scene: FixedWorldScene, levels: PreviewLevels, siteId: string): PreviewLevels {
  const site = scene.sites.find(item => item.id === siteId);
  if (!site) return levels;
  const current = previewSiteVisual(site, levels);
  const next = site.states.filter(state => state.level > current.level).sort((a, b) => a.level - b.level)[0];
  return next ? setPreviewLevel(scene, levels, siteId, next.level) : levels;
}

/** Includes polygon boundaries so an authored edge stays a reliable touch target. */
export function previewPointInPolygon(point: WorldPoint, polygon: readonly WorldPoint[]) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
      && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function previewSiteAt(scene: FixedWorldScene, point: WorldPoint): FixedSite | null {
  return [...scene.sites].reverse()
    .find(site => previewPointInPolygon(point, site.hitArea)) ?? null;
}
