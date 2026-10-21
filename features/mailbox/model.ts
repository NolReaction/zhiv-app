import { z } from "zod";

const owner = z.string().min(1).max(40), instant = z.string().datetime({ offset: true });
const quantities = z.record(z.string().min(1).max(80), z.number().int().nonnegative().safe());
export const mailGiftSchema = z.object({ pearls: z.literal(100), claimedAt: instant.nullable() });
export const mailAttachmentsSchema = z.object({
  coins: z.number().int().safe(), pearls: z.number().finite().refine(value => Number.isSafeInteger(value * 2)),
  items: quantities.default({}), buildings: quantities.default({}),
  worldItems: z.array(z.string().max(80)).max(500).default([]), finds: z.array(z.string().max(80)).max(500).default([]),
  productionSlots: quantities.default({}), rods: z.array(z.string().max(80)).max(100).default([]),
  hooks: z.array(z.string().max(80)).max(100).default([]),
  gameItems: z.array(z.string().max(80)).max(500).default([]), achievements: z.array(z.string().max(80)).max(500).default([]),
});
export const mailMessageSchema = z.object({
  id: z.string().uuid(), type: z.enum(["admin_notice", "admin_grant", "balance_correction", "event"]),
  title: z.string().min(1).max(240).refine(value => [...value].length <= 120),
  body: z.string().max(4000).refine(value => [...value].length <= 2000), createdAt: instant,
  readAt: instant.nullable(), notify: z.boolean(), attachments: mailAttachmentsSchema.nullable(),
  gift: mailGiftSchema.nullable().default(null),
});
export const mailNotificationSchema = z.object({ id: z.string().uuid(), createdAt: instant });
export const mailboxPageSchema = z.object({
  ownerPublicId: owner, unreadCount: z.number().int().nonnegative().safe(), messages: z.array(mailMessageSchema).max(50),
  nextCursor: z.string().min(1).max(1024).nullable(), serverTime: instant,
  latestUnreadNotification: mailNotificationSchema.nullable(),
});
export const mailReadResultSchema = z.object({
  ownerPublicId: owner, id: z.string().uuid(), readAt: instant, unreadCount: z.number().int().nonnegative().safe(), serverTime: instant,
});
export const mailClaimResultSchema = z.object({ ownerPublicId: owner, id: z.string().uuid(), gift: mailGiftSchema.extend({ claimedAt: instant }), serverTime: instant });
export type MailMessage = z.infer<typeof mailMessageSchema>;
export type MailNotification = z.infer<typeof mailNotificationSchema>;
export type MailboxPage = z.infer<typeof mailboxPageSchema>;
export type MailReadResult = z.infer<typeof mailReadResultSchema>;
export type MailClaimResult = z.infer<typeof mailClaimResultSchema>;
