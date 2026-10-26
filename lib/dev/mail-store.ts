import { getDevIdentity } from "./api-store";
import { devMailMessages } from "./mail-state";
import { creditDevProgressionReward } from "./economy-store";
import { PEARL_DISPLAY_DIVISOR } from "@/features/economy/domain/money";
import { WELCOME_MAIL_PEARLS, WELCOME_MAIL_TITLE, WELCOME_MAIL_BODY } from "@/features/mailbox/welcome";
import { mailMessageSchema, type MailMessage, type MailboxPage, type MailReadResult, type MailClaimResult } from "@/features/mailbox/model";

export type DevMailResult<T> = { kind: "ok"; value: T } | { kind: "unauthorized" | "owner-mismatch" | "not-found" | "invalid" };
const canonicalTime = (value: string) => new Date(value).toISOString().replace(/\.000Z$/, "Z");
const encodeCursor = (message: MailMessage) => Buffer.from(`${canonicalTime(message.createdAt)}|${message.id}`, "utf8").toString("base64url");
function decodeCursor(value: string): { at: number; id: string } | null {
  if (value.length < 1 || value.length > 160 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const [time, id, extra] = Buffer.from(value, "base64url").toString("utf8").split("|");
    if (extra !== undefined || !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
    const canonical = Buffer.from(`${canonicalTime(time)}|${id}`, "utf8").toString("base64url");
    return canonical === value ? { at: Date.parse(time), id } : null;
  } catch { return null; }
}
function actor(token: string | undefined, owner: string): DevMailResult<true> {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "unauthorized" };
  return identity.user.publicId === owner ? { kind: "ok", value: true } : { kind: "owner-mismatch" };
}
function ensureWelcome(owner: string, now: number) {
  const messages = devMailMessages(owner);
  if ([...messages.values()].some(message => message.gift)) return;
  const message: MailMessage = { id: crypto.randomUUID(), type: "event", title: WELCOME_MAIL_TITLE, body: WELCOME_MAIL_BODY,
    createdAt: new Date(now).toISOString(), readAt: null, notify: false, attachments: null, gift: { pearls: WELCOME_MAIL_PEARLS, claimedAt: null } };
  messages.set(message.id, message);
}
/** The one welcome letter is server-owned; DEV exposes no administration or send operation. */
export function getDevMail(token: string | undefined, owner: string, cursor: string | undefined, limit = 20, now = Date.now()): DevMailResult<MailboxPage> {
  const session = actor(token, owner);
  if (session.kind !== "ok") return session;
  const after = cursor === undefined ? null : decodeCursor(cursor);
  if (cursor !== undefined && !after || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { kind: "invalid" };
  ensureWelcome(owner, now);
  const all = [...devMailMessages(owner).values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const unread = all.filter(message => message.readAt === null);
  const latest = unread.find(message => message.notify);
  const filtered = after ? all.filter(message => Date.parse(message.createdAt) < after.at
    || Date.parse(message.createdAt) === after.at && message.id < after.id) : all;
  const messages = filtered.slice(0, limit);
  return { kind: "ok", value: { ownerPublicId: owner, unreadCount: unread.length, messages: structuredClone(messages),
    nextCursor: filtered.length > limit ? encodeCursor(messages.at(-1)!) : null, serverTime: new Date(now).toISOString(),
    latestUnreadNotification: latest ? { id: latest.id, createdAt: latest.createdAt } : null } };
}
/** Synchronous equivalent of the JDBC transaction. Read/open never calls this. */
export function claimDevMailGift(token: string | undefined, owner: string, id: string, now = Date.now()): DevMailResult<MailClaimResult> {
  const session = actor(token, owner);
  if (session.kind !== "ok") return session;
  const messages = devMailMessages(owner), message = messages.get(id);
  if (!message?.gift) return { kind: "not-found" };
  const claimedAt = message.gift.claimedAt ?? new Date(now).toISOString();
  if (!message.gift.claimedAt) {
    creditDevProgressionReward(token, owner, `mail:${id}`, { coins: 0, pearls: message.gift.pearls * PEARL_DISPLAY_DIVISOR, items: {} }, "welcome:v1", now);
    messages.set(id, { ...message, gift: { pearls: message.gift.pearls, claimedAt } });
  }
  return { kind: "ok", value: { ownerPublicId: owner, id, gift: { pearls: message.gift.pearls, claimedAt }, serverTime: new Date(now).toISOString() } };
}
export function readDevMail(token: string | undefined, owner: string, id: string, now = Date.now()): DevMailResult<MailReadResult> {
  const session = actor(token, owner);
  if (session.kind !== "ok") return session;
  const messages = devMailMessages(owner), message = messages.get(id);
  if (!message) return { kind: "not-found" };
  const readAt = message.readAt ?? new Date(now).toISOString();
  messages.set(id, { ...message, readAt });
  return { kind: "ok", value: { ownerPublicId: owner, id, readAt,
    unreadCount: [...messages.values()].filter(item => item.readAt === null).length, serverTime: new Date(now).toISOString() } };
}
/** Synthetic fixtures only; there is no DEV HTTP endpoint to author letters. */
export function seedDevMailForTests(owner: string, messages: readonly MailMessage[]) {
  if (process.env.NODE_ENV !== "test") throw new Error("Mail fixtures require NODE_ENV=test");
  const inbox = devMailMessages(owner);
  for (const message of messages) inbox.set(message.id, structuredClone(mailMessageSchema.parse(message)));
}
