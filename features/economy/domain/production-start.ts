/** A transient local input receipt, never a server success or a cached reward.
 * Created only when a new production intent is accepted, not during delivery. */
export type ProductionStart = Readonly<{ id: string; ownerPublicId: string; occurredAt: number }>;
