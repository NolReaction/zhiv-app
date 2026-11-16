import type { BoatChallenge, BoatPreparedCast } from "./boat-model";

/** A ticket fixes the physics. Releasing the rod starts its clock, even without a connection. */
export function startPreparedBoatCast(ticket: BoatPreparedCast, startedAtMs: number, fishingUntil: string): BoatChallenge | null {
  const biteAt = startedAtMs + ticket.biteDelayMs;
  const expiresAt = Math.min(startedAtMs + 120_000, Date.parse(fishingUntil));
  if (!Number.isFinite(biteAt) || !Number.isFinite(expiresAt) || biteAt + ticket.tickMs >= expiresAt) return null;
  return { id: ticket.id, rulesVersion: ticket.rulesVersion, seed: ticket.seed, tickMs: ticket.tickMs, maxTicks: ticket.maxTicks,
    difficulty: ticket.difficulty, resistance: ticket.resistance, zoneWidth: ticket.zoneWidth, motorResponse: ticket.motorResponse,
    hullDamping: ticket.hullDamping, fishRarity: ticket.fishRarity, startedAt: new Date(startedAtMs).toISOString(), biteAt: new Date(biteAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}
