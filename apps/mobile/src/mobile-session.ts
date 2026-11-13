import type { NativeSessionState } from "./native-bridge";

export type MobileSessionSnapshot = {
  phase: "loading" | "signed-out" | "authenticated" | "error";
  userId: string | null;
  busy: boolean;
  error: string | null;
  generation: number;
};
type SessionPort = {
  getState(): Promise<NativeSessionState>;
  login(): Promise<NativeSessionState>;
  cancelLogin(): Promise<void>;
  subscribe(listener: (state: NativeSessionState) => void): Promise<() => void>;
  hydrate(userId?: string): Promise<void>;
};

/** Unmount the former account before its storage is replaced; serialize hydration. */
export function createMobileSession(port: SessionPort) {
  let snapshot: MobileSessionSnapshot = { phase: "loading", userId: null, busy: false, error: null, generation: 0 };
  const listeners = new Set<() => void>();
  let epoch = 0;
  let desired: string | undefined;
  let storageQueue = Promise.resolve();
  let pending: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  let alive = true;
  let loginBusy = false;
  const publish = (next: Partial<MobileSessionSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  function accept(state: NativeSessionState): Promise<void> {
    const key = state.configured ? state.authenticated && state.userId ? state.userId : "signed-out" : "unconfigured";
    if (key === desired && (pending || snapshot.phase !== "error")) return pending ?? Promise.resolve();
    desired = key;
    const version = ++epoch;
    publish({ phase: "loading", userId: null, error: null, generation: version });
    const operation = storageQueue.then(async () => {
      if (!alive || version !== epoch) return;
      if (!state.configured) throw new Error("Сервер приложения не настроен. Установите новую сборку.");
      if (state.authenticated && !state.userId) throw new Error("Не удалось проверить аккаунт. Войдите ещё раз.");
      await port.hydrate(state.authenticated ? state.userId : undefined);
      if (!alive || version !== epoch) return;
      publish({ phase: state.authenticated ? "authenticated" : "signed-out", userId: state.userId ?? null, error: null });
    });
    storageQueue = operation.catch(() => {});
    pending = operation.catch(error => {
      if (alive && version === epoch) publish({ phase: "error", userId: null,
        error: error instanceof Error ? error.message : "Не удалось открыть данные приложения. Повторите попытку." });
      throw error;
    }).finally(() => { if (version === epoch) pending = undefined; });
    return pending;
  }
  async function refresh() {
    const version = epoch;
    try {
      const state = await port.getState();
      if (alive && version === epoch) await accept(state);
    } catch {
      if (alive && version === epoch) publish({ phase: "error", userId: null,
        error: "Не удалось открыть данные приложения. Проверьте сборку и повторите попытку." });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() {
      stop = await port.subscribe(state => { void accept(state).catch(() => {}); });
      if (!alive) { stop(); return; }
      await refresh();
    },
    refresh,
    async login() {
      if (loginBusy) return;
      loginBusy = true; publish({ busy: true, error: null });
      try { await accept(await port.login()); }
      catch (error) {
        if (alive && snapshot.phase !== "authenticated") publish({ error: "Вход не завершён. Вернитесь из браузера или попробуйте ещё раз." });
        throw error;
      } finally { loginBusy = false; if (alive) publish({ busy: false }); }
    },
    async cancelLogin() { await port.cancelLogin(); },
    dispose() { alive = false; ++epoch; stop?.(); listeners.clear(); },
  };
}

export type MobileSession = ReturnType<typeof createMobileSession>;
