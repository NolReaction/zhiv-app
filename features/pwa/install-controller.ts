import { detectInstallDevice, hasApplicationEntryLink, isDesktopInstallDevice, UNKNOWN_INSTALL_DEVICE, type InstallDevice, type InstallEnvironment } from "./install-platform";

export const INSTALL_DISMISSED_KEY = "zhiv.install-dismissed.v1";
export const INSTALL_PROMPT_TIMEOUT_MS = 15_000;
const APP_DISPLAY_MODES = ["standalone", "minimal-ui", "window-controls-overlay"] as const;
export type DeferredInstallEvent = Event & {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
export type InstallSnapshot = {
  ready: boolean;
  standalone: boolean;
  installedHere: boolean;
  canInstall: boolean;
  busy: boolean;
  browserAllowed: boolean;
  secure: boolean;
  device: InstallDevice;
  outcome: "idle" | "accepted" | "dismissed" | "error" | "timeout";
};
export const INITIAL_INSTALL_SNAPSHOT: InstallSnapshot = {
  ready: false, standalone: false, installedHere: false, canInstall: false, busy: false,
  browserAllowed: false, secure: true, device: UNKNOWN_INSTALL_DEVICE, outcome: "idle",
};
export type InstallEnvironmentAdapter = {
  events: Pick<Window, "addEventListener" | "removeEventListener">;
  media: (query: string) => Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  read: () => InstallEnvironment & { standalone: boolean; secure: boolean; pathname: string; search: string; hash: string };
  storage: () => Pick<Storage, "getItem" | "setItem">;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
};

/** Owns the one-use install event independently of whichever page displays the guide. */
export class PwaInstallController {
  private state: InstallSnapshot = INITIAL_INSTALL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private deferred: DeferredInstallEvent | null = null;
  private consumed = new WeakSet<Event>();
  private cleanup: (() => void) | null = null;
  private pending: { finish: (outcome: InstallSnapshot["outcome"] | null) => void } | null = null;
  constructor(private environment: InstallEnvironmentAdapter | null) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<InstallSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  start = () => {
    if (!this.environment || this.cleanup) return;
    const env = this.environment;
    const media = APP_DISPLAY_MODES.map(mode => env.media(`(display-mode: ${mode})`));
    const fullscreen = env.media("(display-mode: fullscreen)");
    const refresh = () => {
      const current = env.read();
      let remembered = false;
      try {
        const storage = env.storage();
        remembered = storage.getItem(INSTALL_DISMISSED_KEY) === "1"
          || ["email", "merge", "delete"].includes(storage.getItem("zhiv:account-action") ?? "")
          || Boolean(storage.getItem("zhiv.pending-direct-invite.v1"));
      } catch { /* Blocking storage must not block the browser fallback. */ }
      // Fullscreen can override the PWA display mode. It only preserves a
      // previously observed app window; fullscreen alone proves nothing.
      const standalone = current.standalone || media.some(query => query.matches) || this.state.standalone && fullscreen.matches;
      const device = detectInstallDevice(current);
      this.update({ ready: true, secure: current.secure, device, standalone,
        browserAllowed: this.state.browserAllowed || isDesktopInstallDevice(device) || standalone || remembered || hasApplicationEntryLink(current),
        canInstall: Boolean(this.deferred) && current.secure && !standalone && !this.state.installedHere && !this.state.busy });
      if (standalone) this.pending?.finish("accepted");
    };
    const beforeInstall = (raw: Event) => {
      const event = raw as DeferredInstallEvent;
      if (typeof event.prompt !== "function" || !event.userChoice || this.consumed.has(event)) return;
      event.preventDefault();
      this.deferred = event;
      if (!this.state.busy && !this.state.installedHere) this.update({ outcome: "idle" });
      refresh();
    };
    const installed = () => {
      this.deferred = null;
      this.update({ installedHere: true, canInstall: false, busy: false, outcome: "accepted" });
      this.pending?.finish("accepted");
      refresh();
    };
    env.events.addEventListener("beforeinstallprompt", beforeInstall);
    env.events.addEventListener("appinstalled", installed);
    env.events.addEventListener("pageshow", refresh);
    env.events.addEventListener("popstate", refresh);
    env.events.addEventListener("hashchange", refresh);
    // Old Safari can read display-mode without modern MediaQueryList events.
    // pageshow still refreshes the snapshot when those methods are absent.
    for (const query of [...media, fullscreen]) query.addEventListener?.("change", refresh);
    this.cleanup = () => {
      env.events.removeEventListener("beforeinstallprompt", beforeInstall);
      env.events.removeEventListener("appinstalled", installed);
      env.events.removeEventListener("pageshow", refresh);
      env.events.removeEventListener("popstate", refresh);
      env.events.removeEventListener("hashchange", refresh);
      for (const query of [...media, fullscreen]) query.removeEventListener?.("change", refresh);
    };
    refresh();
  };
  stop = () => {
    this.pending?.finish(null);
    this.cleanup?.(); this.cleanup = null;
    this.deferred = null;
    this.update({ busy: false, canInstall: false });
  };
  allowBrowser = () => {
    this.stopWaiting();
    try { this.environment?.storage().setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* Keep the in-memory choice. */ }
    this.update({ browserAllowed: true });
  };
  /** Releases this UI's wait; browsers provide no API to close their own dialog. */
  stopWaiting = () => { this.pending?.finish("idle"); };
  install = (): Promise<void> => {
    const event = this.deferred;
    if (!event || this.state.busy || !this.state.canInstall) return Promise.resolve();
    this.deferred = null;
    this.consumed.add(event);
    this.update({ busy: true, canInstall: false, outcome: "idle" });
    return new Promise(resolve => {
      let cancelTimeout = () => {};
      const attempt = { finish: (outcome: InstallSnapshot["outcome"] | null) => {
        if (this.pending !== attempt) return;
        this.pending = null;
        cancelTimeout();
        if (outcome !== null) this.update({ busy: false,
          outcome: this.state.installedHere ? "accepted" : outcome,
          canInstall: Boolean(this.deferred) && this.state.secure && !this.state.standalone && !this.state.installedHere });
        resolve();
      } };
      this.pending = attempt;
      const schedule = this.environment?.scheduleTimeout ?? ((callback: () => void, milliseconds: number) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      });
      cancelTimeout = schedule(() => attempt.finish("timeout"), INSTALL_PROMPT_TIMEOUT_MS);
      const acceptChoice = (choice: unknown) => {
        if (choice && typeof choice === "object" && "outcome" in choice && (choice.outcome === "accepted" || choice.outcome === "dismissed")) attempt.finish(choice.outcome);
      };
      try {
        // Call synchronously inside the click. Some browsers resolve only one
        // of these promises; neither may keep the UI waiting forever.
        Promise.resolve(event.prompt()).then(acceptChoice, () => attempt.finish("error"));
        Promise.resolve(event.userChoice).then(acceptChoice, () => attempt.finish("error"));
      } catch {
        Promise.resolve(event.userChoice).catch(() => {});
        attempt.finish("error");
      }
    });
  };
}

export function browserInstallEnvironment(): InstallEnvironmentAdapter | null {
  if (typeof window === "undefined") return null;
  return {
    events: window,
    media: query => window.matchMedia(query),
    read: () => {
      // Only the browser's already available brand/platform hints. No model,
      // full version, high-entropy request, tracking or persisted UA data.
      let clientHints: InstallEnvironment["clientHints"];
      try {
        const hints = (navigator as Navigator & { userAgentData?: InstallEnvironment["clientHints"] }).userAgentData;
        if (hints) clientHints = { platform: hints.platform, brands: hints.brands?.map(({ brand }) => ({ brand })) };
      } catch { /* Privacy tools may block client hints. */ }
      return { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints, clientHints,
        standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
        secure: window.isSecureContext, pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
    },
    storage: () => window.sessionStorage,
  };
}
