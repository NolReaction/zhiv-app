import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { economyCommandSchema, marketCommandSchema, type EconomyCommand, type EconomyResult, type EconomyView, type MarketCommand, type MarketView } from "./model";
import { economyDevCommandSchema, type EconomyDevCommand } from "./dev-model";
import { constructionCompletions, type ConstructionCompletion } from "./construction-completion";
import { inventoryGainFromReceipt, INVENTORY_GAIN_HISTORY_LIMIT, type InventoryGain } from "./inventory-gain";

type Transport = {
  get: (signal: AbortSignal) => Promise<EconomyView>;
  send: (command: EconomyCommand, signal: AbortSignal) => Promise<EconomyResult>;
  market: (signal: AbortSignal, cursor?: string) => Promise<MarketView>;
  trade: (command: MarketCommand, signal: AbortSignal) => Promise<EconomyResult>;
  dev?: (command: EconomyDevCommand, signal: AbortSignal) => Promise<EconomyResult>;
};
type Pending = { kind: "economy"; command: EconomyCommand } | { kind: "market"; command: MarketCommand } | { kind: "dev"; command: EconomyDevCommand };
type View = {
  snapshot: EconomyView | null; market: MarketView | null; marketError: string | null;
  error: string | null; notice: string; busy: boolean; uncertain: boolean; retryAt: number;
  completedConstructions: readonly ConstructionCompletion[];
  /** Confirmed local cancellations only; used to return the visible actor empty-handed. */
  cancelledExplorations?: readonly string[];
  /** Local accepted inventory additions only; never inferred by polling. */
  inventoryGains?: readonly InventoryGain[];
};
type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Account-scoped session, independent of map/panel lifetime. An uncertain command keeps its exact receipt. */
export function createEconomySession(owner: string | null, transport: Transport, onSessionLost: () => void, storage?: ReceiptStorage) {
  let view: View = { snapshot: null, market: null, marketError: null, error: null, notice: "", busy: false, uncertain: false, retryAt: 0, completedConstructions: [], inventoryGains: [] };
  let pending: Pending | null = null, active = false, epoch = 0, readSequence = 0, marketSequence = 0;
  let reading: Promise<void> | null = null, marketReading: Promise<void> | null = null;
  let lastReadAt = -Infinity, blockedUntil = 0, marketBlockedUntil = 0, failures = 0;
  let serverClock = Date.now(), localClock = performance.now();
  const storageKey = `zhiv:economy:pending:v1:${owner}`;
  const listeners = new Set<() => void>(), requests = new Set<AbortController>();
  const inventoryReceipts = new Set<string>();
  const publish = (patch: Partial<View>) => { view = { ...view, ...patch }; listeners.forEach(listener => listener()); };
  const valid = (generation: number) => active && generation === epoch;
  const now = () => serverClock + performance.now() - localClock;
  const controller = () => { const request = new AbortController(); requests.add(request); return request; };
  function remember(value: Pending | null) {
    pending = value;
    try { if (value) storage?.setItem(storageKey, JSON.stringify(value)); else storage?.removeItem(storageKey); } catch { /* Receipt remains in memory if browser storage is unavailable. */ }
  }
  function restore() {
    if (!owner || pending) return;
    try {
      const raw = storage?.getItem(storageKey);
      if (!raw) return;
      const value = JSON.parse(raw) as { kind?: unknown; command?: unknown };
      const schema = value.kind === "economy" ? economyCommandSchema : value.kind === "market" ? marketCommandSchema
        : value.kind === "dev" && transport.dev ? economyDevCommandSchema : null;
      const parsed = schema?.safeParse(value.command);
      if (parsed?.success && parsed.data.ownerPublicId === owner) {
        pending = { kind: value.kind, command: parsed.data } as Pending;
        publish({ uncertain: true, error: "Остался неподтверждённый запрос. Проверьте его результат перед новым действием." });
      } else storage?.removeItem(storageKey);
    } catch { /* A malformed cache never creates a command. */ }
  }
  function adopt(value: EconomyView) {
    if (value.ownerPublicId !== owner) { onSessionLost(); return false; }
    if (view.snapshot && value.revision < view.snapshot.revision) return true;
    serverClock = Date.parse(value.serverTime); localClock = performance.now();
    publish({ snapshot: value }); return true;
  }
  function refresh(force = true): Promise<void> {
    if (!active || !owner || view.busy || performance.now() < blockedUntil) return Promise.resolve();
    if (reading) return reading;
    if (!force && performance.now() - lastReadAt < 15_000) return Promise.resolve();
    lastReadAt = performance.now();
    const task = read(); reading = task;
    void task.finally(() => { if (reading === task) reading = null; });
    return task;
  }
  async function read() {
    const generation = epoch, sequence = ++readSequence, request = controller();
    try {
      const snapshot = await transport.get(request.signal);
      if (valid(generation) && sequence === readSequence && adopt(snapshot)) {
        failures = 0; blockedUntil = 0;
        if (!pending) publish({ error: null, retryAt: 0 });
      }
    } catch (error) {
      if (!valid(generation) || sequence !== readSequence) return;
      const delay = error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000)
        : Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      blockedUntil = performance.now() + delay;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (!pending) publish({ error: error instanceof ApiError ? error.message : "Нет связи с хозяйством. Изменения появятся после подключения.", retryAt: now() + delay });
    } finally { requests.delete(request); }
  }
  function refreshMarket(cursor?: string): Promise<void> {
    if (!active || !owner || view.busy || performance.now() < marketBlockedUntil) return Promise.resolve();
    if (marketReading) return marketReading;
    const task = readMarket(cursor); marketReading = task;
    void task.finally(() => { if (marketReading === task) marketReading = null; });
    return task;
  }
  async function readMarket(cursor?: string) {
    const generation = epoch, sequence = ++marketSequence, request = controller();
    try {
      const result = await transport.market(request.signal, cursor);
      if (!valid(generation) || sequence !== marketSequence) return;
      const listings = cursor && view.market ? [...new Map([...view.market.listings, ...result.listings].map(item => [item.id, item])).values()] : result.listings;
      publish({ market: { ...result, listings }, marketError: null });
    } catch (error) {
      if (!valid(generation) || sequence !== marketSequence) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else {
        marketBlockedUntil = performance.now() + (error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000) : 3000);
        publish({ marketError: error instanceof ApiError ? error.message : "Не удалось обновить прилавки" });
      }
    } finally { requests.delete(request); }
  }
  async function execute(value: Pending) {
    if (!active || view.busy || value.command.ownerPublicId !== owner || performance.now() < blockedUntil || (value.kind === "dev" && !transport.dev)) return;
    const generation = epoch, request = controller(), before = view.snapshot;
    ++readSequence; ++marketSequence; reading = null; marketReading = null; remember(value);
    publish({ busy: true, error: null, notice: "", retryAt: 0 });
    let reloadMarket = false;
    try {
      const result = value.kind === "economy" ? await transport.send(value.command, request.signal)
        : value.kind === "market" ? await transport.trade(value.command, request.signal)
        : await transport.dev!(value.command, request.signal);
      if (!valid(generation)) return;
      if (adopt(result.state)) {
        // A local confirmed claim can celebrate once. Loading, polling or recovering
        // an already-applied receipt never manufactures a new completion event.
        const completed = value.kind === "economy" && ["claim_job", "speedup_construction"].includes(value.command.action)
          ? constructionCompletions(before, result.state).filter(event => !view.completedConstructions.some(previous => previous.id === event.id)) : [];
        const cancelled = value.kind === "economy" && value.command.action === "cancel_exploration"
          && !result.state.jobs.some(job => job.id === value.command.targetId)
          && !view.snapshot?.jobs.some(job => job.id === value.command.targetId)
          && !view.cancelledExplorations?.includes(value.command.targetId) ? value.command.targetId : null;
        const gain = value.kind !== "dev" && view.snapshot?.revision === result.state.revision
          && !inventoryReceipts.has(value.command.requestId) ? inventoryGainFromReceipt(before, result, value.command) : null;
        if (gain) {
          inventoryReceipts.add(gain.id);
          if (inventoryReceipts.size > 64) inventoryReceipts.delete(inventoryReceipts.values().next().value!);
        }
        remember(null); publish({ notice: result.message, uncertain: false,
          ...(completed.length ? { completedConstructions: [...view.completedConstructions, ...completed].slice(-8) } : {}),
          ...(cancelled ? { cancelledExplorations: Object.freeze([...(view.cancelledExplorations ?? []), cancelled].slice(-8)) } : {}),
          ...(gain ? { inventoryGains: Object.freeze([...(view.inventoryGains ?? []), gain].slice(-INVENTORY_GAIN_HISTORY_LIMIT)) } : {}) });
        reloadMarket = value.kind === "market";
      }
    } catch (error) {
      if (!valid(generation)) return;
      const throttled = error instanceof ApiError && error.status === 429;
      const definitive = error instanceof ApiError && error.status < 500 && error.status !== 408 && !throttled;
      if (definitive) remember(null);
      if (throttled) {
        const delay = Math.max(1000, error.retryAfterMs ?? 60_000);
        blockedUntil = performance.now() + delay;
        publish({ retryAt: now() + delay });
      }
      publish({ uncertain: !definitive, error: error instanceof ApiError ? error.message : "Ответ не пришёл. Повторная проверка использует тот же запрос и не спишет ресурсы дважды." });
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (definitive) {
        const snapshot = await transport.get(request.signal).catch(() => null);
        if (valid(generation) && snapshot) adopt(snapshot);
        reloadMarket = value.kind === "market";
      }
    } finally {
      requests.delete(request);
      if (valid(generation)) {
        publish({ busy: false });
        if (reloadMarket) void refreshMarket();
      }
    }
  }
  return {
    setSessionLost(callback: () => void) { onSessionLost = callback; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view, now, devAvailable: Boolean(transport.dev),
    activate() {
      active = true; restore();
      return () => {
        active = false; epoch++; readSequence++; marketSequence++; reading = null; marketReading = null;
        requests.forEach(request => request.abort()); requests.clear();
        if (view.busy) publish({ busy: false, uncertain: Boolean(pending) });
      };
    },
    refresh, refreshSoft: () => refresh(false), refreshMarket,
    act(action: EconomyCommand["action"], targetId: string, quantity = 1, totalPrice = 0) {
      if (!owner || !view.snapshot || pending || !active) return;
      void execute({ kind: "economy", command: { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice } });
    },
    actMarket(action: MarketCommand["action"], targetId: string, quantity = 1, totalPrice = 0) {
      if (!owner || !view.snapshot || pending || !active) return;
      void execute({ kind: "market", command: { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice } });
    },
    actDev(action: EconomyDevCommand["action"], targetId: string, quantity = 1) {
      if (!transport.dev || !owner || !view.snapshot || pending || !active) return;
      const command = economyDevCommandSchema.safeParse({ requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice: 0 });
      if (command.success) void execute({ kind: "dev", command: command.data });
    },
    retry: () => pending ? execute(pending) : refresh(),
  };
}
