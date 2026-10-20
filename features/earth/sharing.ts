import { createUuidV4 } from "@/lib/browser-uuid";
import {
  EARTH_APPROXIMATE_ACCURACY_METERS, EARTH_PEOPLE_POLL_MS, EARTH_POSITION_FUTURE_MS,
  EARTH_POSITION_MAX_AGE_MS, EARTH_POSITION_PUBLISH_MS, EARTH_POSITION_TTL_MS,
  earthPeopleResponseSchema, earthPositionReceiptSchema, earthPositionStoppedSchema,
  earthSharingSettingsSchema, earthSharingWriteSchema, earthSharedCoordinates,
  type EarthMapPerson, type EarthPeopleResponse, type EarthPositionReceipt, type EarthPositionStop,
  type EarthPositionStopped, type EarthPositionWrite, type EarthSharingDuration,
  type EarthSharingPrecision, type EarthSharingSettings, type EarthSharingWrite,
} from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";

export type EarthShareOptions = { recipientCircleIds: string[]; frozenCircleIds?: string[]; precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };
export type EarthPendingPrivacy = { mode: "GHOST" | "OFF"; key: string };
export type EarthSharingTransport = {
  getEarthSharing(signal?: AbortSignal): Promise<EarthSharingSettings>;
  updateEarthSharing(write: EarthSharingWrite, key: string, signal?: AbortSignal): Promise<EarthSharingSettings>;
  publishEarthPosition(write: EarthPositionWrite, key: string, signal?: AbortSignal): Promise<EarthPositionReceipt>;
  stopEarthPublication(write: EarthPositionStop, key: string, signal?: AbortSignal): Promise<EarthPositionStopped>;
  getEarthPeople(signal?: AbortSignal): Promise<EarthPeopleResponse>;
};
export type EarthSharingState = {
  settings: EarthSharingSettings | null; people: EarthMapPerson[]; loading: boolean; saving: boolean;
  error: string | null; pendingGhost: boolean; pendingPrivacyMode: "GHOST" | "OFF" | null;
  publishing: boolean; lastPublishedAt: string | null;
};
export type EarthSharingEnvironment = {
  now(): number; monotonicNow(): number;
  schedule(callback: () => void, delay: number): unknown; cancel(timer: unknown): void;
  visible(): boolean; onVisibilityChange(callback: () => void): () => void;
  loadPending(): EarthPendingPrivacy | null; savePending(intent: EarthPendingPrivacy): void;
  clearPending(key: string): void; onPendingChange(callback: (intent: EarthPendingPrivacy | null) => void): () => void;
  createId(): string;
};
const EMPTY: EarthSharingState = { settings: null, people: [], loading: false, saving: false, error: null,
  pendingGhost: false, pendingPrivacyMode: null, publishing: false, lastPublishedAt: null };
const pendingKey = (owner: string) => `zhiv:earth:pending-privacy:v1:${owner}`;
function parsePending(value: unknown): EarthPendingPrivacy | null {
  if (!value || typeof value !== "object") return null;
  const intent = value as Partial<EarthPendingPrivacy>;
  return (intent.mode === "GHOST" || intent.mode === "OFF") && typeof intent.key === "string"
    && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(intent.key)
    ? { mode: intent.mode, key: intent.key } : null;
}
/** Storage and cross-tab notifications contain only an owner-scoped hide intent. */
export function browserEarthSharingEnvironment(owner: string): EarthSharingEnvironment {
  const storageKey = pendingKey(owner);
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(storageKey) : null;
  const read = () => {
    try { return parsePending(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")); } catch { return null; }
  };
  return {
    now: Date.now, monotonicNow: () => performance.now(), schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), visible: () => !document.hidden,
    onVisibilityChange(callback) { document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); },
    loadPending: read,
    savePending(intent) {
      try { window.localStorage.setItem(storageKey, JSON.stringify(intent)); }
      finally { channel?.postMessage(intent); }
    },
    clearPending(key) { if (read()?.key === key) { window.localStorage.removeItem(storageKey); channel?.postMessage(null); } },
    onPendingChange(callback) {
      const storage = (event: StorageEvent) => { if (event.key === storageKey) callback(read()); };
      const message = (event: MessageEvent) => { callback(event.data === null ? null : parsePending(event.data)); };
      window.addEventListener("storage", storage); channel?.addEventListener("message", message);
      return () => { window.removeEventListener("storage", storage); channel?.removeEventListener("message", message); channel?.close(); };
    },
    createId: createUuidV4,
  };
}
function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}
function retryDelay(error: unknown, attempt: number): number {
  const delay = error && typeof error === "object" && "retryAfterMs" in error && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
  return Math.min(60_000, Math.max(Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)), Number.isFinite(delay) ? delay : 0));
}
type Work = { abort: AbortController; generation: number; started: number };

/** Account-owned sharing; loading consent never acquires a publisher or starts GPS. */
export function createEarthSharingController({ ownerPublicId: owner, transport, getEnvironment = browserEarthSharingEnvironment, onSessionLost = () => {} }: {
  ownerPublicId: string | null; transport: EarthSharingTransport;
  getEnvironment?: (owner: string) => EarthSharingEnvironment; onSessionLost?: () => void;
}) {
  let state = EMPTY, environment: EarthSharingEnvironment | null = null;
  let active = false, visible = false, online = false, authLost = false, generation = 0, visibilityGeneration = 0;
  let pending: EarthPendingPrivacy | null = null, privacyAttempts = 0;
  let metadata: Work | null = null, feed: Work | null = null, enabling: Work | null = null, upload: Work | null = null, privacy: Work | null = null, preferences: Work | null = null;
  const stops = new Set<AbortController>(), listeners = new Set<() => void>();
  let pollTimer: unknown = null, expiryTimer: unknown = null, publishTimer: unknown = null, privacyTimer: unknown = null;
  let publisher: string | null = null, sequence = 0, minimumFixTime = Infinity, usedFixTime = -Infinity, lastPublishAt = -Infinity;
  let queuedFix: EarthPosition | null = null, sharingDeadline = Infinity, publishedDeadline = Infinity;
  const timerEpochs = { poll: 0, expiry: 0, publish: 0, privacy: 0 };
  let serverWall = -Infinity, serverMono = 0;
  const now = () => environment!.monotonicNow();
  const foreground = () => active && !authLost && !!owner && visible && online && !!environment?.visible();
  function publish(patch: Partial<EarthSharingState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
  function cancelTimer(name: "poll" | "expiry" | "publish" | "privacy") {
    timerEpochs[name] += 1;
    const timer = name === "poll" ? pollTimer : name === "expiry" ? expiryTimer : name === "publish" ? publishTimer : privacyTimer;
    if (timer !== null) environment?.cancel(timer);
    if (name === "poll") pollTimer = null; else if (name === "expiry") expiryTimer = null; else if (name === "publish") publishTimer = null; else privacyTimer = null;
  }
  function schedule(name: "poll" | "expiry" | "publish" | "privacy", delay: number, callback: () => void) {
    cancelTimer(name);
    const epoch = generation, visibilityEpoch = visibilityGeneration, timerEpoch = timerEpochs[name];
    const timer = environment!.schedule(() => {
      if (!active || epoch !== generation || timerEpoch !== timerEpochs[name] || name !== "privacy" && visibilityEpoch !== visibilityGeneration) return;
      if (name === "poll") pollTimer = null; else if (name === "expiry") expiryTimer = null; else if (name === "publish") publishTimer = null; else privacyTimer = null;
      callback();
    }, Math.max(1, Math.min(2_147_483_647, delay)));
    if (name === "poll") pollTimer = timer; else if (name === "expiry") expiryTimer = timer; else if (name === "publish") publishTimer = timer; else privacyTimer = timer;
  }
  function work(): Work { return { abort: new AbortController(), generation, started: now() }; }
  function current(request: Work, requiresForeground = true) {
    return active && request.generation === generation && !request.abort.signal.aborted && (!requiresForeground || foreground());
  }
  function checkedSettings(value: EarthSharingSettings) {
    const parsed = earthSharingSettingsSchema.parse(value);
    if (parsed.ownerPublicId !== owner) throw new Error("Неверный владелец настроек карты");
    return parsed;
  }
  function observeServer(serverTime: string, started: number) {
    const time = now(), elapsed = Math.max(0, time - started);
    serverWall = Math.max(serverWall + Math.max(0, time - serverMono), Date.parse(serverTime) + elapsed);
    serverMono = time;
    return serverWall;
  }
  function deadline(expiresAt: string) { return now() + Math.max(0, Date.parse(expiresAt) - (serverWall + Math.max(0, now() - serverMono))); }
  function applySettings(value: EarthSharingSettings, started: number) {
    observeServer(value.serverTime, started);
    const previous = state.settings;
    if (previous && value.revision < previous.revision) return;
    const next = { ...value, publicationEpoch: null };
    if (pending) { next.mode = pending.mode; next.publicationEpoch = null; if (pending.mode === "OFF") { next.recipientCircleIds = []; next.frozenCircleIds = []; } }
    // Narrow reductions keep an existing publisher; neither a GET nor a preference
    // update can acquire one. A full enable elsewhere still fences the old epoch server-side.
    if (publisher && (value.mode !== "SHARING" || value.precision !== previous?.precision
      || value.sharingUntil !== previous?.sharingUntil || value.recipientCircleIds.some(id => !previous?.recipientCircleIds.includes(id))
      || value.recipientCircleIds.every(id => value.frozenCircleIds.includes(id)))) stopPublishing();
    if (value.sharingUntil) sharingDeadline = Math.min(sharingDeadline, deadline(value.sharingUntil));
    publish({ settings: next });
  }
  function failed(error: unknown, fallback: string) {
    if (statusOf(error) === 401 && !authLost) { authLost = true; abortForeground(); onSessionLost(); }
    publish({ error: error instanceof Error ? error.message : fallback });
  }
  function sendStop(epoch: string) {
    if (!active || authLost || !online || !owner) return;
    const controller = new AbortController(), epochGeneration = generation;
    stops.add(controller);
    void transport.stopEarthPublication({ expectedOwnerPublicId: owner, publicationEpoch: epoch }, environment!.createId(), controller.signal)
      .then(value => {
        if (!active || generation !== epochGeneration || controller.signal.aborted) return;
        if (earthPositionStoppedSchema.parse(value).ownerPublicId !== owner) throw new Error("Неверный владелец остановки публикации");
      }).catch(error => { if (active && generation === epochGeneration && !controller.signal.aborted && statusOf(error) === 401) onSessionLost(); })
      .finally(() => stops.delete(controller));
  }
  function stopPublishing() {
    if (enabling) { enabling.abort.abort(); enabling = null; publish({ saving: privacy !== null || preferences !== null }); }
    const previous = publisher; publisher = null; queuedFix = null; minimumFixTime = Infinity; publishedDeadline = Infinity;
    upload?.abort.abort(); upload = null; cancelTimer("publish");
    if (state.publishing || state.lastPublishedAt !== null) publish({ publishing: false, lastPublishedAt: null });
    if (previous) sendStop(previous);
  }
  function expirePeople() {
    if (!foreground()) return;
    const time = now();
    if (publisher && time >= sharingDeadline) stopPublishing();
    if (state.lastPublishedAt && time >= publishedDeadline) { publishedDeadline = Infinity; publish({ lastPublishedAt: null }); }
    const people = state.people.filter(person => person.expiresAtMonotonic > time);
    if (people.length !== state.people.length) publish({ people });
    const next = Math.min(publisher ? sharingDeadline : Infinity, publishedDeadline, ...people.map(person => person.expiresAtMonotonic));
    if (Number.isFinite(next)) schedule("expiry", next - time, expirePeople);
  }
  async function readMetadata() {
    if (!foreground() || pending || metadata) return;
    const request = work(); metadata = request; publish({ loading: true });
    try {
      const value = checkedSettings(await transport.getEarthSharing(request.abort.signal));
      if (!current(request) || metadata !== request || pending) return;
      applySettings(value, request.started); publish({ error: null });
    } catch (error) { if (current(request) && metadata === request) failed(error, "Не удалось загрузить настройки карты"); }
    finally { if (metadata === request) { metadata = null; if (active) publish({ loading: false }); } }
  }
  async function readPeople() {
    if (!foreground() || pending || feed) return;
    const request = work(); feed = request;
    try {
      const response = earthPeopleResponseSchema.parse(await transport.getEarthPeople(request.abort.signal));
      if (!current(request) || feed !== request || pending) return;
      if (response.ownerPublicId !== owner) throw new Error("Неверный владелец списка карты");
      observeServer(response.serverTime, request.started);
      const people = response.people.map(person => ({ ...person,
        expiresAtMonotonic: Math.min(now() + EARTH_POSITION_TTL_MS, deadline(person.expiresAt)) }))
        .filter(person => person.expiresAtMonotonic > now());
      publish({ people }); expirePeople();
    } catch (error) { if (current(request) && feed === request) failed(error, "Не удалось обновить близких на карте"); }
    finally {
      if (feed === request) { feed = null; if (foreground() && !pending) schedule("poll", EARTH_PEOPLE_POLL_MS, () => { void readPeople(); void readMetadata(); }); }
    }
  }
  function refresh() { if (pending) void flushPrivacy(); else { void readMetadata(); void readPeople(); } }
  function abortForeground() {
    visibilityGeneration += 1;
    for (const request of [metadata, feed, enabling, upload]) request?.abort.abort();
    metadata = feed = enabling = upload = null;
    for (const name of ["poll", "expiry", "publish"] as const) cancelTimer(name);
    stopPublishing(); publish({ people: [], loading: false, saving: privacy !== null || preferences !== null });
  }
  function receivePending(intent: EarthPendingPrivacy | null) {
    if (intent?.key === pending?.key) return;
    pending = intent; privacyAttempts = 0;
    if (intent) {
      preferences?.abort.abort(); preferences = null;
      abortForeground();
      const settings = state.settings ? { ...state.settings, mode: intent.mode, publicationEpoch: null,
        recipientCircleIds: intent.mode === "OFF" ? [] : state.settings.recipientCircleIds,
        frozenCircleIds: intent.mode === "OFF" ? [] : state.settings.frozenCircleIds } : null;
      publish({ settings, pendingGhost: true, pendingPrivacyMode: intent.mode });
      void flushPrivacy();
    } else {
      publish({ pendingGhost: false, pendingPrivacyMode: null });
      if (foreground()) refresh();
    }
  }
  async function flushPrivacy() {
    if (!active || authLost || !online || !pending || privacy || !owner) return;
    cancelTimer("privacy");
    const intent = pending, request = work(); privacy = request; publish({ saving: true });
    // A persisted intent can be replayed by another tab or after F5. Keep its
    // idempotency body independent of that tab's cached metadata. GHOST preserves
    // the server's current recipients and precision regardless of these fields.
    const write: EarthSharingWrite = { expectedOwnerPublicId: owner, expectedRevision: 0,
      mode: intent.mode, precision: "APPROXIMATE", recipientCircleIds: [], durationMinutes: null };
    try {
      const value = checkedSettings(await transport.updateEarthSharing(write, intent.key, request.abort.signal));
      if (!current(request, false) || privacy !== request) return;
      if (value.mode !== intent.mode) throw new Error("Сервер не подтвердил скрытие геопозиции");
      if (pending?.key === intent.key) {
        environment!.clearPending(intent.key); pending = null; privacyAttempts = 0;
        applySettings(value, request.started); publish({ pendingGhost: false, pendingPrivacyMode: null, error: null });
      }
    } catch (error) {
      if (current(request, false) && privacy === request) {
        failed(error, "Скрытие пока не подтверждено сервером");
        if (statusOf(error) !== 401 && pending && online) schedule("privacy", retryDelay(error, privacyAttempts++), () => { void flushPrivacy(); });
      }
    } finally {
      if (privacy === request) {
        privacy = null; if (active) publish({ saving: false });
        if (active && !authLost && pending && privacyTimer === null && online) void flushPrivacy();
        else if (active && !pending && foreground()) refresh();
      }
    }
  }
  function hide(mode: "GHOST" | "OFF") {
    if (!active || !owner) return;
    const intent = { mode, key: environment!.createId() };
    try { environment!.savePending(intent); } catch { publish({ error: "Не удалось сохранить команду скрытия в браузере; дождитесь подтверждения сервера" }); }
    receivePending(intent);
  }
  async function share(options: EarthShareOptions): Promise<boolean> {
    if (!foreground() || pending || enabling || preferences || !state.settings || !owner) return false;
    const write = earthSharingWriteSchema.safeParse({ ...options, mode: "SHARING", expectedOwnerPublicId: owner, expectedRevision: state.settings.revision });
    if (!write.success) { publish({ error: "Выберите близких и допустимые настройки геопозиции" }); return false; }
    stopPublishing();
    const request = work(); enabling = request; publish({ saving: true, error: null });
    try {
      const value = checkedSettings(await transport.updateEarthSharing(write.data, environment!.createId(), request.abort.signal));
      if (!current(request) || enabling !== request || pending) return false;
      if (value.mode !== "SHARING" || !value.publicationEpoch) throw new Error("Сервер не выдал разрешение публикации");
      sharingDeadline = Infinity;
      applySettings(value, request.started);
      if (value.sharingUntil && deadline(value.sharingUntil) <= now()) throw new Error("Время обмена геопозицией истекло");
      if (value.recipientCircleIds.every(id => value.frozenCircleIds.includes(id))) {
        sendStop(value.publicationEpoch); return true;
      }
      publisher = value.publicationEpoch; sequence = 0; usedFixTime = -Infinity; minimumFixTime = environment!.now(); lastPublishAt = -Infinity;
      publish({ publishing: true, lastPublishedAt: null }); expirePeople();
      return true;
    } catch (error) {
      if (current(request) && enabling === request) { failed(error, "Не удалось включить обмен геопозицией"); if (statusOf(error) === 409) void readMetadata(); }
      return false;
    } finally { if (enabling === request) { enabling = null; if (active) publish({ saving: privacy !== null || preferences !== null }); } }
  }
  async function updatePreferences(recipientCircleIds: string[], frozenCircleIds: string[]): Promise<boolean> {
    const settings = state.settings;
    if (!foreground() || pending || enabling || preferences || !settings || settings.mode === "OFF" || !owner) return false;
    const write = earthSharingWriteSchema.safeParse({ expectedOwnerPublicId: owner, expectedRevision: settings.revision,
      mode: "SHARING", precision: settings.precision, recipientCircleIds, frozenCircleIds, frozenOnly: true, durationMinutes: null });
    if (!write.success || recipientCircleIds.some(id => !settings.recipientCircleIds.includes(id))) return false;
    // Pause outbound samples while consent is changing without releasing the existing
    // lease. Success continues only an already running watch; failure stops it safely.
    upload?.abort.abort(); upload = null; queuedFix = null; cancelTimer("publish");
    const request = work(); preferences = request; publish({ saving: true, error: null });
    try {
      const value = checkedSettings(await transport.updateEarthSharing(write.data, environment!.createId(), request.abort.signal));
      if (!current(request, false) || preferences !== request || pending) return false;
      const sameIds = (first: string[], second: string[]) => first.length === second.length && first.every(id => second.includes(id));
      if (value.publicationEpoch !== null || value.revision <= settings.revision
        || value.mode !== (recipientCircleIds.length ? settings.mode : "OFF") || value.precision !== settings.precision
        || value.sharingUntil !== (recipientCircleIds.length ? settings.sharingUntil : null)
        || !sameIds(value.recipientCircleIds, recipientCircleIds) || !sameIds(value.frozenCircleIds, frozenCircleIds))
        throw new Error("Сервер не подтвердил настройки доступа");
      applySettings(value, request.started); publish({ error: null });
      return true;
    } catch (error) {
      if (current(request, false) && preferences === request) {
        stopPublishing(); failed(error, "Не удалось изменить доступ к геопозиции");
        if (statusOf(error) === 409) void readMetadata();
      }
      return false;
    } finally { if (preferences === request) { preferences = null; if (active) publish({ saving: privacy !== null || enabling !== null }); } }
  }
  function setFrozen(circleId: string, frozen: boolean) {
    const settings = state.settings;
    if (!settings || settings.mode !== "SHARING" || !foreground() || pending || enabling || preferences
      || !settings.recipientCircleIds.includes(circleId)) return Promise.resolve(false);
    const selected = new Set(settings.frozenCircleIds);
    if (selected.has(circleId) === frozen) return Promise.resolve(true);
    if (frozen) selected.add(circleId); else selected.delete(circleId);
    return updatePreferences([...settings.recipientCircleIds], [...selected]);
  }
  function revokeRecipient(circleId: string) {
    const settings = state.settings;
    if (!settings?.recipientCircleIds.includes(circleId)) return Promise.resolve(false);
    return updatePreferences(settings.recipientCircleIds.filter(id => id !== circleId), settings.frozenCircleIds.filter(id => id !== circleId));
  }
  function validFix(position: EarthPosition) {
    const age = environment!.now() - position.timestamp;
    return [position.latitude, position.longitude, position.accuracy, position.timestamp].every(Number.isFinite)
      && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180 && position.accuracy >= 0 && position.accuracy <= 100_000
      && position.timestamp >= minimumFixTime && position.timestamp > usedFixTime && age <= EARTH_POSITION_MAX_AGE_MS && age >= -EARTH_POSITION_FUTURE_MS;
  }
  async function sendPosition() {
    // An ACK owns the current request; retain only the latest new fix in RAM
    // until it settles, then apply the same freshness and 30-second budget.
    if (upload) return;
    if (!foreground() || pending || preferences || !publisher || !queuedFix || !validFix(queuedFix)) { queuedFix = null; return; }
    if (now() >= sharingDeadline) { stopPublishing(); return; }
    const remaining = lastPublishAt + EARTH_POSITION_PUBLISH_MS - now();
    if (remaining > 0) { schedule("publish", remaining, () => { void sendPosition(); }); return; }
    const position = queuedFix; queuedFix = null; usedFixTime = position.timestamp; lastPublishAt = now();
    const epoch = publisher, request = work(); upload = request;
    const coordinates = earthSharedCoordinates({ latitude: position.latitude, longitude: position.longitude, accuracyMeters: position.accuracy }, state.settings?.precision ?? "APPROXIMATE");
    // Deliberately construct only permitted fields; coordinates never enter durable storage.
    const write: EarthPositionWrite = { expectedOwnerPublicId: owner!, publicationEpoch: epoch, sequence: ++sequence,
      ...coordinates, accuracyMeters: state.settings?.precision === "APPROXIMATE" ? Math.max(EARTH_APPROXIMATE_ACCURACY_METERS, coordinates.accuracyMeters) : coordinates.accuracyMeters,
      capturedAt: new Date(position.timestamp).toISOString() };
    try {
      const value = earthPositionReceiptSchema.parse(await transport.publishEarthPosition(write, environment!.createId(), request.abort.signal));
      if (!current(request) || upload !== request || publisher !== epoch || pending) return;
      if (value.ownerPublicId !== owner) throw new Error("Неверный владелец публикации");
      observeServer(value.serverTime, request.started); publishedDeadline = Math.min(now() + EARTH_POSITION_TTL_MS, deadline(value.expiresAt));
      publish({ lastPublishedAt: value.acceptedAt, error: null }); expirePeople();
    } catch (error) {
      if (current(request) && upload === request && publisher === epoch) {
        failed(error, "Не удалось отправить геопозицию");
        if (statusOf(error) === 409 || statusOf(error) === 401) { stopPublishing(); void readMetadata(); }
      }
    } finally { if (upload === request) { upload = null; if (queuedFix) void sendPosition(); } }
  }
  function setPosition(position: EarthPosition | null) {
    queuedFix = null;
    if (!position || !foreground() || !publisher || pending || preferences || !validFix(position)) return;
    queuedFix = { ...position }; void sendPosition();
  }
  function synchronize() {
    if (!foreground()) abortForeground();
    else if (pending) void flushPrivacy(); else refresh();
  }
  return {
    configure(callbacks: { onSessionLost?: () => void }) { onSessionLost = callbacks.onSessionLost ?? (() => {}); },
    getSnapshot: () => state, getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      if (!owner) return () => {};
      active = true; authLost = false; generation += 1; environment = getEnvironment(owner);
      const removeVisibility = environment.onVisibilityChange(synchronize), removePending = environment.onPendingChange(receivePending);
      const saved = environment.loadPending(); if (saved) receivePending(saved); else synchronize();
      const epoch = generation;
      return () => {
        if (epoch !== generation) return;
        stopPublishing(); active = false; generation += 1; visibilityGeneration += 1;
        for (const request of [metadata, feed, enabling, upload, privacy, preferences]) request?.abort.abort();
        for (const controller of stops) controller.abort(); stops.clear();
        metadata = feed = enabling = upload = privacy = preferences = null;
        for (const name of ["poll", "expiry", "publish", "privacy"] as const) cancelTimer(name);
        removeVisibility(); removePending(); environment = null; publisher = null; queuedFix = null; pending = null;
        serverWall = -Infinity; sharingDeadline = publishedDeadline = Infinity; state = EMPTY;
      };
    },
    setContext(context: { visible: boolean; isOnline: boolean }) {
      const changed = visible !== context.visible || online !== context.isOnline;
      visible = context.visible; online = context.isOnline;
      if (!active || !changed) return;
      if (!online) cancelTimer("privacy");
      synchronize(); if (online && pending) void flushPrivacy();
    },
    share, setFrozen, revokeRecipient, ghost: () => hide("GHOST"), off: () => hide("OFF"), stopPublishing, refresh, setPosition,
  };
}
