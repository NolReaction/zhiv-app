import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { z } from "zod";
import { economyCommandSchema, marketCommandSchema, type EconomyCommand, type EconomyResult, type EconomyView, type MarketCommand, type MarketView } from "@/features/economy/domain/model";
import { economyDevCommandSchema, type EconomyDevCommand } from "@/features/economy/dev/dev-model";
import { constructionCompletions, type ConstructionCompletion } from "@/features/economy/domain/construction-completion";
import { inventoryGainFromReceipt, INVENTORY_GAIN_HISTORY_LIMIT, type InventoryGain } from "@/features/economy/domain/inventory-gain";
import { localSaleFromReceipt, type LocalSaleReceipt } from "@/features/economy/domain/local-sale-receipt";
import { localLeaftailPurchaseFromReceipt, type LocalLeaftailPurchase } from "@/features/economy/domain/local-leaftail-purchase";
import { localExplorationFromReceipt, type LocalExplorationReceipt } from "@/features/economy/domain/local-exploration-receipt";
import { barterCommandSchema, type BarterCommand, type BarterIntent, type BarterResult, type BarterView } from "@/features/economy/domain/barter-model";
import { hasGardenBerryReward } from "@/features/economy/domain/garden-berries";
import type { ProductionStart } from "@/features/economy/domain/production-start";
import { parseProductionJournal, productionJournalKey, productionProjection, reserveProduction, safeProductionRecipe,
  PRODUCTION_JOURNAL_LIMIT, type ProductionIntent, type JournalStorage, type JournalCoordinator } from "./production-journal";

type Transport = {
  get: (signal: AbortSignal) => Promise<EconomyView>;
  send: (command: EconomyCommand, signal: AbortSignal) => Promise<EconomyResult>;
  market: (signal: AbortSignal) => Promise<MarketView>;
  trade: (command: MarketCommand, signal: AbortSignal) => Promise<EconomyResult>;
  friendTrade?: (circleId: string, command: MarketCommand, signal: AbortSignal) => Promise<EconomyResult>;
  dev?: (command: EconomyDevCommand, signal: AbortSignal) => Promise<EconomyResult>;
  barter?: (signal: AbortSignal) => Promise<BarterView>;
  barterTrade?: (command: BarterCommand, signal: AbortSignal) => Promise<BarterResult>;
};
const friendMarketReceiptSchema = z.object({
  kind: z.literal("friend_market"), circleId: z.string().uuid(),
  command: marketCommandSchema.extend({ action: z.literal("buy_listing"), targetId: z.string().uuid(), fishSelection: z.undefined().optional() }),
}).strict();
type Pending = { kind: "economy"; command: EconomyCommand } | { kind: "market"; command: MarketCommand }
  | z.infer<typeof friendMarketReceiptSchema> | { kind: "dev"; command: EconomyDevCommand } | { kind: "barter"; command: BarterCommand };
type View = {
  snapshot: EconomyView | null; market: MarketView | null; marketError: string | null;
  barter: BarterView | null; barterError: string | null;
  marketSyncError: string | null; barterSyncError: string | null;
  error: string | null; notice: string; busy: boolean; uncertain: boolean; retryAt: number;
  completedConstructions: readonly ConstructionCompletion[];
  directActionsAvailable: boolean;
  snapshotConfirmed: boolean;
  productionSnapshot: EconomyView | null;
  pendingProductionIds: readonly string[];
  pendingProductionCount: number;
  productionQueueAvailable: boolean;
  syncPending: boolean;
  storageError: string | null;
  /** Recoverable queue delivery details belong to the compact connection indicator. */
  syncError: string | null;
  /** Confirmed local cancellations only; used to return the visible actor empty-handed. */
  cancelledExplorations?: readonly string[];
  /** Local accepted inventory additions only; never inferred by polling. */
  inventoryGains?: readonly InventoryGain[];
  /** Accepted local input only; never persisted or reconstructed from an ACK. */
  productionStarts?: readonly ProductionStart[];
  /** Latest confirmed local sale; transient, never reconstructed from a GET. */
  localSale?: LocalSaleReceipt;
  /** Exact accepted local trader purchase; names and debit never follow later catalogs. */
  localLeaftailPurchase?: LocalLeaftailPurchase;
  /** Exact locally initiated departure, including its same-session retry. */
  localExploration?: LocalExplorationReceipt;
};
type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Account-scoped session, independent of map/panel lifetime. An uncertain command keeps its exact receipt. */
export function createEconomySession(owner: string | null, transport: Transport, onSessionLost: () => void, storage?: ReceiptStorage,
  journalOptions?: { storage: JournalStorage; coordinate: JournalCoordinator }) {
  let view: View = { snapshot: null, market: null, marketError: null, barter: null, barterError: null, marketSyncError: null, barterSyncError: null, error: null, notice: "", busy: false, uncertain: false, retryAt: 0, completedConstructions: [], inventoryGains: [],
    directActionsAvailable: true, snapshotConfirmed: false, productionSnapshot: null, pendingProductionIds: [], pendingProductionCount: 0, productionQueueAvailable: false, syncPending: false, storageError: null, syncError: null };
  let pending: Pending | null = null, active = false, available = true, epoch = 0, readSequence = 0, marketSequence = 0, barterSequence = 0;
  // A reload may recover the command, but must not pretend the player just
  // started it in this course. Keep this intent out of receipt persistence.
  let localExplorationIntent: { requestId: string; before: EconomyView } | null = null;
  let localLeaftailPurchaseIntent: { requestId: string; before: EconomyView } | null = null;
  let reading: Promise<void> | null = null, marketReading: Promise<void> | null = null, barterReading: Promise<void> | null = null;
  let barterBlockedUntil = 0, rateLimitedUntil = 0;
  let lastReadAt = -Infinity, blockedUntil = 0, marketBlockedUntil = 0, failures = 0;
  let serverClock = Date.now(), localClock = performance.now();
  const storageKey = `zhiv:economy:pending:v1:${owner}`;
  const listeners = new Set<() => void>(), requests = new Set<AbortController>();
  const inventoryReceipts = new Set<string>();
  let productionEntries: ProductionIntent[] = [], journalReady = false, journalInitializing = false, localActionsAvailable = true;
  let lifetime = 0;
  let journalFault = false, productionSending: Promise<void> | null = null, journalInitialization: Promise<void> | null = null;
  let journalRelease: (() => void) | null = null, journalController: AbortController | null = null;
  const publish = (patch: Partial<View>) => {
    view = { ...view, ...patch };
    view = { ...view, productionSnapshot: productionProjection(view.snapshot, productionEntries),
      pendingProductionIds: Object.freeze(productionEntries.map(entry => entry.requestId)), pendingProductionCount: productionEntries.length,
      productionQueueAvailable: journalReady && !journalFault && localActionsAvailable,
      syncPending: Boolean(pending) || productionEntries.length > 0 };
    listeners.forEach(listener => listener());
  };
  function persistProduction(entries = productionEntries, snapshot = view.snapshot) {
    if (!journalOptions || !owner || !journalReady || !snapshot) return false;
    try {
      journalOptions.storage.setItem(productionJournalKey(owner), JSON.stringify({ version: 1, owner, snapshot, entries }));
      return true;
    } catch {
      journalFault = true;
      publish({ storageError: "Не удалось сохранить действие на устройстве. Освободите место в браузере и обновите игру." });
      return false;
    }
  }
  async function initializeJournal(generation: number) {
    if (!journalOptions || !owner) return;
    journalInitializing = true;
    journalController = new AbortController();
    const signal = journalController.signal;
    try {
      const release = await journalOptions.coordinate(owner, signal);
      if (!active || generation !== lifetime || signal.aborted) { release?.(); return; }
      // Web Locks may be unsupported (for example over LAN HTTP) or held by
      // another tab. Only the optional offline queue is unavailable; ordinary
      // server-confirmed actions still work and the connection is not broken.
      if (!release) return;
      journalRelease = release;
      const key = productionJournalKey(owner), raw = journalOptions.storage.getItem(key);
      const restored = parseProductionJournal(raw, owner);
      journalReady = true;
      if (restored) {
        productionEntries = restored.entries;
        if (!view.snapshotConfirmed && (!view.snapshot || restored.snapshot.revision > view.snapshot.revision)) {
          serverClock = Date.parse(restored.snapshot.serverTime); localClock = performance.now();
          publish({ snapshot: restored.snapshot, snapshotConfirmed: false });
        }
      } else if (raw) journalOptions.storage.removeItem(key);
      publish({ storageError: null });
    } catch {
      journalFault = true;
      publish({ storageError: "Браузер не разрешил сохранить очередь. Для действий требуется соединение." });
    } finally { if (generation === lifetime) journalInitializing = false; }
  }
  async function sendProduction() {
    while (active && available && owner && journalReady && !journalFault && productionEntries.length && !pending && !view.busy
      && performance.now() >= blockedUntil) {
      const generation = epoch, head = productionEntries[0];
      if (!head.command && !view.snapshotConfirmed) {
        await read();
        if (!valid(generation) || !view.snapshotConfirmed || performance.now() < blockedUntil) return;
        continue;
      }
      const before = view.snapshot;
      if (!before) return;
      if (!head.command) {
        if (!reserveProduction(before, head)) {
          const remaining = productionEntries.slice(1);
          if (!persistProduction(remaining)) return;
          productionEntries = remaining;
          publish({ notice: "Производство не запущено: изменились материалы или свободные места." });
          continue;
        }
        head.command = { requestId: head.requestId, ownerPublicId: owner, expectedRevision: before.revision,
          action: "start_production", targetId: head.targetId, quantity: 1, totalPrice: 0 };
        if (!persistProduction()) return;
      }
      const command = head.command, request = controller();
      ++readSequence; reading = null;
      try {
        const result = await transport.send(command, request.signal);
        if (!valid(generation)) return;
        if (result.state.ownerPublicId !== owner) { onSessionLost(); return; }
        const remaining = productionEntries.slice(1);
        // ACK and remaining intents are committed atomically before the next send.
        const snapshot = view.snapshotConfirmed && view.snapshot && view.snapshot.revision > result.state.revision ? view.snapshot : result.state;
        const saved = persistProduction(remaining, snapshot);
        productionEntries = remaining;
        adopt(result.state);
        failures = 0; blockedUntil = 0;
        publish({ error: null, syncError: null, notice: result.message, retryAt: 0 });
        if (!saved) return;
      } catch (error) {
        if (!valid(generation)) return;
        const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500
          && ![401, 408, 425, 429].includes(error.status) && error.body?.code !== "GAME_SESSION_INACTIVE";
        if (definitive) {
          const remaining = productionEntries.slice(1);
          if (!persistProduction(remaining)) return;
          productionEntries = remaining;
          publish({ error: error.message, syncError: null });
          const snapshot = await transport.get(request.signal).catch(() => null);
          if (!valid(generation)) return;
          if (!snapshot || !adopt(snapshot)) return;
        } else {
          const delay = error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000)
            : Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
          blockedUntil = performance.now() + delay;
          if (error instanceof ApiError && error.status === 429) rateLimitedUntil = blockedUntil;
          publish({ error: null, syncError: error instanceof ApiError ? error.message : "Действия сохранены на устройстве. Отправим их после подключения.", retryAt: now() + delay });
          if (error instanceof ApiError && error.status === 401) onSessionLost();
          return;
        }
      } finally { requests.delete(request); }
    }
  }
  function drainProduction(): Promise<void> {
    if (productionSending) return productionSending;
    const task = sendProduction(); productionSending = task;
    void task.finally(() => { if (productionSending === task) productionSending = null; });
    return task;
  }
  const valid = (generation: number) => active && generation === epoch;
  const now = () => serverClock + performance.now() - localClock;
  const controller = () => { const request = new AbortController(); requests.add(request); return request; };
  const productionStarts = (id: string): readonly ProductionStart[] => Object.freeze([
    ...(view.productionStarts ?? []), Object.freeze({ id, ownerPublicId: owner!, occurredAt: Date.now() }),
  ].slice(-16));
  function remember(value: Pending | null) {
    pending = value;
    if (!value) { localExplorationIntent = null; localLeaftailPurchaseIntent = null; }
    try { if (value) storage?.setItem(storageKey, JSON.stringify(value)); else storage?.removeItem(storageKey); } catch { /* Receipt remains in memory if browser storage is unavailable. */ }
  }
  function restore() {
    if (!owner || pending) return;
    try {
      const raw = storage?.getItem(storageKey);
      if (!raw) return;
      const value = JSON.parse(raw) as { kind?: unknown; command?: unknown };
      if (value.kind === "friend_market") {
        const parsed = transport.friendTrade ? friendMarketReceiptSchema.safeParse(value) : null;
        if (parsed?.success && parsed.data.command.ownerPublicId === owner) {
          pending = parsed.data;
          const message = "Остался неподтверждённый запрос. Проверьте его результат перед новым действием.";
          publish({ uncertain: true, error: message, syncError: message });
        } else storage?.removeItem(storageKey);
        return;
      }
      const schema = value.kind === "economy" ? economyCommandSchema : value.kind === "market" ? marketCommandSchema
        : value.kind === "dev" && transport.dev ? economyDevCommandSchema : value.kind === "barter" && transport.barterTrade ? barterCommandSchema : null;
      const parsed = schema?.safeParse(value.command);
      if (parsed?.success && parsed.data.ownerPublicId === owner) {
        pending = { kind: value.kind, command: parsed.data } as Pending;
        const message = "Остался неподтверждённый запрос. Проверьте его результат перед новым действием.";
        publish({ uncertain: true, error: message, syncError: message });
      } else storage?.removeItem(storageKey);
    } catch { /* A malformed cache never creates a command. */ }
  }
  function adopt(value: EconomyView) {
    if (value.ownerPublicId !== owner) { onSessionLost(); return false; }
    if (view.snapshotConfirmed && view.snapshot && value.revision < view.snapshot.revision) return true;
    serverClock = Date.parse(value.serverTime); localClock = performance.now();
    publish({ snapshot: value, snapshotConfirmed: true });
    if (journalReady && !journalFault) persistProduction();
    return true;
  }
  function refresh(force = true): Promise<void> {
    if (journalInitializing && journalInitialization) return journalInitialization.then(() => refresh(force));
    if (productionEntries.length) return drainProduction();
    if (!active || !available || !owner || view.busy || performance.now() < blockedUntil) return Promise.resolve();
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
        if (!pending && !productionEntries.length) publish({ error: null, syncError: null, retryAt: 0 });
      }
    } catch (error) {
      if (!valid(generation) || sequence !== readSequence) return;
      const delay = error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000)
        : Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      blockedUntil = performance.now() + delay;
      if (error instanceof ApiError && error.status === 429) rateLimitedUntil = blockedUntil;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (!pending) {
        const message = error instanceof ApiError ? error.message : "Нет связи с хозяйством. Изменения появятся после подключения.";
        const transportFailure = !(error instanceof ApiError) || error.status >= 500 || [408, 425, 429].includes(error.status)
          || error.body?.code === "GAME_SESSION_INACTIVE";
        publish({ error: productionEntries.length && transportFailure ? null : message, syncError: transportFailure ? message : null, retryAt: now() + delay });
      }
    } finally { requests.delete(request); }
  }
  function refreshMarket(): Promise<void> {
    if (!active || !available || !owner || view.busy || performance.now() < marketBlockedUntil) return Promise.resolve();
    if (marketReading) return marketReading;
    const task = readMarket(); marketReading = task;
    void task.finally(() => { if (marketReading === task) marketReading = null; });
    return task;
  }
  async function readMarket() {
    const generation = epoch, sequence = ++marketSequence, request = controller();
    try {
      const result = await transport.market(request.signal);
      if (!valid(generation) || sequence !== marketSequence) return;
      if (result.ownerPublicId !== owner) { onSessionLost(); return; }
      const knownSales = new Set(view.market?.mine.filter(lot => lot.status === "sold" && lot.sale?.claimedAt === null).map(lot => lot.id));
      if (result.mine.some(lot => lot.owned && lot.status === "sold" && lot.sale?.claimedAt === null && !knownSales.has(lot.id))) {
        // Another buyer also advances the seller's revision. Confirm that snapshot
        // before exposing a new collection button; the market cannot invent it.
        const snapshot = await transport.get(request.signal);
        if (!valid(generation) || sequence !== marketSequence || !adopt(snapshot)) return;
        // Adopting can notify a listener that starts a command and supersedes this read.
        if (!valid(generation) || sequence !== marketSequence) return;
      }
      publish({ market: result, marketError: null, marketSyncError: null });
    } catch (error) {
      if (!valid(generation) || sequence !== marketSequence) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else {
        marketBlockedUntil = performance.now() + (error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000) : 3000);
        const message = error instanceof ApiError ? error.message : "Не удалось обновить прилавки";
        const transportFailure = !(error instanceof ApiError) || error.status >= 500 || [408, 425, 429].includes(error.status)
          || error.body?.code === "GAME_SESSION_INACTIVE";
        publish({ marketError: message, marketSyncError: transportFailure ? message : null });
      }
    } finally { requests.delete(request); }
  }
  function refreshBarter(): Promise<void> {
    if (!active || !available || !owner || !transport.barter || view.busy || performance.now() < barterBlockedUntil) return Promise.resolve();
    if (barterReading) return barterReading;
    const task = readBarter(); barterReading = task;
    void task.finally(() => { if (barterReading === task) barterReading = null; });
    return task;
  }
  async function readBarter() {
    const generation = epoch, sequence = ++barterSequence, request = controller();
    try {
      const result = await transport.barter!(request.signal);
      if (!valid(generation) || sequence !== barterSequence) return;
      if (result.ownerPublicId !== owner) { onSessionLost(); return; }
      barterBlockedUntil = 0;
      publish({ barter: result, barterError: null, barterSyncError: null });
    } catch (error) {
      if (!valid(generation) || sequence !== barterSequence) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else {
        barterBlockedUntil = performance.now() + (error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000) : 3000);
        const message = error instanceof ApiError ? error.message : "Не удалось обновить витрину обмена";
        const transportFailure = !(error instanceof ApiError) || error.status >= 500 || [408, 425, 429].includes(error.status)
          || error.body?.code === "GAME_SESSION_INACTIVE";
        publish({ barterError: message, barterSyncError: transportFailure ? message : null });
      }
    } finally { requests.delete(request); }
  }
  async function execute(value: Pending, localProductionStart = false) {
    if (!active || !available || view.busy || value.command.ownerPublicId !== owner || performance.now() < blockedUntil || (value.kind === "dev" && !transport.dev) || (value.kind === "barter" && !transport.barterTrade) || (value.kind === "friend_market" && !transport.friendTrade)) return;
    const generation = epoch, request = controller(), before = view.snapshot;
    ++readSequence; ++marketSequence; ++barterSequence; reading = null; marketReading = null; barterReading = null; remember(value);
    publish({ busy: true, error: null, notice: "", retryAt: 0,
      ...(value.kind === "economy" && value.command.action === "buy_leaftail_item" ? { localLeaftailPurchase: undefined } : {}),
      ...(localProductionStart ? { productionStarts: productionStarts(value.command.requestId) } : {}) });
    let reloadMarket = false, reloadBarter = false;
    try {
      const result = value.kind === "economy" ? await transport.send(value.command, request.signal)
        : value.kind === "market" ? await transport.trade(value.command, request.signal)
        : value.kind === "friend_market" ? await transport.friendTrade!(value.circleId, value.command, request.signal)
        : value.kind === "barter" ? await transport.barterTrade!(value.command, request.signal)
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
        const gain = value.kind !== "dev" && value.kind !== "barter" && view.snapshot?.revision === result.state.revision
          && !inventoryReceipts.has(value.command.requestId) ? inventoryGainFromReceipt(before, result, value.command) : null;
        const sale = value.kind === "economy" && view.snapshot?.revision === result.state.revision
          && view.localSale?.id !== value.command.requestId ? localSaleFromReceipt(before, result, value.command) : null;
        const purchase = value.kind === "economy" && localLeaftailPurchaseIntent?.requestId === value.command.requestId
          && view.localLeaftailPurchase?.id !== value.command.requestId
          ? localLeaftailPurchaseFromReceipt(localLeaftailPurchaseIntent.before, result, value.command) : null;
        const departure = value.kind === "economy"
          && localExplorationIntent?.requestId === value.command.requestId && view.localExploration?.id !== value.command.requestId
          ? localExplorationFromReceipt(localExplorationIntent.before, result, value.command) : null;
        const exploration = departure && view.snapshot?.jobs.some(job => job.id === departure.jobId) ? departure : null;
        if (gain) {
          inventoryReceipts.add(gain.id);
          if (inventoryReceipts.size > 64) inventoryReceipts.delete(inventoryReceipts.values().next().value!);
        }
        remember(null); publish({ notice: result.message, uncertain: false, syncError: null,
          ...(sale ? { localSale: sale } : {}),
          ...(purchase ? { localLeaftailPurchase: purchase } : {}),
          ...(exploration ? { localExploration: exploration } : {}),
          ...(completed.length ? { completedConstructions: [...view.completedConstructions, ...completed].slice(-8) } : {}),
          ...(cancelled ? { cancelledExplorations: Object.freeze([...(view.cancelledExplorations ?? []), cancelled].slice(-8)) } : {}),
          ...(gain ? { inventoryGains: Object.freeze([...(view.inventoryGains ?? []), gain].slice(-INVENTORY_GAIN_HISTORY_LIMIT)) } : {}) });
        reloadMarket = value.kind === "market";
        reloadBarter = value.kind === "barter";
      }
    } catch (error) {
      if (!valid(generation)) return;
      const throttled = error instanceof ApiError && error.status === 429;
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500
        && ![401, 408, 425, 429].includes(error.status) && error.body?.code !== "GAME_SESSION_INACTIVE";
      if (definitive) remember(null);
      if (throttled) {
        const delay = Math.max(1000, error.retryAfterMs ?? 60_000);
        blockedUntil = performance.now() + delay;
      if (error instanceof ApiError && error.status === 429) rateLimitedUntil = blockedUntil;
        publish({ retryAt: now() + delay });
      }
      const message = error instanceof ApiError ? error.message : "Ответ не пришёл. Повторная проверка использует тот же запрос и не спишет ресурсы дважды.";
      publish({ uncertain: !definitive, error: message, syncError: definitive ? null : message });
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (definitive) {
        const snapshot = await transport.get(request.signal).catch(() => null);
        if (valid(generation) && snapshot) adopt(snapshot);
        reloadMarket = value.kind === "market";
        reloadBarter = value.kind === "barter";
      }
    } finally {
      requests.delete(request);
      if (valid(generation)) {
        publish({ busy: false });
        if (reloadMarket) void refreshMarket();
        if (reloadBarter) { void refresh(); void refreshBarter(); }
      }
    }
  }
  function setAvailable(value: boolean) {
    if (available === value) return;
    available = value;
    if (!value) {
      epoch++; readSequence++; marketSequence++; barterSequence++; reading = null; marketReading = null; barterReading = null;
      requests.forEach(request => request.abort()); requests.clear();
      publish({ busy: false, uncertain: Boolean(pending) });
    } else { lastReadAt = -Infinity; blockedUntil = Math.max(0, rateLimitedUntil); }
  }
  async function reconcile() {
    setAvailable(true);
    if (!active || !owner || performance.now() < blockedUntil) return false;
    if (journalInitialization) await journalInitialization;
    if (pending) await execute(pending);
    if (productionEntries.length) await drainProduction();
    if (pending || productionEntries.length || !active || !available) return false;
    await refresh();
    return Boolean(view.snapshot && view.snapshotConfirmed && !view.error && !view.busy && !pending && available);
  }
  return {
    setAvailable, reconcile,
    setLocalActionsAvailable(value: boolean) { if (localActionsAvailable !== value) { localActionsAvailable = value; publish({}); } },
    setDirectActionsAvailable(value: boolean) { if (view.directActionsAvailable !== value) publish({ directActionsAvailable: value }); },
    setSessionLost(callback: () => void) { onSessionLost = callback; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view, now, devAvailable: Boolean(transport.dev),
    activate() {
      active = true; lastReadAt = -Infinity; restore();
      if (journalOptions && !journalRelease) journalInitialization = initializeJournal(++lifetime);
      return () => {
        active = false; epoch++; lifetime++; readSequence++; marketSequence++; barterSequence++; reading = null; marketReading = null; barterReading = null;
        requests.forEach(request => request.abort()); requests.clear();
        journalController?.abort(); journalRelease?.(); journalRelease = null; journalReady = false;
        productionSending = null;
        if (view.busy) publish({ busy: false, uncertain: Boolean(pending) });
      };
    },
    refresh, refreshSoft: () => refresh(false), refreshMarket, refreshBarter,
    act(action: EconomyCommand["action"], targetId: string, quantity = 1, totalPrice = 0, fishSelection?: Record<string, number>) {
      if (action === "start_production" && journalReady && !journalFault && view.snapshot && safeProductionRecipe(view.snapshot, targetId) && quantity === 1 && totalPrice === 0 && fishSelection == null) {
        if (!owner || !view.snapshot || !active || !localActionsAvailable || pending || view.busy || productionEntries.length >= PRODUCTION_JOURNAL_LIMIT) return false;
        const entry = { requestId: createUuidV4(), targetId };
        const projected = productionProjection(view.snapshot, productionEntries);
        if (!projected || !reserveProduction(projected, entry)) return false;
        const next = [...productionEntries, entry];
        if (!persistProduction(next)) return false;
        productionEntries = next;
        publish({ notice: "Сохранено на устройстве", productionStarts: productionStarts(entry.requestId) });
        void drainProduction();
        return true;
      }
      if (!owner || !view.snapshot || !view.snapshotConfirmed || !view.directActionsAvailable || pending || productionEntries.length || !active || !localActionsAvailable || !available || view.busy || performance.now() < blockedUntil) return false;
      const command: EconomyCommand = { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice,
        ...(fishSelection === undefined ? {} : { fishSelection: { ...fishSelection } }) };
      if (action === "start_exploration" || action === "start_fishing")
        localExplorationIntent = { requestId: command.requestId, before: view.snapshot };
      if (action === "buy_leaftail_item") localLeaftailPurchaseIntent = { requestId: command.requestId, before: view.snapshot };
      void execute({ kind: "economy", command }, action === "start_production" || action === "start_tutorial_harvest");
      return true;
    },
    actMarket(action: MarketCommand["action"], targetId: string, quantity = 1, totalPrice = 0, fishSelection?: Record<string, number>) {
      if (!owner || !view.snapshot || !view.snapshotConfirmed || !view.directActionsAvailable || pending || productionEntries.length || !active || !localActionsAvailable || !available || view.busy || performance.now() < blockedUntil) return false;
      void execute({ kind: "market", command: { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice,
        ...(fishSelection === undefined ? {} : { fishSelection: { ...fishSelection } }) } });
      return true;
    },
    actFriendMarket(circleId: string, targetId: string, quantity: number, totalPrice: number) {
      if (!owner || !view.snapshot || !view.snapshotConfirmed || !view.directActionsAvailable || pending || productionEntries.length || !active || !localActionsAvailable || !available || view.busy || performance.now() < blockedUntil || !transport.friendTrade) return false;
      const receipt = friendMarketReceiptSchema.safeParse({ kind: "friend_market", circleId,
        command: { requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision,
          action: "buy_listing", targetId, quantity, totalPrice } });
      if (!receipt.success) return false;
      void execute(receipt.data);
      return true;
    },
    actBarter(intent: BarterIntent) {
      if (!owner || !view.snapshot || !view.snapshotConfirmed || !view.directActionsAvailable || pending || productionEntries.length || !active || !localActionsAvailable || !available || !transport.barterTrade) return;
      const parsed = barterCommandSchema.safeParse({ ...intent, requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision });
      if (parsed.success) void execute({ kind: "barter", command: parsed.data });
    },
    actDev(action: EconomyDevCommand["action"], targetId: string, quantity = 1) {
      if (!transport.dev || !owner || !view.snapshot || !view.snapshotConfirmed || !view.directActionsAvailable || pending || productionEntries.length || !active || !localActionsAvailable || !available) return;
      const command = economyDevCommandSchema.safeParse({ requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, targetId, quantity, totalPrice: 0 });
      if (command.success) void execute({ kind: "dev", command: command.data });
    },
    retry: () => pending ? execute(pending) : productionEntries.length ? drainProduction() : refresh(),
    retryGardenCollection() {
      if (pending?.kind !== "economy" || !active || !available || view.busy || performance.now() < blockedUntil) return false;
      const { action, targetId } = pending.command;
      const gardenClaim = action === "claim_job" && view.snapshot?.jobs.some(job => job.id === targetId
        && job.kind === "production" && job.targetId === "garden" && job.collection?.startedAt && hasGardenBerryReward(job.rewards));
      if (!["start_collection", "start_garden_collection", "claim_garden_collection"].includes(action) && !gardenClaim) return false;
      void execute(pending);
      return true;
    },
  };
}
