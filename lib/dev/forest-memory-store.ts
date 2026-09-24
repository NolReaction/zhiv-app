// Development adapter only. Production requests are handled by Ktor/PostgreSQL.
import { createHash } from "node:crypto";
import { getDevIdentity } from "@/lib/dev/api-store";
import { devForestMemoryStates, type DevForestMemoryState } from "@/lib/dev/forest-memory-state";
import {
  FOREST_MEMORY_LEASE_MS, forestMemoryCommandSchema, forestMemoryReadSchema,
  type ForestMemoryResult, type ForestMemoryView,
} from "@/features/world/forest-memory-model";

export class DevForestMemoryError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

function fail(code: string, message: string, status = 409): never {
  throw new DevForestMemoryError(code, message, status);
}

function profile(sessionToken: string | undefined, expectedOwnerPublicId: string) {
  const identity = getDevIdentity(sessionToken);
  if (!identity || !sessionToken) return fail("UNAUTHORIZED", "Войдите в аккаунт", 401);
  const ownerPublicId = identity.user.publicId;
  if (ownerPublicId !== expectedOwnerPublicId) return fail("FOREST_MEMORY_ACCOUNT_CHANGED", "Аккаунт изменился. Обновите память Мохлика.");
  const states = devForestMemoryStates();
  if (!states.has(ownerPublicId)) states.set(ownerPublicId, {
    revision: 0, snapshot: null, updatedAt: null, lease: null, receipts: new Map(),
  });
  return { ownerPublicId, sessionToken, value: states.get(ownerPublicId)! };
}

function activeLease(value: DevForestMemoryState, now: number) {
  const lease = value.lease;
  return lease && lease.expiresAt > now && getDevIdentity(lease.sessionToken) ? lease : null;
}

function view(ownerPublicId: string, value: DevForestMemoryState, sessionToken: string, clientId: string, now: number): ForestMemoryView {
  const lease = activeLease(value, now);
  const owned = lease !== null && lease.sessionToken === sessionToken && lease.clientId === clientId;
  return {
    ownerPublicId, revision: value.revision, serverTime: new Date(now).toISOString(),
    updatedAt: value.updatedAt === null ? null : new Date(value.updatedAt).toISOString(),
    snapshot: value.snapshot === null ? null : structuredClone(value.snapshot),
    lease: { owned, expiresAt: lease ? new Date(lease.expiresAt).toISOString() : null, token: owned ? lease.token : null },
  };
}

export function readDevForestMemory(token: string | undefined, query: unknown, now = Date.now()): ForestMemoryView {
  const parsed = forestMemoryReadSchema.safeParse(query);
  if (!parsed.success) return fail("INVALID_FOREST_MEMORY", "Некорректный запрос памяти Мохлика", 400);
  const { ownerPublicId, sessionToken, value } = profile(token, parsed.data.expectedOwnerPublicId);
  return view(ownerPublicId, value, sessionToken, parsed.data.clientId, now);
}

export function commandDevForestMemory(token: string | undefined, input: unknown, now = Date.now()): ForestMemoryResult {
  const parsed = forestMemoryCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_FOREST_MEMORY", "Некорректные данные памяти Мохлика", 400);
  const command = parsed.data;
  const { ownerPublicId, sessionToken, value } = profile(token, command.ownerPublicId);
  const signature = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const receipt = value.receipts.get(command.requestId);
  if (receipt) {
    if (receipt.sessionToken !== sessionToken || receipt.signature !== signature)
      return fail("FOREST_MEMORY_REQUEST_CONFLICT", "Этот запрос уже использован");
    return { state: view(ownerPublicId, value, sessionToken, command.clientId, now), acceptedRevision: receipt.acceptedRevision, replayed: true };
  }
  if (command.expectedRevision !== value.revision || value.revision >= Number.MAX_SAFE_INTEGER)
    return fail("FOREST_MEMORY_REVISION_CONFLICT", "Память Мохлика изменилась. Получите актуальное состояние.");

  const lease = activeLease(value, now);
  const owned = lease !== null && lease.sessionToken === sessionToken && lease.clientId === command.clientId;
  if (command.action === "acquire") {
    if (lease && !owned && !command.takeover)
      return fail("FOREST_MEMORY_ACTIVE_ELSEWHERE", "Мохлик сейчас живёт на другом устройстве.");
    value.lease = {
      sessionToken, clientId: command.clientId, token: owned ? lease.token : crypto.randomUUID(),
      expiresAt: now + FOREST_MEMORY_LEASE_MS,
    };
  } else {
    if (!owned || lease.token !== command.leaseToken)
      return fail("FOREST_MEMORY_LEASE_LOST", "Управление Мохликом перешло другому устройству.");
    if (command.action === "save") {
      value.snapshot = structuredClone(command.snapshot);
      value.updatedAt = now;
      value.lease = { ...lease, expiresAt: now + FOREST_MEMORY_LEASE_MS };
    } else value.lease = null;
  }
  value.revision++;
  value.receipts.set(command.requestId, { sessionToken, signature, acceptedRevision: value.revision });
  while (value.receipts.size > 64) value.receipts.delete(value.receipts.keys().next().value!);
  return { state: view(ownerPublicId, value, sessionToken, command.clientId, now), acceptedRevision: value.revision, replayed: false };
}
