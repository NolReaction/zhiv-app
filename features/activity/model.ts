import { z } from "zod";
export const ACTIVITY_IDLE_MS = 5 * 60_000;
export const ACTIVITY_HEARTBEAT_MS = 30_000;
export const ACTIVITY_LEASE_MS = 90_000;
export const presenceCommandSchema = z.object({
  kind: z.enum(["resume", "heartbeat", "suspend"]),
  presenceId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), sequence: z.number().int().nonnegative().safe(), active: z.boolean(),
}).strict();
export const presenceViewSchema = z.object({
  presenceId: z.string().uuid(), status: z.enum(["active", "idle", "disconnected", "suspended"]),
  serverNow: z.string().datetime(), idleExpiresAt: z.string().datetime().nullable(), leaseExpiresAt: z.string().datetime().nullable(),
  onlineTodaySeconds: z.number().nonnegative(),
});
export type PresenceCommand = z.infer<typeof presenceCommandSchema>;
export type PresenceView = z.infer<typeof presenceViewSchema>;
