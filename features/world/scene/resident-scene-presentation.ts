import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ResidentHomeIndicator } from "@/features/world/characters/resident-home-effects";
import type { LopukhWoodpileFrame } from "@/features/world/characters/lopukh/lopukh-woodpile-painter";

/** Read-only presentation of the same indoor states used by occupancy/hits. */
export function residentScenePresentation(state: ForestSessionState, scene: FixedWorldScene) {
  const homes: ResidentHomeIndicator[] = [];
  const addHome = (id: ResidentHomeIndicator["id"], siteId: string) => {
    const site = scene.sites.find(site => site.id === siteId);
    if (!site) return;
    const anchor = scene.effectAnchors?.find(anchor => anchor.effect === "resident-home" && anchor.residentId === id
      && anchor.when.siteId === siteId);
    homes.push({ id, position: { ...(anchor?.position ?? site.doorway ?? site.entry) }, elapsed: state.elapsed,
      ...(anchor ? { size: anchor.size, centered: true } : {}) });
  };
  if (state.pleskMind?.home.phase === "inside") addHome("plesk", "plesk-shop");
  for (const id of ["lopukh", "kamneshmyg", "leaftail"] as const) {
    const mind = state.villagers?.residents[id];
    if (mind?.available && mind.doorPhase === "inside" && !mind.job)
      addHome(id, id === "lopukh" ? "lopukh-home" : id === "kamneshmyg" ? "quarry" : "leaftail-caravan");
  }
  const woodwork = state.villagers?.residents.lopukh.woodwork;
  const deliveries = woodwork?.deliveries ?? (woodwork?.lastDelivery ? [woodwork.lastDelivery] : []);
  const woodpiles: LopukhWoodpileFrame[] = [];
  for (const delivery of deliveries.slice(-3)) {
    // Only genuinely colocated drops stack. Rotating delivery targets and an
    // occupied-yard fallback never drag already delivered logs to new feet.
    const pile = woodpiles.find(pile => pile.position.x === delivery.position.x && pile.position.y === delivery.position.y);
    if (pile) pile.deliveries++;
    else woodpiles.push({ position: { ...delivery.position }, deliveries: 1 });
  }
  return { homes, window: null, woodpiles };
}
