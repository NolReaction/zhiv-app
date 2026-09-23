export type AppStatus = { schemaVersion: 1; buildId: string; maintenance: boolean; message?: string };
export type AppLifecycleState = { phase: "ready" | "maintenance" | "updating" | "waiting" | "retry" | "blocked"; target?: string; message?: string };
export const INITIAL_APP_LIFECYCLE: AppLifecycleState = { phase: "ready" };
export const APP_STATUS_POLL_MS = 15_000;
export const APP_RELOAD_NOTICE_MS = 2_500;
export const APP_STATUS_TIMEOUT_MS = 8_000;

export function parseAppStatus(value: unknown): AppStatus | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.buildId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(item.buildId) || typeof item.maintenance !== "boolean") return null;
  if (item.message !== undefined && (typeof item.message !== "string" || item.message.length > 500)) return null;
  return { schemaVersion: 1, buildId: item.buildId, maintenance: item.maintenance, ...(item.message ? { message: item.message as string } : {}) };
}

export type AppLifecycleEnvironment = {
  fetchStatus: (signal: AbortSignal) => Promise<unknown>;
  online: () => boolean;
  visible: () => boolean;
  attempted: (target: string) => boolean;
  prepareReload: () => boolean;
  reload: (target: string) => void;
  subscribe: (resume: () => void, pause: () => void) => () => void;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  setInterval: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

/** Status is compared to this bundle's compiled ID, never to the first server response. */
export class AppLifecycleController {
  private state = INITIAL_APP_LIFECYCLE;
  private listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  private request: AbortController | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private allowedRetry: string | undefined;

  constructor(private readonly buildId: string, private readonly env: AppLifecycleEnvironment) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: AppLifecycleState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private cancelReload() { if (this.reloadTimer !== undefined) this.env.clearTimeout(this.reloadTimer); this.reloadTimer = undefined; }
  private pause = () => {
    this.cancelReload();
    if (this.state.phase === "updating") this.publish({ ...this.state, phase: "waiting" });
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.env.subscribe(this.refresh, this.pause);
    this.interval = this.env.setInterval(this.refresh, APP_STATUS_POLL_MS);
    this.refresh();
  }

  stop() {
    this.running = false; this.generation++;
    this.cancelReload();
    this.request?.abort(); this.request = null;
    if (this.requestTimer !== undefined) this.env.clearTimeout(this.requestTimer);
    this.requestTimer = undefined;
    if (this.interval !== undefined) this.env.clearInterval(this.interval);
    this.interval = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
  }

  refresh = () => { void this.check(); };
  retry = () => { this.allowedRetry = this.state.target; this.refresh(); };

  private async check(expectedReload?: string) {
    if (!this.running || this.request || !this.env.online() || !this.env.visible()) return;
    const generation = this.generation;
    const controller = new AbortController(); this.request = controller;
    this.requestTimer = this.env.setTimeout(() => {
      controller.abort();
      if (this.request === controller) {
        this.request = null; this.requestTimer = undefined;
        this.cancelReload();
        if (this.state.phase === "updating") this.publish({ ...this.state, phase: "waiting" });
      }
    }, APP_STATUS_TIMEOUT_MS);
    try {
      const raw = await this.env.fetchStatus(controller.signal);
      if (!this.running || generation !== this.generation || controller.signal.aborted) return;
      const status = parseAppStatus(raw);
      if (!status) throw new Error("Invalid app status");
      if (!this.env.online() || !this.env.visible()) { this.pause(); return; }
      if (status.maintenance) {
        this.cancelReload();
        this.publish({ phase: "maintenance", target: status.buildId, message: status.message });
        return;
      }
      if (this.buildId === "development" || status.buildId === this.buildId) {
        this.cancelReload(); this.allowedRetry = undefined;
        this.publish(INITIAL_APP_LIFECYCLE);
        return;
      }
      const target = status.buildId;
      if (this.state.phase === "blocked" && this.state.target === target && this.allowedRetry !== target) return;
      if (this.env.attempted(target) && this.allowedRetry !== target) {
        this.cancelReload(); this.publish({ phase: "retry", target }); return;
      }
      if (expectedReload === target) {
        this.cancelReload();
        if (!this.env.prepareReload()) { this.allowedRetry = undefined; this.publish({ phase: "blocked", target }); return; }
        this.publish({ phase: "updating", target });
        this.allowedRetry = undefined;
        this.env.reload(target);
        return;
      }
      if (this.state.target !== target) this.cancelReload();
      this.publish({ phase: "updating", target });
      if (this.reloadTimer === undefined) this.reloadTimer = this.env.setTimeout(() => {
        this.reloadTimer = undefined;
        // Recheck readiness after the notice; never reload based on stale maintenance state.
        void this.check(target);
      }, APP_RELOAD_NOTICE_MS);
    } catch {
      if (!this.running || generation !== this.generation || controller.signal.aborted || this.request !== controller) return;
      this.cancelReload();
      if (this.state.phase === "updating") this.publish({ ...this.state, phase: "waiting" });
    } finally {
      if (this.request === controller) {
        this.request = null;
        if (this.requestTimer !== undefined) this.env.clearTimeout(this.requestTimer);
        this.requestTimer = undefined;
      }
    }
  }
}

const RELOAD_STORAGE_KEY = "zhiv:app-reload:v1";
const RELOAD_QUERY_KEY = "_appBuild";

export function browserAppLifecycleEnvironment(): AppLifecycleEnvironment {
  return {
    fetchStatus: async signal => {
      const response = await fetch("/app-status.json", { cache: "no-store", credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`App status ${response.status}`);
      return response.json();
    },
    online: () => navigator.onLine,
    visible: () => !document.hidden,
    attempted: target => {
      if (new URL(window.location.href).searchParams.get(RELOAD_QUERY_KEY) === target) return true;
      try { return sessionStorage.getItem(RELOAD_STORAGE_KEY) === target; } catch { return false; }
    },
    prepareReload: () => window.dispatchEvent(new Event("zhiv:before-app-reload", { cancelable: true })),
    reload: target => {
      try { sessionStorage.setItem(RELOAD_STORAGE_KEY, target); } catch { /* URL also prevents reload loops when storage is unavailable. */ }
      const url = new URL(window.location.href);
      url.searchParams.set(RELOAD_QUERY_KEY, target);
      window.location.replace(url.href);
    },
    subscribe: (resume, pause) => {
      const visibility = () => { if (document.hidden) pause(); else resume(); };
      window.addEventListener("online", resume); window.addEventListener("focus", resume);
      window.addEventListener("offline", pause); document.addEventListener("visibilitychange", visibility);
      return () => {
        window.removeEventListener("online", resume); window.removeEventListener("focus", resume);
        window.removeEventListener("offline", pause); document.removeEventListener("visibilitychange", visibility);
      };
    },
    // Native browser timers require their own receiver. Do not copy the methods onto this object.
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: timer => globalThis.clearTimeout(timer),
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: timer => globalThis.clearInterval(timer),
  };
}
