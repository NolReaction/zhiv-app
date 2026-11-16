import type { NotificationPreferences } from "./notification-contract";

export type RemotePushPlatform = "ios" | "android";
export type RemotePushPermission = "default" | "granted" | "denied";
export type RemotePushConfiguration = { configured: boolean; reason: string | null; platform: RemotePushPlatform };
export type RemotePushServerSnapshot = {
  ownerPublicId: string;
  preferences: NotificationPreferences;
  delivery: { configured: boolean; reason: string | null; platform: RemotePushPlatform; categories: string[] };
  subscription: { subscribed: boolean };
};
export type RemotePushConsent = { version: 1; userId: string; ownerPublicId: string; enabled: boolean };
export type RemotePushState = {
  ownerPublicId: string | null; enabled: boolean; connected: boolean; configured: boolean;
  permission: RemotePushPermission; busy: boolean; error: string; reason: string | null;
};
export const EMPTY_REMOTE_PUSH_STATE: RemotePushState = {
  ownerPublicId: null, enabled: false, connected: false, configured: false,
  permission: "default", busy: false, error: "", reason: null,
};
export const REMOTE_PUSH_CONSENT_KEY = "mochlik.remote-push.consent.v1";
export type RemotePushPort = {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
  configuration(): Promise<RemotePushConfiguration>;
  permission(): Promise<RemotePushPermission>;
  requestPermission(): Promise<RemotePushPermission>;
  register(expectedUserId: string, expectedSessionGeneration: number): Promise<string>;
  stop(fence: { userId: string | null; generation: number }): Promise<void>;
  activate(expectedUserId: string, ownerPublicId: string, expectedSessionGeneration: number): Promise<void>;
  getSettings(owner: string, platform: RemotePushPlatform): Promise<RemotePushServerSnapshot>;
  subscribe(owner: string, platform: RemotePushPlatform, token: string): Promise<RemotePushServerSnapshot>;
  unsubscribe(owner: string, platform: RemotePushPlatform): Promise<RemotePushServerSnapshot>;
};

function readConsent(raw: string | null): RemotePushConsent | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const consent = value as Partial<RemotePushConsent>;
    return consent.version === 1 && typeof consent.userId === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(consent.userId)
      && typeof consent.ownerPublicId === "string" && /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(consent.ownerPublicId)
      && typeof consent.enabled === "boolean" ? consent as RemotePushConsent : null;
  } catch { return null; }
}
function validToken(token: string, platform: RemotePushPlatform) {
  return platform === "ios" ? /^[\da-f]{32,512}$/i.test(token) && token.length % 2 === 0
    : /^[A-Za-z0-9_:./~+=-]{16,4096}$/.test(token);
}
const changedAccount = () => new Error("Профиль изменился. Откройте настройки заново.");

/** Consent is durable; provider tokens are intentionally never persisted or logged.
 * Registration is serialized with cleanup and every awaited result is owner-fenced. */
export function createNativeRemotePush(port: RemotePushPort) {
  let state = { ...EMPTY_REMOTE_PUSH_STATE };
  let userId: string | null = null, sessionIdentity: string | null = null;
  let generation = 0, nativeGeneration = 0, consent: RemotePushConsent | null = null;
  let loaded: Promise<void> | null = null;
  let disposed = false;
  let tail = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: Partial<RemotePushState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const serial = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const hydrate = () => loaded ??= port.read().then(value => { consent = readConsent(value); }).catch(error => { loaded = null; throw error; });
  const persist = () => port.write(consent ? JSON.stringify(consent) : null);
  const capture = () => ({ userId, owner: state.ownerPublicId, generation, nativeGeneration });
  const fence = (expected: ReturnType<typeof capture>) => ({ userId: expected.userId, generation: expected.nativeGeneration });
  const current = (expected: ReturnType<typeof capture>) => !disposed && expected.generation === generation
    && expected.userId === userId && expected.owner === state.ownerPublicId;
  const assertCurrent = (expected: ReturnType<typeof capture>) => { if (!current(expected)) throw changedAccount(); };
  const owned = (expected: ReturnType<typeof capture>, value: RemotePushServerSnapshot, platform: RemotePushPlatform) => {
    assertCurrent(expected);
    if (value.ownerPublicId !== expected.owner || value.delivery.platform !== platform) throw changedAccount();
  };
  async function connect(expected: ReturnType<typeof capture>, configuration: RemotePushConfiguration, token?: string) {
    assertCurrent(expected);
    if (!expected.userId || !expected.owner || !state.enabled) return;
    const settings = await port.getSettings(expected.owner, configuration.platform);
    owned(expected, settings, configuration.platform);
    publish({ configured: configuration.configured && settings.delivery.configured, reason: configuration.reason ?? settings.delivery.reason });
    if (!configuration.configured || !settings.delivery.configured) return;
    const permission = await port.permission();
    assertCurrent(expected); publish({ permission });
    if (permission !== "granted") {
      await port.stop(fence(expected));
      assertCurrent(expected);
      await port.unsubscribe(expected.owner, configuration.platform);
      assertCurrent(expected); publish({ connected: false });
      return;
    }
    const freshToken = token ?? await port.register(expected.userId, expected.nativeGeneration);
    assertCurrent(expected);
    if (!validToken(freshToken, configuration.platform)) throw new Error("Телефон вернул некорректный адрес доставки уведомлений.");
    await port.activate(expected.userId, expected.owner, expected.nativeGeneration);
    assertCurrent(expected);
    const result = await port.subscribe(expected.owner, configuration.platform, freshToken);
    owned(expected, result, configuration.platform);
    if (!result.subscription.subscribed) throw new Error("Не удалось подтвердить подключение уведомлений.");
    publish({ connected: true, error: "", reason: null });
  }
  async function attempt(expected: ReturnType<typeof capture>, action: () => Promise<void>) {
    if (!current(expected)) return;
    publish({ busy: true, error: "" });
    try { await action(); }
    catch (cause) {
      if (current(expected)) {
        publish({ connected: false, configured: false, error: cause instanceof Error ? cause.message : "Не удалось подключить сообщения сервера." });
        await port.stop(fence(expected)).catch(() => undefined);
      }
      throw cause;
    } finally { if (current(expected)) publish({ busy: false }); }
  }
  function refresh() {
    const expected = capture();
    return serial(() => attempt(expected, async () => {
      await hydrate(); assertCurrent(expected);
      const configuration = await port.configuration(); assertCurrent(expected);
      const permission = await port.permission(); assertCurrent(expected);
      publish({ reason: configuration.reason, permission });
      if (!configuration.configured || !expected.owner || !expected.userId) publish({ configured: false, connected: false });
      if (!expected.owner || !expected.userId) return;
      const snapshot = await port.getSettings(expected.owner, configuration.platform);
      owned(expected, snapshot, configuration.platform);
      publish({ configured: configuration.configured && snapshot.delivery.configured,
        reason: configuration.reason ?? snapshot.delivery.reason,
        connected: state.connected && configuration.configured && snapshot.delivery.configured && snapshot.subscription.subscribed });
      if (state.enabled && configuration.configured && snapshot.delivery.configured) await connect(expected, configuration);
      else {
        await port.stop(fence(expected)); assertCurrent(expected);
        if (!state.enabled && snapshot.subscription.subscribed) await port.unsubscribe(expected.owner, configuration.platform);
        assertCurrent(expected); publish({ connected: false });
      }
    }));
  }
  return {
    dispose() { disposed = true; generation++; listeners.clear(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    async setSession(session: { authenticated: boolean; userId?: string; expiresAt?: string; generation?: number }) {
      if (disposed || (session.generation !== undefined && session.generation < nativeGeneration)) return;
      const nextUser = session.authenticated ? session.userId ?? null : null;
      const nextIdentity = nextUser ? `${nextUser}:${session.expiresAt ?? ""}:${session.generation ?? 0}` : null;
      if (sessionIdentity === nextIdentity && loaded) return;
      sessionIdentity = nextIdentity; userId = nextUser; nativeGeneration = session.generation ?? 0; generation++;
      publish({ ...EMPTY_REMOTE_PUSH_STATE });
      const version = generation;
      const expected = capture();
      await serial(async () => {
        await hydrate();
        if (version !== generation) return;
        if (consent?.userId !== nextUser || !nextUser) {
          consent = null;
          await port.stop(fence(expected));
          if (version !== generation) return;
          await persist();
        }
        if (version !== generation) return;
        publish({ ownerPublicId: consent?.ownerPublicId ?? null, enabled: consent?.enabled ?? false });
      });
      if (version === generation && nextUser) await refresh();
    },
    async setOwner(owner: string | null) {
      if (owner === state.ownerPublicId || !userId) return;
      generation++;
      publish({ ...EMPTY_REMOTE_PUSH_STATE, ownerPublicId: owner });
      const expected = capture();
      await serial(async () => {
        await hydrate(); assertCurrent(expected);
        if (consent?.userId === expected.userId && consent.ownerPublicId === owner) {
          publish({ enabled: consent.enabled });
        } else {
          consent = null;
          await port.stop(fence(expected)); assertCurrent(expected);
          await persist(); assertCurrent(expected);
        }
      });
      if (owner && current(expected)) await refresh();
    },
    refresh,
    enable(owner: string) {
      const expected = capture();
      if (owner !== expected.owner || !expected.userId || !state.configured || state.busy) return Promise.reject(changedAccount());
      // This is the sole permission prompt, reached only from the user's button.
      const permission = port.requestPermission();
      void permission.catch(() => undefined);
      return serial(() => { assertCurrent(expected); return attempt(expected, async () => {
        const granted = await permission; assertCurrent(expected); publish({ permission: granted });
        if (granted !== "granted") throw new Error("Разрешите уведомления в настройках приложения на телефоне.");
        await hydrate(); assertCurrent(expected);
        const saved: RemotePushConsent = { version: 1, userId: expected.userId!, ownerPublicId: owner, enabled: true };
        await port.write(JSON.stringify(saved)); assertCurrent(expected);
        consent = saved;
        publish({ enabled: true });
        const configuration = await port.configuration(); assertCurrent(expected);
        await connect(expected, configuration);
      }); });
    },
    disable(owner: string) {
      if (owner !== state.ownerPublicId || !userId) return Promise.reject(changedAccount());
      generation++;
      publish({ enabled: false, connected: false, error: "" });
      const expected = capture();
      // Stop native display immediately; queued network work may be slow or offline.
      const stopped = port.stop(fence(expected));
      void stopped.catch(() => undefined);
      return serial(() => attempt(expected, async () => {
        await hydrate(); assertCurrent(expected);
        consent = { version: 1, userId: expected.userId!, ownerPublicId: owner, enabled: false };
        await persist(); assertCurrent(expected);
        await stopped; assertCurrent(expected);
        const configuration = await port.configuration(); assertCurrent(expected);
        await port.unsubscribe(owner, configuration.platform); assertCurrent(expected);
      }));
    },
    tokenChanged(token: string) {
      const expected = capture();
      if (!state.enabled || !expected.owner || !expected.userId) return Promise.resolve();
      return serial(() => attempt(expected, async () => {
        const configuration = await port.configuration(); assertCurrent(expected);
        await connect(expected, configuration, token);
      }));
    },
  };
}
export type NativeRemotePush = ReturnType<typeof createNativeRemotePush>;
let installed: NativeRemotePush | null = null;
export function configureNativeRemotePush(value: NativeRemotePush | null) { installed = value; }
export function getNativeRemotePush() { return installed; }
