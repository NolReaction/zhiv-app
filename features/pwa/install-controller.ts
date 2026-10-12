import { detectInstallDevice, hasApplicationEntryLink, UNKNOWN_INSTALL_DEVICE, type InstallDevice, type InstallEnvironment } from "./install-platform";

export const INSTALL_DISMISSED_KEY = "zhiv.install-dismissed.v1";
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
  outcome: "idle" | "accepted" | "dismissed" | "error";
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
};

/** Owns the one-use install event independently of whichever page displays the guide. */
export class PwaInstallController {
  private state: InstallSnapshot = INITIAL_INSTALL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private deferred: DeferredInstallEvent | null = null;
  private consumed = new WeakSet<Event>();
  private cleanup: (() => void) | null = null;
  private generation = 0;
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
      this.update({ ready: true, secure: current.secure, device: detectInstallDevice(current), standalone,
        browserAllowed: this.state.browserAllowed || standalone || remembered || hasApplicationEntryLink(current),
        canInstall: Boolean(this.deferred) && current.secure && !standalone && !this.state.installedHere });
    };
    const beforeInstall = (raw: Event) => {
      const event = raw as DeferredInstallEvent;
      if (typeof event.prompt !== "function" || !event.userChoice || this.consumed.has(event)) return;
      event.preventDefault();
      this.deferred = event;
      refresh();
    };
    const installed = () => {
      this.deferred = null;
      this.update({ installedHere: true, canInstall: false, busy: false, outcome: "accepted" });
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
    this.generation++;
    this.cleanup?.(); this.cleanup = null;
    this.deferred = null;
    this.update({ busy: false, canInstall: false });
  };
  allowBrowser = () => {
    try { this.environment?.storage().setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* Keep the in-memory choice. */ }
    this.update({ browserAllowed: true });
  };
  install = async () => {
    const event = this.deferred;
    if (!event || this.state.busy || !this.state.canInstall) return;
    this.deferred = null;
    this.consumed.add(event);
    const generation = this.generation;
    this.update({ busy: true, canInstall: false, outcome: "idle" });
    try {
      // The native prompt starts synchronously in the click handler, before any await.
      await event.prompt();
      const choice = await event.userChoice;
      if (generation === this.generation) this.update({ busy: false, outcome: this.state.installedHere ? "accepted" : choice.outcome });
    } catch {
      if (generation === this.generation) this.update({ busy: false, outcome: this.state.installedHere ? "accepted" : "error" });
    }
  };
}

export function browserInstallEnvironment(): InstallEnvironmentAdapter | null {
  if (typeof window === "undefined") return null;
  return {
    events: window,
    media: query => window.matchMedia(query),
    read: () => ({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
      standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
      secure: window.isSecureContext, pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }),
    storage: () => window.sessionStorage,
  };
}
