import { z } from "zod";
import { mailNotificationSchema, type MailNotification } from "./model";

export const MAIL_NOTIFICATION_LIMIT = 128;
export const mailNotificationKey = (owner: string) => `zhiv:mail:notified:v1:${owner}`;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const ledgerSchema = z.object({ version: z.literal(1), owner: z.string(), watermark: mailNotificationSchema.nullable(),
  ids: z.array(z.guid()).max(MAIL_NOTIFICATION_LIMIT) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
/** Preserve sub-millisecond ordering from PostgreSQL/Instant without rounding it to browser milliseconds. */
function timeKey(value: string) {
  const ms = Date.parse(value), fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] ?? "";
  return `${new Date(ms).toISOString().slice(0, 19)}.${fraction.padEnd(9, "0")}`;
}
export const compareMailInstants = (a: string, b: string) => timeKey(a).localeCompare(timeKey(b));
function compare(a: MailNotification, b: MailNotification) {
  return compareMailInstants(a.createdAt, b.createdAt) || a.id.localeCompare(b.id);
}
export function createMailNotificationLedger(owner: string, storage?: StorageLike) {
  let memory: Ledger = { version: 1, owner, watermark: null, ids: [] };
  function read() {
    try {
      const raw = storage?.getItem(mailNotificationKey(owner));
      if (raw && raw.length < 32_000) {
        const parsed = ledgerSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.owner === owner) {
          if (!memory.watermark || parsed.data.watermark && compare(parsed.data.watermark, memory.watermark) > 0) memory = parsed.data;
          else memory.ids = [...new Set([...parsed.data.ids, ...memory.ids])].slice(-MAIL_NOTIFICATION_LIMIT);
        }
      }
    } catch { /* Memory still prevents repeats during this account session. */ }
    return memory;
  }
  function seen(value: MailNotification) {
    const ledger = read();
    return ledger.ids.includes(value.id) || Boolean(ledger.watermark && compare(value, ledger.watermark) <= 0);
  }
  function claim(value: MailNotification) {
    if (seen(value)) return false;
    memory = { version: 1, owner, watermark: value, ids: [...memory.ids, value.id].slice(-MAIL_NOTIFICATION_LIMIT) };
    try { storage?.setItem(mailNotificationKey(owner), JSON.stringify(memory)); } catch { /* Full storage does not persist message text. */ }
    return true;
  }
  return { seen, claim };
}
