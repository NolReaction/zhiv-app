import { z } from "zod";

/** Shared wire contract for the cosmetic forest, independent of economy revisions. */
export const FOREST_MEMORY_BODY_BYTES = 65_536;
export const FOREST_MEMORY_SNAPSHOT_BYTES = 32_768;
export const FOREST_MEMORY_LEASE_MS = 90_000;
const revision = z.number().int().nonnegative().safe();
const clock = z.number().finite().min(0).max(1e9);
const text = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]*$/);
const fraction = z.number().finite().min(0).max(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const point = z.object({ x: z.number().finite().min(0).max(1e7), y: z.number().finite().min(0).max(1e7) }).strict();
const activity = z.enum(["look", "sniff", "groom", "rest"]);
const action = z.enum(["look", "sniff", "groom", "rest", "bush", "home-sleep", "butterfly", "firefly", "mushroom", "leaf", "idle"]);

export const forestMemoryPayloadSchema = z.object({
  version: z.literal(1), sceneId: text, fingerprint: text,
  mind: z.object({
    elapsed: clock, needs: z.object({ energy: fraction, curiosity: fraction, comfort: fraction, attention: fraction }).strict(),
    attentionUntil: clock,
    recent: z.array(z.object({ key: text, action, outcome: z.enum(["completed", "interrupted", "failed"]),
      at: clock, duration: z.number().finite().min(0).max(3600) }).strict()).max(16),
  }).strict().superRefine((mind, context) => {
    if (mind.attentionUntil > mind.elapsed + 30) context.addIssue({ code: z.ZodIssueCode.custom, message: "Attention deadline is too far ahead" });
    if (mind.recent.some(item => item.at > mind.elapsed || mind.elapsed - item.at > 300))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Recent activity must belong to the last five active minutes" });
  }),
  hero: z.object({ position: point, sleepingHome: z.boolean(), awakeFor: z.number().finite().min(0).max(30),
    restFor: z.number().finite().min(0).max(45), recent: z.array(z.object({ id: text, activity,
      age: z.number().finite().min(0).max(75) }).strict()).max(8) }).strict(),
  mushrooms: z.array(z.object({ id: text, position: point, growth: fraction,
    regrowIn: z.number().finite().min(0).max(22) }).strict()).max(128),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > FOREST_MEMORY_SNAPSHOT_BYTES)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Forest memory is too large" });
  if (new Set(value.mushrooms.map(item => item.id)).size !== value.mushrooms.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Mushroom IDs must be unique" });
});

export const forestMemoryReadSchema = z.object({ expectedOwnerPublicId: publicId, clientId: uuid }).strict();
export const forestMemoryCommandSchema = z.object({
  ownerPublicId: publicId, clientId: uuid, requestId: uuid, expectedRevision: revision,
  action: z.enum(["acquire", "save", "release"]), takeover: z.boolean().default(false),
  leaseToken: uuid.nullable().default(null), snapshot: forestMemoryPayloadSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  const valid = value.action === "acquire" ? value.leaseToken === null && value.snapshot === null
    : !value.takeover && value.leaseToken !== null && (value.action === "save" ? value.snapshot !== null : value.snapshot === null);
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid forest memory command fields" });
});

export const forestMemoryViewSchema = z.object({
  ownerPublicId: publicId, revision, serverTime: z.string().datetime(), updatedAt: z.string().datetime().nullable(),
  snapshot: forestMemoryPayloadSchema.nullable(),
  lease: z.object({ owned: z.boolean(), expiresAt: z.string().datetime().nullable(), token: uuid.nullable() }).strict(),
}).strict().superRefine((value, context) => {
  if (value.lease.owned !== (value.lease.token !== null) || value.lease.owned && value.lease.expiresAt === null)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid forest lease" });
});
export const forestMemoryResultSchema = z.object({ state: forestMemoryViewSchema, acceptedRevision: revision, replayed: z.boolean() }).strict();

export type ForestMemoryPayload = z.infer<typeof forestMemoryPayloadSchema>;
export type ForestMemoryView = z.infer<typeof forestMemoryViewSchema>;
export type ForestMemoryCommand = z.input<typeof forestMemoryCommandSchema>;
export type ForestMemoryResult = z.infer<typeof forestMemoryResultSchema>;
