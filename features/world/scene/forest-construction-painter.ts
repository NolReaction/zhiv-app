import type { FixedWorldScene, WorldBounds, WorldConstructionSite, WorldPoint } from "@/features/world/tiled/types";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";

type Stake = { kind: "stake"; position: WorldPoint; height: number };
type Rope = { kind: "rope"; from: WorldPoint; to: WorldPoint };
type Materials = { kind: "materials"; position: WorldPoint };
export type ForestConstructionProp = (Stake | Rope | Materials) & { y: number; bounds: WorldBounds };
type PreparedSite = { siteId: string; props: readonly ForestConstructionProp[] };
const prepared = new WeakMap<WorldConstructionSite[], readonly PreparedSite[]>();
const activeJobs = new WeakMap<EconomySceneConstruction, { from: number; until: number; hosts: ReadonlySet<string>;
  geometry: WeakMap<WorldConstructionSite[], readonly ForestConstructionProp[]> }>();
const empty: readonly ForestConstructionProp[] = [];
const hosts: Readonly<Record<string, string>> = {
  home: "home", warehouse: "home", workshop: "workshop", kiln: "workshop", woodlot: "lopukh-home",
  garden: "garden", dryer: "campfire", quarry: "quarry", bridge: "bridge", lighthouse: "lighthouse",
};

function prepare(sites: WorldConstructionSite[]): readonly PreparedSite[] {
  const cached = prepared.get(sites);
  if (cached) return cached;
  const result = sites.map(site => {
    const props: ForestConstructionProp[] = [], points: WorldPoint[] = [];
    // Bounded subdivisions retain the authored line and make every small prop
    // participate in the same foot-depth ordering as the moving residents.
    for (let i = 1; i < site.points.length; i++) {
      const a = site.points[i - 1], b = site.points[i];
      if (i === 1) points.push(a);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 18));
      for (let step = 1; step <= steps; step++) points.push({
        x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps,
      });
    }
    for (let i = 0; i < points.length; i++) {
      const position = points[i], height = i % 2 ? 9 : 10;
      props.push({ kind: "stake", position, height, y: position.y,
        bounds: { x: position.x - 2, y: position.y - height - 1, width: 9, height: height + 4 } });
      if (i) {
        const from = points[i - 1], to = position;
        props.push({ kind: "rope", from, to, y: (from.y + to.y) / 2,
          bounds: { x: Math.min(from.x, to.x) - 1, y: Math.min(from.y, to.y) - 8,
            width: Math.abs(to.x - from.x) + 2, height: Math.abs(to.y - from.y) + 10 } });
      }
    }
    if (site.materials && points.length) {
      const position = { x: points[0].x + 5, y: points[0].y + 3 };
      props.push({ kind: "materials", position, y: position.y,
        bounds: { x: position.x - 4, y: position.y - 7, width: 22, height: 11 } });
    }
    return { siteId: site.siteId, props };
  });
  prepared.set(sites, result);
  return result;
}

/** Read-only decoration from confirmed account jobs. Finishing a timer leaves
 * the props in place until the server removes the collected construction job. */
export function forestConstructionProps(scene: FixedWorldScene, snapshot: EconomySceneConstruction | null | undefined,
  now: number, ownerPublicId: string | undefined): readonly ForestConstructionProp[] {
  if (!scene.constructionSites?.length || !snapshot || !ownerPublicId || snapshot.ownerPublicId !== ownerPublicId
    || !Number.isFinite(now) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || snapshot.jobs.length > 100) return empty;
  let active = activeJobs.get(snapshot);
  if (!active || now < active.from || now >= active.until) {
    const selected = new Set<string>(); let until = Infinity;
    for (const job of snapshot.jobs) {
      const start = Date.parse(job.startedAt), finish = Date.parse(job.finishesAt);
      if (!job.id || !Number.isSafeInteger(job.targetLevel) || job.targetLevel < 1
        || !Number.isFinite(start) || !Number.isFinite(finish) || finish < start || !Object.hasOwn(hosts, job.stationId)) continue;
      if (start > now) { until = Math.min(until, start); continue; }
      selected.add(hosts[job.stationId]);
    }
    active = { from: now, until, hosts: selected, geometry: new WeakMap() }; activeJobs.set(snapshot, active);
  }
  if (!active.hosts.size) return empty;
  let props = active.geometry.get(scene.constructionSites);
  if (!props) {
    props = prepare(scene.constructionSites).filter(site => active.hosts.has(site.siteId)).flatMap(site => site.props);
    active.geometry.set(scene.constructionSites, props);
  }
  return props;
}

/** Small wooden stakes, a slack cord and a few boards; no image assets, motion,
 * collision, timers, rewards or additional offscreen canvas surfaces. */
export function drawForestConstructionProp(ctx: CanvasRenderingContext2D, prop: ForestConstructionProp) {
  ctx.save();
  if (prop.kind === "rope") {
    ctx.strokeStyle = "#a89163"; ctx.lineWidth = .9;
    ctx.beginPath(); ctx.moveTo(prop.from.x, prop.from.y - 6);
    ctx.quadraticCurveTo((prop.from.x + prop.to.x) / 2, (prop.from.y + prop.to.y) / 2 - 3.8, prop.to.x, prop.to.y - 6);
    ctx.stroke();
  } else if (prop.kind === "stake") {
    const { x, y } = prop.position, h = prop.height;
    ctx.fillStyle = "#16281d35"; ctx.beginPath(); ctx.ellipse(x + 2.3, y + 1, 4, 1.2, .1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#775537"; ctx.beginPath(); ctx.moveTo(x - 1.2, y); ctx.lineTo(x - 1.2, y - h + 1.5);
    ctx.lineTo(x, y - h); ctx.lineTo(x + 1.3, y - h + 1.5); ctx.lineTo(x + 1.3, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#b78b52"; ctx.fillRect(x - .8, y - h + 2, .75, h - 2);
    ctx.fillStyle = "#c8af7b"; ctx.fillRect(x - 1.8, y - 6.4, 3.5, 1);
  } else {
    const { x, y } = prop.position;
    ctx.fillStyle = "#17281d35"; ctx.beginPath(); ctx.ellipse(x + 6, y + 1.5, 9, 2, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const left = x + (i % 2) * 1.5, top = y - 2 - i * 1.4;
      ctx.fillStyle = i % 2 ? "#a47a45" : "#947040"; ctx.fillRect(left, top, 14, 1.8);
      ctx.fillStyle = "#c09a5b"; ctx.fillRect(left, top, 14, .55);
      ctx.fillStyle = "#695035"; ctx.fillRect(left + 12, top + .55, 2, 1.2);
    }
    ctx.strokeStyle = "#6c6040"; ctx.lineWidth = .7;
    for (const dx of [3, 10]) { ctx.beginPath(); ctx.moveTo(x + dx, y - 5); ctx.lineTo(x + dx + 1, y); ctx.stroke(); }
  }
  ctx.restore();
}
