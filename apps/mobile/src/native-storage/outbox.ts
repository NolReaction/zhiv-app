import type { ClientKeyValueStorage } from "@/lib/client-persistence";
import { economyCommandSchema, marketCommandSchema } from "@/features/economy/domain/model";
import { neighborCommandSchema } from "@/features/economy/domain/neighbor-model";
import { barterCommandSchema } from "@/features/economy/domain/barter-model";

export type NativeOutboxPort = {
  list(options: { owner: string }): Promise<{ records: Array<{ key: string; value: string }> }>;
  put(options: { owner: string; key: string; value: string }): Promise<void>;
  remove(options: { owner: string; key: string; expectedValue: string }): Promise<void>;
};
export type OutboxRequest = {
  userId: string; path: string; method: string; headers: Record<string, string>; body?: string;
};
type PendingReceipt = { kind: string; command: Record<string, unknown>; circleId?: string };
type RecordValue = { version: 1; owner: string; generation: number; path: string; body: string };
type SavedRecord = { key: string; value: string; record: RecordValue; storageKey: string; receipt: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicId = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const kinds: Record<string, string> = {
  "/api/v1/economy/commands": "economy", "/api/v1/economy/market/commands": "market",
  "/api/v1/economy/neighbor/commands": "neighbor", "/api/v1/economy/barter/commands": "barter",
};
const noReceipt: { settle(status: number, body?: string): Promise<void> } = { settle: async () => {} };

function decodeBody(value: string) {
  if (value.length > 350_000) throw new Error("Команда слишком большая для сохранения");
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
}
function receiptFor(path: string, body: string): PendingReceipt | null {
  const friend = /^\/api\/v1\/people\/([0-9a-f-]+)\/world\/market\/commands$/.exec(path);
  const kind = kinds[path] ?? (friend && uuid.test(friend[1]) ? "friend_market" : null);
  if (!kind) return null;
  const command: unknown = JSON.parse(body);
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Некорректная игровая команда");
  const value = command as Record<string, unknown>;
  if (typeof value.requestId !== "string" || !uuid.test(value.requestId)
    || typeof value.ownerPublicId !== "string" || !publicId.test(value.ownerPublicId)
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw new Error("Не удалось определить владельца команды");
  const schema = kind === "economy" ? economyCommandSchema : kind === "neighbor" ? neighborCommandSchema
    : kind === "barter" ? barterCommandSchema : marketCommandSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success || kind === "friend_market" && value.action !== "buy_listing") throw new Error("Некорректная сохранённая команда");
  return { kind, command: parsed.data, ...(kind === "friend_market" ? { circleId: friend![1] } : {}) };
}
// JSON object key order is irrelevant to the command. Zod restores fields in
// schema order, so compare canonical payloads across the process boundary.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function acknowledges(body: string | undefined, owner: unknown): boolean {
  if (!body) return false;
  try {
    const receipt = JSON.parse(body);
    // This is the transport acknowledgement envelope. The feature API still
    // validates the complete state (including compact catalogue reconstruction).
    return receipt?.state?.ownerPublicId === owner && Number.isSafeInteger(receipt.state.revision)
      && Number.isSafeInteger(receipt.acceptedRevision) && receipt.acceptedRevision >= 0
      && receipt.state.revision >= receipt.acceptedRevision && typeof receipt.replayed === "boolean" && typeof receipt.message === "string";
  } catch { return false; }
}
function recoveryKey(owner: string, generation: number) {
  const key = `zhiv:economy:pending:v1:${owner}`;
  return generation ? `zhiv:gameplay:v1:${generation}:${key}` : key;
}
function parseSaved(owner: string, key: string, value: string): SavedRecord {
  if (value.length > 512_000) throw new Error("Сохранённая команда слишком большая");
  const record = JSON.parse(value) as RecordValue;
  if (!record || record.version !== 1 || record.owner !== owner || !Number.isSafeInteger(record.generation)
    || record.generation < 0 || typeof record.path !== "string" || typeof record.body !== "string") throw new Error("Повреждена очередь устройства");
  const receipt = receiptFor(record.path, record.body);
  if (!receipt || key !== `${record.generation}:${receipt.command.requestId}`) throw new Error("Повреждён идентификатор команды");
  return { key, value, record, storageKey: recoveryKey(String(receipt.command.ownerPublicId), record.generation), receipt: JSON.stringify(receipt) };
}

/** The database is a write-ahead safety net for DISPATCHED idempotent economic commands.
 * No timers, credentials, gameplay grants or automatic network replay live here. Existing
 * owner/generation-scoped economy reconciliation remains the sole sender after restart. */
export function createNativeRequestOutbox(database: NativeOutboxPort, browserReceipts: ClientKeyValueStorage) {
  let owner: string | undefined;
  let epoch = 0;
  let records = new Map<string, SavedRecord>();
  const resolved = new Set<string>();
  const receipts: ClientKeyValueStorage = {
    getItem(key) {
      const local = browserReceipts.getItem(key);
      if (local !== null) return local;
      for (const record of records.values()) {
        if (!resolved.has(record.key) && record.storageKey === key) return record.receipt;
      }
      return null;
    },
    setItem: (key, value) => browserReceipts.setItem(key, value),
    removeItem: key => browserReceipts.removeItem(key),
  };
  return {
    receipts,
    async hydrate(nextOwner?: string) {
      const current = ++epoch;
      owner = undefined; records = new Map(); resolved.clear();
      if (!nextOwner) return;
      if (!uuid.test(nextOwner)) throw new Error("Не удалось определить аккаунт устройства");
      const result = await database.list({ owner: nextOwner });
      if (current !== epoch) return;
      if (result.records.length > 64) throw new Error("Очередь устройства слишком большая");
      const restored = new Map<string, SavedRecord>();
      for (const row of result.records) {
        if (restored.has(row.key)) throw new Error("Повторяющаяся команда в очереди устройства");
        restored.set(row.key, parseSaved(nextOwner, row.key, row.value));
      }
      records = restored; owner = nextOwner;
    },
    async prepare(request: OutboxRequest) {
      if (request.method.toUpperCase() !== "POST") return noReceipt;
      // Non-game endpoints and read-only requests never enter this queue.
      if (!kinds[request.path] && !/^\/api\/v1\/people\/[0-9a-f-]+\/world\/market\/commands$/.test(request.path)) return noReceipt;
      if (!request.body) throw new Error("Нет данных игровой команды");
      const receipt = receiptFor(request.path, decodeBody(request.body));
      if (!receipt) return noReceipt;
      const generationHeader = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "x-game-generation")?.[1];
      // Never silently restore an unversioned request into generation zero.
      if (generationHeader === undefined || !/^(0|[1-9][0-9]*)$/.test(generationHeader)) throw new Error("Не определена версия игрового прогресса");
      const generation = Number(generationHeader);
      if (!Number.isSafeInteger(generation)) throw new Error("Некорректная версия игрового прогресса");
      if (!owner || owner !== request.userId) throw new Error("Хранилище другого аккаунта ещё не закрыто");
      const expectedOwner = owner, expectedEpoch = epoch;
      const key = `${generation}:${receipt.command.requestId}`;
      const value = JSON.stringify({ version: 1, owner, generation, path: request.path, body: canonicalJson(receipt.command) } satisfies RecordValue);
      const record = parseSaved(owner, key, value);
      await database.put({ owner, key, value });
      if (epoch !== expectedEpoch || owner !== expectedOwner) throw new Error("Аккаунт изменился во время сохранения");
      records.set(key, record); resolved.delete(key);
      return {
        async settle(status: number, responseBody?: string) {
          // A lost response, expired auth, presence handoff or throttling is still uncertain.
          if (!(status >= 200 && status < 300 && acknowledges(responseBody, receipt.command.ownerPublicId)
            || status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status))) return;
          if (epoch === expectedEpoch && owner === expectedOwner) resolved.add(key);
          // Compare-and-delete makes a late completion unable to remove different data.
          // Failure may be ignored by HTTP: after restart the same requestId is safe to reconcile.
          await database.remove({ owner: expectedOwner, key, expectedValue: value });
          if (epoch === expectedEpoch && owner === expectedOwner) { records.delete(key); resolved.delete(key); }
        },
      };
    },
    pendingCount: () => [...records.keys()].filter(key => !resolved.has(key)).length,
  };
}
