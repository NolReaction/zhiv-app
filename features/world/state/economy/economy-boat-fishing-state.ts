/** Public timing only. The map cannot reveal fish, cast outcomes or grant cargo. */
export type EconomySceneBoatFishing = {
  level: number;
  upgrades?: readonly string[];
  artifacts?: readonly string[];
  voyage?: {
    id: string; departedAt: string; arrivesAt: string; fishingUntil: string;
    returnStartedAt?: string | null; returnsAt?: string | null; inboundSeconds: number;
  } | null;
};
export type EconomySceneBoatPhase = "idle" | "outbound" | "fishing" | "inbound" | "ready";
export function economySceneBoatTiming(boat: EconomySceneBoatFishing | null | undefined, now: number) {
  const voyage = boat?.voyage;
  if (!voyage) return { phase: "idle" as const, departedAt: 0, arrivesAt: 0, returnStartedAt: 0, returnsAt: 0 };
  const departedAt = Date.parse(voyage.departedAt), arrivesAt = Date.parse(voyage.arrivesAt);
  const returnStartedAt = Date.parse(voyage.returnStartedAt ?? voyage.fishingUntil);
  const returnsAt = voyage.returnsAt ? Date.parse(voyage.returnsAt) : returnStartedAt + voyage.inboundSeconds * 1000;
  const phase: EconomySceneBoatPhase = now < arrivesAt ? "outbound" : now < returnStartedAt ? "fishing" : now < returnsAt ? "inbound" : "ready";
  return { phase, departedAt, arrivesAt, returnStartedAt, returnsAt };
}
