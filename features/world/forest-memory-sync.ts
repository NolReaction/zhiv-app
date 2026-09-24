import { ApiError } from "@/lib/check-in-api";
import { forestMemoryResultSchema, forestMemoryViewSchema,
  type ForestMemoryCommand, type ForestMemoryPayload, type ForestMemoryResult, type ForestMemoryView } from "./forest-memory-model";

export type ForestMemorySyncStatus = Readonly<{
  mode: "loading" | "synced" | "saving" | "offline" | "other-device" | "error" | "disabled";
  revision: number | null;
  serverSavedAt: number | null;
  canTakeOver: boolean;
}>;
export type ForestMemoryTransport = {
  read(ownerPublicId: string, clientId: string, signal: AbortSignal): Promise<ForestMemoryView>;
  command(command: ForestMemoryCommand, signal: AbortSignal, keepalive?: boolean): Promise<ForestMemoryResult>;
};
export type ForestMemorySyncEnvironment = {
  now(): number;
  randomUUID(): string;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};
export type ForestMemorySyncOptions = {
  ownerPublicId: string;
  capture(): ForestMemoryPayload;
  apply(snapshot: ForestMemoryPayload): void;
  onStatus?(status: ForestMemorySyncStatus): void;
  transport?: ForestMemoryTransport;
  environment?: ForestMemorySyncEnvironment;
};

const SAVE_MS = 15_000, POLL_MS = 15_000, TIMEOUT_MS = 8_000, MAX_RETRY_MS = 60_000;
const environment: ForestMemorySyncEnvironment = {
  now: () => Date.now(), randomUUID: () => {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    // HTTP LAN development has getRandomValues, but randomUUID requires a secure context.
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  },
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: timer => globalThis.clearTimeout(timer),
};

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const duration = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}

async function request(path: string, signal: AbortSignal, command?: ForestMemoryCommand, keepalive = false) {
  const response = await fetch(path, { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    headers: { Accept: "application/json", ...(command ? { "Content-Type": "application/json" } : {}) },
    ...(command ? { body: JSON.stringify(command), keepalive } : {}) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const value = body && typeof body === "object" ? body as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } } : null;
    const error = value?.error ?? value;
    throw new ApiError(typeof error?.message === "string" ? error.message : "Не удалось сохранить память Мохлика", response.status,
      typeof error?.code === "string" ? { code: error.code, message: typeof error.message === "string" ? error.message : "" } : undefined,
      response.headers.get("X-Request-ID"), retryAfter(response.headers.get("Retry-After")));
  }
  return body;
}

export const forestMemoryTransport: ForestMemoryTransport = {
  async read(ownerPublicId, clientId, signal) {
    const body = await request(`/api/v1/world/forest-memory?${new URLSearchParams({ expectedOwnerPublicId: ownerPublicId, clientId })}`, signal);
    const result = forestMemoryViewSchema.safeParse(body);
    if (!result.success) throw new ApiError("Не удалось проверить память Мохлика", 502);
    return result.data;
  },
  async command(command, signal, keepalive) {
    const body = await request("/api/v1/world/forest-memory/commands", signal, command, keepalive);
    const result = forestMemoryResultSchema.safeParse(body);
    if (!result.success) throw new ApiError("Не удалось проверить сохранение Мохлика", 502);
    return result.data;
  },
};

/** One account, one cosmetic writer. Animation frames and tap sessions never enter this protocol. */
export function createForestMemorySync(options: ForestMemorySyncOptions) {
  const env = options.environment ?? environment, transport = options.transport ?? forestMemoryTransport;
  const clientId = env.randomUUID();
  let active = false, disposed = false, disabled = false, busy = false, retiring = false;
  let view: ForestMemoryView | null = null, pending: ForestMemoryCommand | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, requestController: AbortController | null = null;
  let needsRead = true, takeOverRequested = false, failures = 0, lastAppliedRevision: number | null = null;
  let due = 0, leaseDeadline = 0, finalSnapshot: ForestMemoryPayload | null = null;
  let status: ForestMemorySyncStatus = Object.freeze({ mode: "loading", revision: null, serverSavedAt: null, canTakeOver: false });
  const clone = (snapshot: ForestMemoryPayload): ForestMemoryPayload => JSON.parse(JSON.stringify(snapshot));
  const isLive = () => !disposed && !disabled;
  const ownsLease = () => Boolean(view?.lease.owned && view.lease.token && env.now() < leaseDeadline);
  const otherWriter = () => Boolean(view && !view.lease.owned && env.now() < leaseDeadline);
  function publish(mode: ForestMemorySyncStatus["mode"]) {
    if (disposed) return;
    const next = Object.freeze({ mode, revision: view?.revision ?? null,
      serverSavedAt: view?.updatedAt ? Date.parse(view.updatedAt) : null, canTakeOver: mode === "other-device" });
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next; options.onStatus?.(status);
  }
  function clearTimer() { if (timer !== null) env.clearTimeout(timer); timer = null; }
  function schedule(delay: number) {
    clearTimer(); if (!isLive() || !active && !retiring) return;
    timer = env.setTimeout(() => { timer = null; void pump(); }, Math.max(0, delay));
  }
  function accept(state: ForestMemoryView, apply: boolean, requestStarted = env.now()) {
    if (state.ownerPublicId !== options.ownerPublicId) throw new ApiError("Аккаунт изменился", 409, { code: "FOREST_MEMORY_ACCOUNT_CHANGED", message: "Аккаунт изменился" });
    view = state;
    leaseDeadline = state.lease.expiresAt
      ? requestStarted + Math.max(0, Date.parse(state.lease.expiresAt) - Date.parse(state.serverTime)) : 0;
    if (apply && state.snapshot && lastAppliedRevision !== state.revision) {
      options.apply(clone(state.snapshot)); lastAppliedRevision = state.revision;
    }
  }
  function command(action: ForestMemoryCommand["action"], snapshot?: ForestMemoryPayload): ForestMemoryCommand {
    return { ownerPublicId: options.ownerPublicId, clientId, requestId: env.randomUUID(), expectedRevision: view!.revision, action,
      ...(action === "acquire" ? { takeover: takeOverRequested } : { leaseToken: view!.lease.token }),
      ...(snapshot ? { snapshot: clone(snapshot) } : {}) };
  }
  async function timed<T>(perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); requestController = controller;
    const timeout = env.setTimeout(() => controller.abort(), TIMEOUT_MS);
    try { return await perform(controller.signal); }
    finally { env.clearTimeout(timeout); if (requestController === controller) requestController = null; }
  }
  function stopWithError() { disabled = true; pending = null; retiring = false; clearTimer(); publish("error"); }
  function handleError(error: unknown) {
    if (!isLive()) return;
    const api = error instanceof ApiError ? error : null;
    const code = api?.body && "code" in api.body ? api.body.code : undefined;
    if (api?.status === 401 || api?.status === 403 || code === "FOREST_MEMORY_ACCOUNT_CHANGED") { stopWithError(); return; }
    if (api?.status === 400 || code === "FOREST_MEMORY_REQUEST_CONFLICT") { stopWithError(); return; }
    if (api?.status === 409) {
      pending = null; needsRead = true; finalSnapshot = null;
      // A new authoritative read precedes every attempt after CAS/lease failure.
      lastAppliedRevision = null;
      publish(code === "FOREST_MEMORY_ACTIVE_ELSEWHERE" || code === "FOREST_MEMORY_LEASE_LOST" ? "other-device" : "loading");
      retiring = false; schedule(250); return;
    }
    failures++; publish("offline");
    if (retiring || !active) { retiring = false; return; }
    // Keep an uncertain command's UUID AND body until its acknowledgement or an explicit conflict.
    schedule(Math.max(Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(failures - 1, 6)), api?.retryAfterMs ?? 0));
  }
  async function pump() {
    if (!isLive() || busy || !active && !retiring) return;
    busy = true;
    try {
      if (!pending && needsRead) {
        const requestStarted = env.now();
        const remote = await timed(signal => transport.read(options.ownerPublicId, clientId, signal));
        if (!isLive()) return;
        accept(remote, true, requestStarted); needsRead = false; failures = 0;
      }
      if (!view || !isLive()) return;
      if (!pending) {
        if (retiring) {
          if (!ownsLease()) { retiring = false; finalSnapshot = null; return; }
          pending = finalSnapshot ? command("save", finalSnapshot) : command("release"); finalSnapshot = null;
        } else if (takeOverRequested || !ownsLease()) {
          if (otherWriter() && !takeOverRequested) { publish("other-device"); needsRead = true; schedule(POLL_MS); return; }
          pending = command("acquire");
        } else if (env.now() >= due) {
          pending = command("save", options.capture()); publish("saving");
        } else { publish("synced"); schedule(due - env.now()); return; }
      }
      const sent = pending, requestStarted = env.now();
      const result = await timed(signal => transport.command(sent, signal, retiring));
      if (!isLive()) return;
      pending = null; failures = 0;
      // A replay may describe a later owner. Never treat its old receipt as permission to write.
      const currentReceipt = result.acceptedRevision === result.state.revision;
      accept(result.state, sent.action !== "save" || result.replayed || !currentReceipt || !result.state.lease.owned, requestStarted);
      if (sent.action === "save" && currentReceipt) lastAppliedRevision = result.state.revision;
      if (sent.action === "acquire") takeOverRequested = false;
      if (sent.action === "release") { retiring = false; finalSnapshot = null; needsRead = true; if (active) schedule(0); return; }
      due = env.now() + SAVE_MS;
      if (retiring || needsRead || takeOverRequested) { schedule(0); return; }
      if (!ownsLease()) { needsRead = true; publish("other-device"); schedule(POLL_MS); return; }
      publish("synced"); schedule(SAVE_MS);
    } catch (error) { handleError(error); }
    finally { busy = false; }
  }
  function leave() {
    // Snapshot synchronously: a DEV button may mutate the live state immediately after suspend().
    const prepared = pending ?? (ownsLease() ? command("save", options.capture()) : null);
    clearTimer(); requestController?.abort();
    if (!prepared || prepared.action === "acquire") return;
    const controller = new AbortController(), timeout = env.setTimeout(() => controller.abort(), TIMEOUT_MS);
    void transport.command(prepared, controller.signal, true).then(result => {
      const state = result.state;
      if (state.ownerPublicId !== options.ownerPublicId || !state.lease.owned || !state.lease.token || prepared.action === "release") return;
      return transport.command({ ownerPublicId: options.ownerPublicId, clientId, requestId: env.randomUUID(),
        expectedRevision: state.revision, action: "release", leaseToken: state.lease.token }, controller.signal, true);
    }).catch(() => { /* The lease expires if the page has already gone away. */ }).finally(() => env.clearTimeout(timeout));
  }
  return {
    getStatus: () => status,
    isSimulationAllowed: () => disabled && status.mode === "disabled" || active && ownsLease() && (status.mode === "synced" || status.mode === "saving"),
    setActive(value: boolean) {
      if (!isLive() || active === value) return;
      active = value; clearTimer();
      if (active) {
        // Offline/hidden changes never overwrite an existing server snapshot on reconnect.
        retiring = false; finalSnapshot = null;
        needsRead = true; lastAppliedRevision = null; publish("loading");
        schedule(0);
      } else {
        finalSnapshot = ownsLease() ? clone(options.capture()) : null; retiring = true;
        if (!busy) void pump();
      }
    },
    flush() { if (!isLive() || !active) return; due = 0; if (!busy) schedule(0); },
    takeOver() { if (!isLive() || !active || status.mode !== "other-device") return; takeOverRequested = true; needsRead = true; if (!busy) schedule(0); },
    suspend() { if (!isLive()) return; leave(); disabled = true; retiring = false; publish("disabled"); },
    release() { if (disposed) return; if (!disabled) leave(); disposed = true; disabled = true; retiring = false; clearTimer(); },
  };
}
