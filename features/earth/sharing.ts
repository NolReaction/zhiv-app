import { createUuidV4 } from "@/lib/browser-uuid";
import {
  EARTH_APPROXIMATE_ACCURACY_METERS, EARTH_PEOPLE_POLL_MS, EARTH_POSITION_FUTURE_MS,
  EARTH_POSITION_MAX_AGE_MS, EARTH_POSITION_PUBLISH_MS, EARTH_POSITION_TTL_MS, EARTH_SETTINGS_POLL_MS,
  earthPeopleResponseSchema, earthPositionReceiptSchema, earthPositionStoppedSchema,
  earthSharingSettingsSchema, earthSharingWriteSchema, earthSharedCoordinates,
  type EarthMapPerson, type EarthPeopleResponse, type EarthPositionReceipt, type EarthPositionStop,
  type EarthPositionStopped, type EarthPositionWrite, type EarthSharingDuration,
  type EarthSharingPrecision, type EarthSharingResume, type EarthSharingSettings, type EarthSharingWrite,
} from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";

export type EarthShareOptions = { recipientCircleIds: string[]; frozenCircleIds?: string[]; precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration; preserveSharingUntil?: boolean };
export type EarthPendingPrivacy = { mode: "GHOST" | "OFF"; key: string };
export type EarthSharingTransport = {
  getEarthSharing(signal?: AbortSignal): Promise<EarthSharingSettings>;
  updateEarthSharing(write: EarthSharingWrite, key: string, signal?: AbortSignal): Promise<EarthSharingSettings>;
  resumeEarthSharing(write: EarthSharingResume, key: string, signal?: AbortSignal): Promise<EarthSharingSettings>;
  publishEarthPosition(write: EarthPositionWrite, key: string, signal?: AbortSignal): Promise<EarthPositionReceipt>;
  stopEarthPublication(write: EarthPositionStop, key: string, signal?: AbortSignal): Promise<EarthPositionStopped>;
  getEarthPeople(signal?: AbortSignal): Promise<EarthPeopleResponse>;
};
export type EarthSharingState = {
  settings: EarthSharingSettings | null; people: EarthMapPerson[]; loading: boolean; saving: boolean;
  error: string | null; pendingGhost: boolean; pendingPrivacyMode: "GHOST" | "OFF" | null;
  publishing: boolean; lastPublishedAt: string | null;
  publicationError: string | null;
  /** A lease counter for requesting a fresh private GPS fix; never exposes its capability. */
  publicationGeneration: number;
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
  pendingGhost: false, pendingPrivacyMode: null, publishing: false, lastPublishedAt: null, publicationError: null, publicationGeneration: 0 };
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

/** Account-owned sharing resumes only the confirmed audience on a visible map. GPS is separate. */
export function createEarthSharingController({ ownerPublicId: owner, transport, getEnvironment = browserEarthSharingEnvironment, onSessionLost = () => {} }: {
  ownerPublicId: string | null; transport: EarthSharingTransport;
  getEnvironment?: (owner: string) => EarthSharingEnvironment; onSessionLost?: () => void;
}) {
  let state = EMPTY, environment: EarthSharingEnvironment | null = null;
  let active = false, visible = false, publicationVisible = false, online = false, authLost = false, generation = 0, visibilityGeneration = 0;
  let automaticResumeAllowed = true, publicationCycleActive = false, resumeAttempted = false, resumeNotBefore = -Infinity;
  let automaticResumeRetries = 0;
  let readNotBefore = -Infinity;
  let pending: EarthPendingPrivacy | null = null, privacyAttempts = 0;
  let metadata: Work | null = null, feed: Work | null = null, enabling: Work | null = null, resuming: Work | null = null, upload: Work | null = null, privacy: Work | null = null, preferences: Work | null = null;
  const stops = new Set<AbortController>(), listeners = new Set<() => void>();
  const timers: Record<"poll" | "settings" | "expiry" | "publish" | "privacy", unknown> = { poll: null, settings: null, expiry: null, publish: null, privacy: null };
  let publisher: string | null = null, sequence = 0, minimumFixTime = Infinity, usedFixTime = -Infinity, lastPublishAt = -Infinity;
  let queuedFix: EarthPosition | null = null, sharingDeadline = Infinity, publishedDeadline = Infinity;
  const timerEpochs = { poll: 0, settings: 0, expiry: 0, publish: 0, privacy: 0 };
  let serverWall = -Infinity, serverMono = 0;
  const now = () => environment!.monotonicNow();
  const foreground = () => active && !authLost && !!owner && visible && online && !!environment?.visible();
  const publicationForeground = () => foreground() && publicationVisible;
  function publish(patch: Partial<EarthSharingState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
  function cancelTimer(name: keyof typeof timers) {
    timerEpochs[name] += 1;
    const timer = timers[name];
    if (timer !== null) environment?.cancel(timer);
    timers[name] = null;
  }
  function schedule(name: keyof typeof timers, delay: number, callback: () => void) {
    cancelTimer(name);
    const epoch = generation, visibilityEpoch = visibilityGeneration, timerEpoch = timerEpochs[name];
    const timer = environment!.schedule(() => {
      if (!active || epoch !== generation || timerEpoch !== timerEpochs[name] || name !== "privacy" && visibilityEpoch !== visibilityGeneration) return;
      timers[name] = null;
      callback();
    }, Math.max(1, Math.min(2_147_483_647, delay)));
    timers[name] = timer;
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
  function stopPublishing(reason?: string) {
    resumeAttempted = true;
    if (enabling) { enabling.abort.abort(); enabling = null; publish({ saving: privacy !== null || preferences !== null }); }
    if (resuming) { resuming.abort.abort(); resuming = null; publish({ saving: privacy !== null || preferences !== null }); }
    const previous = publisher; publisher = null; queuedFix = null; minimumFixTime = Infinity;
    upload?.abort.abort(); upload = null; cancelTimer("publish");
    if (state.publishing || reason) publish({ publishing: false, ...(reason ? { publicationError: reason } : {}) });
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
  function deferRateLimitedReads(error: unknown) {
    if (statusOf(error) !== 429) return;
    const supplied = error && typeof error === "object" && "retryAfterMs" in error ? error.retryAfterMs : undefined;
    // Both GETs spend the same server bucket. Its Retry-After can cover the
    // remainder of an hour, so the short write-retry cap must not apply here.
    const delay = typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0 ? supplied : 60_000;
    readNotBefore = Math.max(readNotBefore, now() + Math.max(1_000, delay));
    schedule("poll", Math.max(EARTH_PEOPLE_POLL_MS, readNotBefore - now()), () => { void readPeople(); });
    schedule("settings", Math.max(EARTH_SETTINGS_POLL_MS, readNotBefore - now()), () => { void readMetadata(); });
  }
  async function readMetadata() {
    if (!foreground() || pending || metadata) return;
    if (now() < readNotBefore) { schedule("settings", readNotBefore - now(), () => { void readMetadata(); }); return; }
    const request = work(); metadata = request; publish({ loading: true });
    try {
      const value = checkedSettings(await transport.getEarthSharing(request.abort.signal));
      if (!current(request) || metadata !== request || pending) return;
      applySettings(value, request.started); publish({ error: null }); maybeResumeAutomatically();
    } catch (error) { if (current(request) && metadata === request) { deferRateLimitedReads(error); failed(error, "Не удалось загрузить настройки карты"); } }
    finally { if (metadata === request) {
      metadata = null; if (active) publish({ loading: false });
      if (foreground() && !pending) schedule("settings", Math.max(EARTH_SETTINGS_POLL_MS, readNotBefore - now()), () => { void readMetadata(); });
    } }
  }
  async function readPeople() {
    if (!foreground() || pending || feed) return;
    if (now() < readNotBefore) { schedule("poll", readNotBefore - now(), () => { void readPeople(); }); return; }
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
    } catch (error) { if (current(request) && feed === request) { deferRateLimitedReads(error); failed(error, "Не удалось обновить близких на карте"); } }
    finally {
      if (feed === request) { feed = null; if (foreground() && !pending) schedule("poll", Math.max(EARTH_PEOPLE_POLL_MS, readNotBefore - now()), () => { void readPeople(); }); }
    }
  }
  function refresh() { if (pending) void flushPrivacy(); else { void readMetadata(); void readPeople(); } }
  function abortForeground() {
    visibilityGeneration += 1;
    for (const request of [metadata, feed, enabling, resuming, upload]) request?.abort.abort();
    metadata = feed = enabling = resuming = upload = null;
    for (const name of ["poll", "settings", "expiry", "publish"] as const) cancelTimer(name);
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
      if (intent.mode === "OFF") publishedDeadline = Infinity;
      publish({ settings, pendingGhost: true, pendingPrivacyMode: intent.mode,
        ...(intent.mode === "OFF" ? { lastPublishedAt: null, publicationError: null } : {}) });
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
        if (active && !authLost && pending && timers.privacy === null && online) void flushPrivacy();
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
  const sameIds = (first: string[], second: string[]) => first.length === second.length && first.every(id => second.includes(id));
  function hasLiveAudience(settings: EarthSharingSettings) {
    return settings.recipientCircleIds.some(id => !settings.frozenCircleIds.includes(id));
  }
  function consentUnexpired(settings: EarthSharingSettings) {
    return !settings.sharingUntil || deadline(settings.sharingUntil) > now();
  }
  function adoptPublisher(value: EarthSharingSettings) {
    publisher = value.publicationEpoch;
    sequence = 0; usedFixTime = -Infinity; minimumFixTime = environment!.now(); lastPublishAt = -Infinity; queuedFix = null;
    publish({ publishing: true, publicationError: null, publicationGeneration: state.publicationGeneration + 1 });
    expirePeople();
  }
  function maybeResumeAutomatically() {
    const settings = state.settings;
    if (!publicationForeground() || !automaticResumeAllowed || resumeAttempted || pending || publisher || enabling || resuming || preferences
      || !settings || settings.mode !== "SHARING" || !hasLiveAudience(settings) || !consentUnexpired(settings) || now() < resumeNotBefore) return;
    resumeAttempted = true;
    void resumePublication(false, true);
  }
  async function resumePublication(resumeGhost = false, automatically = false): Promise<boolean> {
    const settings = state.settings;
    if (!foreground() || pending || enabling || resuming || preferences || !settings || !owner || now() < resumeNotBefore
      || settings.mode === "OFF" || settings.mode === "GHOST" && !resumeGhost || !consentUnexpired(settings)
      || !hasLiveAudience(settings) && !resumeGhost || automatically && (!publicationForeground() || !automaticResumeAllowed)) return false;
    stopPublishing();
    const request = work(); resuming = request; publish({ saving: true, error: null });
    try {
      const value = checkedSettings(await transport.resumeEarthSharing({ expectedOwnerPublicId: owner,
        expectedRevision: settings.revision, resumeGhost }, environment!.createId(), request.abort.signal));
      if (!current(request) || resuming !== request || pending || automatically && !automaticResumeAllowed
        || (state.settings?.revision ?? -1) > value.revision) {
        if (value.mode === "SHARING" && value.publicationEpoch) sendStop(value.publicationEpoch);
        return false;
      }
      if (value.mode !== "SHARING" || value.revision <= settings.revision || value.precision !== settings.precision
        || value.sharingUntil !== settings.sharingUntil || !sameIds(value.recipientCircleIds, settings.recipientCircleIds)
        || !sameIds(value.frozenCircleIds, settings.frozenCircleIds) || hasLiveAudience(value) !== !!value.publicationEpoch) {
        if (value.publicationEpoch) sendStop(value.publicationEpoch);
        throw new Error("Сервер не подтвердил прежние настройки геопозиции");
      }
      sharingDeadline = Infinity;
      applySettings(value, request.started);
      if (!consentUnexpired(value)) { if (value.publicationEpoch) sendStop(value.publicationEpoch); throw new Error("Время обмена геопозицией истекло"); }
      if (publicationForeground() && value.publicationEpoch) adoptPublisher(value);
      else if (value.publicationEpoch) sendStop(value.publicationEpoch);
      void readPeople();
      return true;
    } catch (error) {
      if (current(request) && resuming === request) {
        if (statusOf(error) === 409 || statusOf(error) === 429) resumeNotBefore = now() + Math.max(5_000, retryDelay(error, 4));
        // One temporary connection/server failure on app startup must not leave
        // a consenting stationary player unpublished for the whole session.
        // Retry once through the ordinary metadata poll; conflicts and limits
        // remain fenced so two devices cannot continually steal a publisher.
        const status = statusOf(error);
        if (automatically && (status === undefined || status >= 500) && automaticResumeRetries < 1) {
          automaticResumeRetries += 1;
          resumeNotBefore = now() + EARTH_SETTINGS_POLL_MS;
          resumeAttempted = false;
        }
        failed(error, "Не удалось возобновить геопозицию");
        if (statusOf(error) === 409) void readMetadata();
      }
      return false;
    } finally { if (resuming === request) { resuming = null; if (active) publish({ saving: privacy !== null || preferences !== null || enabling !== null }); } }
  }
  async function share(options: EarthShareOptions): Promise<boolean> {
    if (!foreground() || pending || enabling || preferences || !state.settings || !owner) return false;
    const previous = state.settings;
    const write = earthSharingWriteSchema.safeParse({ ...options, mode: "SHARING", expectedOwnerPublicId: owner, expectedRevision: previous.revision });
    if (!write.success) { publish({ error: "Выберите близких и допустимые настройки геопозиции" }); return false; }
    stopPublishing();
    const request = work(); enabling = request; publish({ saving: true, error: null });
    try {
      const value = checkedSettings(await transport.updateEarthSharing(write.data, environment!.createId(), request.abort.signal));
      if (!current(request) || enabling !== request || pending || (state.settings?.revision ?? -1) > value.revision) {
        // An aborted transport can still have committed on the server. Retire
        // only its acknowledged epoch; this cannot stop a later explicit share.
        if (value.mode === "SHARING" && value.publicationEpoch) sendStop(value.publicationEpoch);
        return false;
      }
      const preservedGhost = options.preserveSharingUntil === true && previous.mode === "GHOST";
      if (options.preserveSharingUntil && (value.mode !== previous.mode || value.precision !== previous.precision
        || value.sharingUntil !== previous.sharingUntil || !sameIds(value.recipientCircleIds, options.recipientCircleIds)
        || !sameIds(value.frozenCircleIds, options.frozenCircleIds ?? []))) {
        if (value.publicationEpoch) sendStop(value.publicationEpoch);
        throw new Error("Сервер не сохранил прежние настройки геопозиции");
      }
      if (preservedGhost ? value.publicationEpoch !== null : value.mode !== "SHARING" || hasLiveAudience(value) && !value.publicationEpoch)
        throw new Error("Сервер не выдал разрешение публикации");
      sharingDeadline = Infinity;
      applySettings(value, request.started);
      if (value.sharingUntil && deadline(value.sharingUntil) <= now()) {
        if (value.publicationEpoch) sendStop(value.publicationEpoch);
        throw new Error("Время обмена геопозицией истекло");
      }
      if (preservedGhost || !publicationForeground() || !hasLiveAudience(value)) {
        if (value.publicationEpoch) sendStop(value.publicationEpoch);
        void readPeople(); return true;
      }
      adoptPublisher(value); void readPeople();
      return true;
    } catch (error) {
      if (current(request) && enabling === request) { failed(error, "Не удалось включить обмен геопозицией"); if (statusOf(error) === 409) void readMetadata(); }
      return false;
    } finally { if (enabling === request) { enabling = null; if (active) publish({ saving: privacy !== null || preferences !== null }); } }
  }
  async function updatePreferences(recipientCircleIds: string[], frozenCircleIds: string[]): Promise<boolean> {
    const settings = state.settings;
    if (!foreground() || pending || enabling || resuming || preferences || !settings || settings.mode === "OFF" || !owner) return false;
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
      if (value.publicationEpoch !== null || value.revision <= settings.revision
        || value.mode !== (recipientCircleIds.length ? settings.mode : "OFF") || value.precision !== settings.precision
        || value.sharingUntil !== (recipientCircleIds.length ? settings.sharingUntil : null)
        || !sameIds(value.recipientCircleIds, recipientCircleIds) || !sameIds(value.frozenCircleIds, frozenCircleIds))
        throw new Error("Сервер не подтвердил настройки доступа");
      applySettings(value, request.started); publish({ error: null }); void readPeople();
      return true;
    } catch (error) {
      if (current(request, false) && preferences === request) {
        stopPublishing(); failed(error, "Не удалось изменить доступ к геопозиции");
        if (statusOf(error) === 409) void readMetadata();
      }
      return false;
    } finally { if (preferences === request) { preferences = null; if (active) publish({ saving: privacy !== null || enabling !== null }); } }
  }
  async function setFrozen(circleId: string, frozen: boolean) {
    const settings = state.settings;
    if (!settings || settings.mode !== "SHARING" || !foreground() || pending || enabling || resuming || preferences
      || !settings.recipientCircleIds.includes(circleId)) return false;
    const selected = new Set(settings.frozenCircleIds);
    if (selected.has(circleId) === frozen) return true;
    if (frozen) selected.add(circleId); else selected.delete(circleId);
    const accepted = await updatePreferences([...settings.recipientCircleIds], [...selected]);
    if (accepted && !frozen && publicationForeground() && !publisher) return resumePublication();
    return accepted;
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
    if (!publicationForeground() || pending || preferences || !publisher || !queuedFix || !validFix(queuedFix)) { queuedFix = null; return; }
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
      publish({ lastPublishedAt: value.acceptedAt, publicationError: null, error: null }); expirePeople();
    } catch (error) {
      if (current(request) && upload === request && publisher === epoch) {
        publish({ publicationError: error instanceof Error ? error.message : "Не удалось отправить геопозицию" });
        failed(error, "Не удалось отправить геопозицию");
        if (statusOf(error) === 409 || statusOf(error) === 401) { stopPublishing(); void readMetadata(); }
      }
    } finally { if (upload === request) { upload = null; if (queuedFix) void sendPosition(); } }
  }
  function setPosition(position: EarthPosition | null) {
    queuedFix = null;
    if (!position || !publicationForeground() || !publisher || pending || preferences || !validFix(position)) return;
    queuedFix = { ...position }; void sendPosition();
  }
  function synchronize() {
    const nextPublicationCycle = publicationForeground() && automaticResumeAllowed;
    if (publicationCycleActive !== nextPublicationCycle) {
      publicationCycleActive = nextPublicationCycle;
      if (nextPublicationCycle) { resumeAttempted = false; automaticResumeRetries = 0; }
    }
    if (!foreground()) abortForeground();
    else if (pending) void flushPrivacy(); else refresh();
  }
  return {
    configure(callbacks: { onSessionLost?: () => void }) { onSessionLost = callbacks.onSessionLost ?? (() => {}); },
    setAutomaticResumeAllowed(value: boolean) {
      if (automaticResumeAllowed === value) return;
      automaticResumeAllowed = value;
      if (!value) stopPublishing();
      if (active) synchronize();
    },
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
        for (const request of [metadata, feed, enabling, resuming, upload, privacy, preferences]) request?.abort.abort();
        for (const controller of stops) controller.abort(); stops.clear();
        metadata = feed = enabling = resuming = upload = privacy = preferences = null;
        for (const name of ["poll", "settings", "expiry", "publish", "privacy"] as const) cancelTimer(name);
        removeVisibility(); removePending(); environment = null; publisher = null; queuedFix = null; pending = null;
        serverWall = -Infinity; sharingDeadline = publishedDeadline = Infinity; publicationCycleActive = false; state = EMPTY;
      };
    },
    setContext(context: { visible: boolean; isOnline: boolean; publicationVisible?: boolean; automaticResumeAllowed?: boolean }) {
      const nextPublicationVisible = context.publicationVisible ?? context.visible;
      const nextAutomaticResumeAllowed = context.automaticResumeAllowed ?? true;
      const changed = visible !== context.visible || online !== context.isOnline || publicationVisible !== nextPublicationVisible || automaticResumeAllowed !== nextAutomaticResumeAllowed;
      visible = context.visible; online = context.isOnline; publicationVisible = nextPublicationVisible; automaticResumeAllowed = nextAutomaticResumeAllowed;
      if (!active || !changed) return;
      if (!publicationVisible || !automaticResumeAllowed) stopPublishing();
      if (!online) cancelTimer("privacy");
      synchronize(); if (online && pending) void flushPrivacy();
    },
    share, resume: (resumeGhost = false) => resumePublication(resumeGhost), setFrozen, revokeRecipient,
    ghost: () => hide("GHOST"), off: () => hide("OFF"), stopPublishing, refresh, setPosition,
  };
}
