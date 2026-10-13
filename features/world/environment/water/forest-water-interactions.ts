import type { FishingPropFrame } from "@/features/world/activities/fishing/fishing-props";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { WaterSplashFrame } from "./forest-water-life";

export type ForestWaterFisher = {
  key: string;
  /** A stable job/cast ID, or the resident's current fishing decision. */
  token: string | number | null;
  frame: FishingPropFrame | null;
  visible: boolean;
};
export type ForestWaterInteractionSnapshot = {
  epoch: object;
  scene: FixedWorldScene;
  elapsed: number;
  reducedMotion: boolean;
  /** Pass the displayed frames so DEV rehearsals share the real contact path. */
  fishing: readonly ForestWaterFisher[];
  splashes?: readonly WaterSplashFrame[];
};
export type ForestWaterImpulse = WorldPoint & {
  id: string;
  kind: "cast" | "bite" | "fish";
  strength: number;
  radius: number;
};
export const FOREST_WATER_INTERACTION_LIMITS = {
  maxGap: .25, fishers: 16, splashes: 12, splashImpulses: 4, newbornPhase: .12,
} as const;
type FisherContact = {
  token: string | number;
  point: WorldPoint;
  active: boolean;
  contact: "air" | "water";
  landed: boolean;
  phase: number;
  dip: string | null;
  pulse: number;
  large: boolean;
};
type Observation = {
  epoch: object;
  scene: FixedWorldScene;
  elapsed: number;
  active: boolean;
  fishers: Map<string, FisherContact>;
  splashes: Set<string>;
};
const pointIsFinite = (point: WorldPoint | undefined): point is WorldPoint => Boolean(point
  && Number.isFinite(point.x) && Number.isFinite(point.y));

function fishingContact(fisher: ForestWaterFisher, active: boolean, before?: FisherContact): FisherContact | null {
  const frame = fisher.frame;
  if (fisher.token === null || !frame || frame.settling || !pointIsFinite(frame.waterTarget)
    || !Number.isFinite(frame.phase) || !["cast", "fish", "bite"].includes(frame.action)) return null;
  const contact = frame.action === "cast" && frame.phase < 1 ? "air" : "water";
  const phase = Math.max(0, Math.min(1, frame.phase)), large = frame.outcome === "large";
  const dip = frame.action === "bite" ? `bite:${large ? "large" : "small"}`
    : frame.action === "fish" && frame.variation === "nibble" ? "nibble" : null;
  // The shared tackle dips at maxima of (1-cos(phase*TAU*cycles)).
  const pulse = dip ? Math.floor(phase * (frame.action === "bite" && large ? 4 : 3) + .5) : 0;
  return { token: fisher.token, point: { ...frame.waterTarget }, active: active && fisher.visible,
    contact, phase, dip, pulse, large,
    landed: contact === "water" || Boolean(before?.token === fisher.token && before.landed) };
}

/** Session-owned contact observer. Call from the simulation owner, never paint
 * or audio: both cameras and muted sessions disturb the same water surface.
 * The caller advances rainfall in the dynamics core; this bridge adds only
 * genuine float contacts and the existing visible fish landing events. */
export function createForestWaterInteractionTracker() {
  let previous: Observation | null = null, sequence = 0;
  return {
    /** Account/scene replacement or an explicit suspension seeds a fresh frame. */
    reset() { previous = null; },
    sample(snapshot: ForestWaterInteractionSnapshot, emit = true): ForestWaterImpulse[] {
      const before = previous;
      const active = emit && !snapshot.reducedMotion && Number.isFinite(snapshot.elapsed);
      const sameRun = Boolean(before && before.epoch === snapshot.epoch && before.scene === snapshot.scene
        && snapshot.elapsed >= before.elapsed
        && snapshot.elapsed - before.elapsed <= FOREST_WATER_INTERACTION_LIMITS.maxGap);
      const continuous = Boolean(active && before?.active && sameRun && snapshot.elapsed > before.elapsed);
      const current: Observation = { epoch: snapshot.epoch, scene: snapshot.scene,
        elapsed: snapshot.elapsed, active, fishers: new Map(), splashes: new Set() };
      const scaleValue = Math.min(snapshot.scene.width, snapshot.scene.height) / 1254;
      const scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
      const impulses: ForestWaterImpulse[] = [];
      const add = (kind: ForestWaterImpulse["kind"], key: string, point: WorldPoint, strength: number, radius: number) => {
        impulses.push({ id: `${kind}:${key}:${++sequence}`, kind, x: point.x, y: point.y, strength, radius: radius * scale });
      };
      for (const fisher of snapshot.fishing.slice(0, FOREST_WATER_INTERACTION_LIMITS.fishers)) {
        if (current.fishers.has(fisher.key)) continue;
        const prior = sameRun ? before?.fishers.get(fisher.key) : undefined;
        const contact = fishingContact(fisher, active, prior);
        if (!contact) continue;
        current.fishers.set(fisher.key, contact);
        if (!continuous || !contact.active || !prior?.active || prior.token !== contact.token) continue;
        if (contact.contact === "water" && prior.contact === "air" && !prior.landed) {
          add("cast", `${fisher.key}:${contact.token}`, contact.point, 1.6, 12);
        } else if (contact.contact === "water" && prior.contact === "water" && contact.dip
          && contact.dip === prior.dip && contact.phase >= prior.phase && contact.phase - prior.phase <= .25
          && contact.pulse > prior.pulse) {
          add("bite", `${fisher.key}:${contact.token}:${contact.pulse}`, contact.point, contact.large ? .22 : .15, 6);
        }
      }
      let splashCount = 0;
      for (const splash of (snapshot.splashes ?? []).slice(0, FOREST_WATER_INTERACTION_LIMITS.splashes)) {
        if (!pointIsFinite(splash) || !Number.isFinite(splash.phase) || current.splashes.has(splash.id)) continue;
        current.splashes.add(splash.id);
        // Consume all current IDs, including contacts omitted by the bounded
        // frame budget. Resuming or moving a camera never drains a backlog.
        if (!continuous || before?.splashes.has(splash.id) || splash.phase < 0
          || splash.phase > FOREST_WATER_INTERACTION_LIMITS.newbornPhase
          || splashCount >= FOREST_WATER_INTERACTION_LIMITS.splashImpulses) continue;
        add("fish", splash.id, splash, .5, 8);
        splashCount++;
      }
      previous = current;
      return impulses;
    },
  };
}
