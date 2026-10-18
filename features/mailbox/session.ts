import { ApiError } from "@/lib/check-in-api";
import type { MailMessage, MailNotification, MailboxPage, MailReadResult, MailClaimResult } from "./model";
import { compareMailInstants, createMailNotificationLedger } from "./notification-ledger";

type Transport = { list: (cursor: string | null, signal: AbortSignal) => Promise<MailboxPage>;
  read: (id: string, signal: AbortSignal) => Promise<MailReadResult>;
  claim?: (id: string, signal: AbortSignal) => Promise<MailClaimResult> };
type View = { ownerPublicId: string | null; messages: readonly MailMessage[]; unreadCount: number; nextCursor: string | null;
  loaded: boolean; loading: boolean; loadingMore: boolean; available: boolean; error: string | null; readError: string | null;
  opened: boolean; selected: MailMessage | null; readingIds: readonly string[]; claimingIds: readonly string[];
  claimError: string | null; notification: MailNotification | null };
const MAX_MESSAGES = 200;
export function createMailboxSession(owner: string | null, transport: Transport, onSessionLost: () => void = () => {},
  storage?: Pick<Storage, "getItem" | "setItem">) {
  let view: View = { ownerPublicId: owner, messages: [], unreadCount: 0, nextCursor: null, loaded: false, loading: false,
    loadingMore: false, available: false, error: null, readError: null, opened: false, selected: null, readingIds: [], claimingIds: [], claimError: null, notification: null };
  let active = false, available = true, generation = 0, readVersion = 0, lastRefresh = -Infinity, retryAt = 0;
  let loading: Promise<void> | null = null, loadingMore: Promise<void> | null = null;
  let countConfirmedAt: string | null = null;
  let onReceived: () => void = () => {};
  const received = new Set<string>();
  const receivedClaims = new Set<string>();
  const requests = new Set<AbortController>(), reads = new Map<string, AbortController>(), listeners = new Set<() => void>();
  const claims = new Map<string, AbortController>(), claimed = new Map<string, MailClaimResult["gift"]>();
  const acknowledged = new Map<string, string>(), ledger = owner ? createMailNotificationLedger(owner, storage) : null;
  const publish = (patch: Partial<View>) => { view = { ...view, ...patch }; listeners.forEach(listener => listener()); };
  const valid = (token: number) => active && available && generation === token;
  const canAct = () => active && available && Boolean(owner);
  function rejectOwner(value: { ownerPublicId: string }) {
    if (value.ownerPublicId === owner) return false;
    loseSession(); return true;
  }
  function invalidate() {
    ++generation; requests.forEach(request => request.abort()); requests.clear(); reads.clear(); claims.clear(); loading = loadingMore = null;
    publish({ loading: false, loadingMore: false, readingIds: [], claimingIds: [] });
  }
  function loseSession() {
    active = false; invalidate();
    publish({ messages: [], selected: null, unreadCount: 0, nextCursor: null, loaded: false, opened: false, available: false, notification: null });
    onSessionLost();
  }
  function fail(error: unknown, read = false) {
    if (error instanceof ApiError && (error.status === 401 || error.body?.code === "OWNER_CHANGED" || error.body?.code === "MAIL_OWNER_CHANGED")) {
      loseSession(); return;
    }
    if (error instanceof ApiError && error.status === 429) retryAt = performance.now() + Math.max(1000, error.retryAfterMs ?? 60_000);
    const message = error instanceof ApiError ? error.message : read ? "Не удалось отметить письмо прочитанным. Повторите после подключения." : "Нет связи с почтой. Проверьте подключение и повторите.";
    publish(read ? { readError: message } : { error: message });
  }
  function mergeMessage(message: MailMessage) {
    const readAt = acknowledged.get(message.id) ?? view.messages.find(previous => previous.id === message.id)?.readAt;
    const gift = claimed.get(message.id) ?? view.messages.find(previous => previous.id === message.id)?.gift;
    return { ...message, ...(readAt && !message.readAt ? { readAt } : {}), ...(gift?.claimedAt && !message.gift?.claimedAt ? { gift } : {}) };
  }
  async function fetchPage(cursor: string | null) {
    if (!canAct()) return;
    const token = generation, mutation = readVersion, request = new AbortController(); requests.add(request);
    publish(cursor ? { loadingMore: true, error: null } : { loading: true, error: null });
    try {
      const page = await transport.list(cursor, request.signal);
      if (!valid(token) || rejectOwner(page)) return;
      const incoming = page.messages.map(mergeMessage), seen = new Set(incoming.map(message => message.id));
      const messages = cursor ? [...view.messages.filter(message => !seen.has(message.id)), ...incoming].slice(-MAX_MESSAGES) : incoming;
      const selected = view.selected ? incoming.find(message => message.id === view.selected!.id) ?? view.selected : null;
      const candidate = !cursor ? page.latestUnreadNotification : view.notification;
      const notificationMessage = candidate ? messages.find(message => message.id === candidate.id) : null;
      const eligibleNotification = candidate && !acknowledged.has(candidate.id)
        && (!notificationMessage || notificationMessage.notify && !notificationMessage.readAt);
      const adoptCount = mutation === readVersion && (!countConfirmedAt || compareMailInstants(page.serverTime, countConfirmedAt) >= 0);
      if (adoptCount) countConfirmedAt = page.serverTime;
      publish({ messages, selected, nextCursor: page.nextCursor, loaded: true,
        ...(adoptCount ? { unreadCount: page.unreadCount } : {}),
        ...(!cursor ? { notification: eligibleNotification && !ledger?.seen(candidate) ? candidate : null } : {}) });
      const giftChanged = incoming.some(message => message.gift?.claimedAt && !receivedClaims.has(message.id));
      for (const message of incoming) if (message.gift?.claimedAt) receivedClaims.add(message.id);
      while (receivedClaims.size > MAX_MESSAGES) receivedClaims.delete(receivedClaims.values().next().value!);
      if (!cursor) {
        const changed = giftChanged || incoming.some(message => message.attachments && !received.has(message.id));
        for (const message of incoming) received.add(message.id);
        while (received.size > MAX_MESSAGES) received.delete(received.values().next().value!);
        if (changed) onReceived();
      } else if (giftChanged) onReceived();
    } catch (error) { if (valid(token)) fail(error); }
    finally { requests.delete(request); if (valid(token)) publish(cursor ? { loadingMore: false } : { loading: false }); }
  }
  function refresh(force = true): Promise<void> {
    if (!canAct() || performance.now() < retryAt || !force && performance.now() - lastRefresh < 20_000) return Promise.resolve();
    if (loading) return loading;
    if (loadingMore) return loadingMore;
    lastRefresh = performance.now();
    const token = generation, task = Promise.resolve().then(() => valid(token) ? fetchPage(null) : undefined); loading = task;
    void task.finally(() => { if (loading === task) loading = null; });
    return task;
  }
  function loadMore(): Promise<void> {
    if (!canAct() || !view.nextCursor || loading || loadingMore || performance.now() < retryAt) return Promise.resolve();
    const cursor = view.nextCursor, token = generation, task = Promise.resolve().then(() => valid(token) ? fetchPage(cursor) : undefined); loadingMore = task;
    void task.finally(() => { if (loadingMore === task) loadingMore = null; });
    return task;
  }
  async function messageVisible(id: string) {
    if (!canAct() || !view.opened || view.selected?.id !== id || view.selected.readAt || reads.has(id) || performance.now() < retryAt) return;
    const token = generation, request = new AbortController(); requests.add(request); reads.set(id, request); ++readVersion;
    publish({ readingIds: [...reads.keys()], readError: null });
    try {
      const result = await transport.read(id, request.signal);
      if (!valid(token) || rejectOwner(result)) return;
      if (result.id !== id) { fail(new ApiError("Ответ другого письма отклонён. Обновите почту.", 502), true); return; }
      ++readVersion; acknowledged.set(id, result.readAt);
      if (acknowledged.size > MAX_MESSAGES) acknowledged.delete(acknowledged.keys().next().value!);
      const update = (message: MailMessage) => message.id === id ? { ...message, readAt: result.readAt } : message;
      const adoptCount = !countConfirmedAt || compareMailInstants(result.serverTime, countConfirmedAt) >= 0;
      if (adoptCount) countConfirmedAt = result.serverTime;
      publish({ messages: view.messages.map(update), selected: view.selected ? update(view.selected) : null, ...(adoptCount ? { unreadCount: result.unreadCount } : {}),
        readError: null, notification: view.notification?.id === id ? null : view.notification });
    } catch (error) { if (valid(token)) fail(error, true); }
    finally { requests.delete(request); if (reads.get(id) === request) reads.delete(id); if (valid(token)) publish({ readingIds: [...reads.keys()] }); }
  }
  async function claimGift(id: string) {
    if (!canAct() || !view.opened || view.selected?.id !== id || !view.selected.gift || view.selected.gift.claimedAt || claims.has(id) || !transport.claim || performance.now() < retryAt) return;
    const token = generation, request = new AbortController(); requests.add(request); claims.set(id, request);
    publish({ claimingIds: [...claims.keys()], claimError: null });
    try {
      const result = await transport.claim(id, request.signal);
      if (!valid(token) || rejectOwner(result)) return;
      if (result.id !== id) throw new ApiError("Ответ другого письма отклонён. Обновите почту.", 502);
      claimed.set(id, result.gift);
      receivedClaims.add(id);
      if (claimed.size > MAX_MESSAGES) claimed.delete(claimed.keys().next().value!);
      if (receivedClaims.size > MAX_MESSAGES) receivedClaims.delete(receivedClaims.values().next().value!);
      const update = (message: MailMessage) => message.id === id ? { ...message, gift: result.gift } : message;
      publish({ messages: view.messages.map(update), selected: view.selected ? update(view.selected) : null, claimError: null });
      onReceived();
    } catch (error) {
      if (valid(token)) {
        fail(error);
        if (canAct()) publish({ claimError: error instanceof ApiError ? error.message : "Ответ не получен. Повтори получение: подарок начислится только один раз." });
      }
    } finally { requests.delete(request); if (claims.get(id) === request) claims.delete(id); if (valid(token)) publish({ claimingIds: [...claims.keys()] }); }
  }
  return {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isActive: () => active, isAvailable: canAct,
    activate() { active = true; publish({ available }); return () => { active = false; invalidate(); view = { ...view, opened: false, selected: null, notification: null }; }; },
    setAvailable(value: boolean) {
      if (available === value) return;
      available = value; if (!value) invalidate(); else lastRefresh = -Infinity;
      publish({ available: active && available, ...(!value ? { notification: null } : {}) });
    },
    setSessionLost(callback: () => void) { onSessionLost = callback; },
    setReceived(callback: () => void) { onReceived = callback; },
    open() { if (!active || !owner) return; publish({ opened: true, selected: null, readError: null }); void refresh(); },
    close() { publish({ opened: false, selected: null, readError: null }); },
    select(id: string) { const message = view.messages.find(message => message.id === id); if (active && view.opened && message) publish({ selected: message, readError: null, claimError: null }); },
    back() { publish({ selected: null, readError: null, claimError: null }); }, refresh, refreshSoft: () => refresh(false), loadMore, messageVisible, claimGift,
    claimNotification(id: string) {
      if (!canAct() || view.notification?.id !== id) return false;
      return ledger?.claim(view.notification) ?? false;
    },
  };
}
