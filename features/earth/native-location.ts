import type { EarthLocationEnvironment } from "./location";

export type NativeLocationPermission = "prompt" | "prompt-with-rationale" | "granted" | "denied";
export type NativeLocationPosition = {
  timestamp: number;
  coords: { latitude: number; longitude: number; accuracy: number };
};
export type NativeLocationPort = {
  watchPosition(options: PositionOptions, callback: (position: NativeLocationPosition | null, error?: unknown) => void): Promise<string>;
  clearWatch(options: { id: string }): Promise<void>;
  checkPermissions(): Promise<{ location: NativeLocationPermission; coarseLocation?: NativeLocationPermission }>;
  requestPermissions(options: { permissions: ("location" | "coarseLocation")[] }): Promise<{ location: NativeLocationPermission; coarseLocation?: NativeLocationPermission }>;
};
export type NativeLocationAppPort = {
  getState(): Promise<{ isActive: boolean }>;
  addListener(event: "appStateChange", listener: (state: { isActive: boolean }) => void): Promise<{ remove(): Promise<void> }>;
};
export type NativeLocationDocument = {
  readonly visibilityState: string;
  addEventListener(event: "visibilitychange", listener: () => void): void;
  removeEventListener(event: "visibilitychange", listener: () => void): void;
};

function permissionState(value: Awaited<ReturnType<NativeLocationPort["checkPermissions"]>>): PermissionState {
  // Android approximate access remains usable when precise access is refused.
  if (value.location === "granted" || value.coarseLocation === "granted") return "granted";
  if (value.location === "denied" && (!value.coarseLocation || value.coarseLocation === "denied")) return "denied";
  return "prompt";
}

function positionError(error: unknown): GeolocationPositionError {
  const nativeCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = nativeCode === "OS-PLUG-GLOC-0003" || nativeCode === "OS-PLUG-GLOC-0008" ? 1
    : nativeCode === "OS-PLUG-GLOC-0010" ? 3 : 2;
  return { code, message: code === 1 ? "Location permission denied" : code === 3 ? "Location timed out" : "Location unavailable",
    PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function browserPosition(value: NativeLocationPosition): GeolocationPosition {
  const coordinates = { latitude: value.coords.latitude, longitude: value.coords.longitude, accuracy: value.coords.accuracy,
    altitude: null, altitudeAccuracy: null, heading: null, speed: null };
  const coords: GeolocationCoordinates = { ...coordinates, toJSON: () => ({ ...coordinates }) };
  return { coords, timestamp: value.timestamp, toJSON: () => ({ coords: coords.toJSON(), timestamp: value.timestamp }) };
}

/** Foreground bridge only. Native plugins and browser globals are supplied at
 * mount; importing this module does not initialize Capacitor or request access.
 * Permission and callbacks belong to one controller lifetime, not an account cache. */
export function createNativeEarthLocationEnvironment({ geolocation, app, document: visibilityDocument = typeof document === "undefined" ? undefined : document }: {
  geolocation: NativeLocationPort;
  app: NativeLocationAppPort;
  document?: NativeLocationDocument;
}): EarthLocationEnvironment {
  let nativeActive = false, lifecycleGeneration = 0, stateRevision = 0, permissionRevision = 0;
  let permission: PermissionState = "prompt";
  let nextWatchId = 0;
  let appListener: { remove(): Promise<void> } | undefined;
  const visibilityListeners = new Set<() => void>();
  const permissionListeners = new Set<() => void>();
  const watches = new Map<number, { cancelled: boolean; nativeId?: string }>();
  const visible = () => visibilityListeners.size > 0 && nativeActive && (!visibilityDocument || visibilityDocument.visibilityState === "visible");
  const notifyVisibility = () => { for (const listener of visibilityListeners) listener(); };
  const removeListener = (handle: { remove(): Promise<void> }) => {
    try { void handle.remove().catch(() => {}); } catch { /* The lifetime is already retired. */ }
  };
  const clearNativeWatch = (id: string) => {
    try { void geolocation.clearWatch({ id }).catch(() => {}); } catch { /* Late callbacks remain fenced locally. */ }
  };
  const clearWatch = (id: number) => {
    const watch = watches.get(id);
    if (!watch) return;
    watch.cancelled = true;
    watches.delete(id);
    if (watch.nativeId !== undefined) clearNativeWatch(watch.nativeId);
  };
  async function refreshPermission() {
    const generation = lifecycleGeneration, revision = ++permissionRevision;
    const next = permissionState(await geolocation.checkPermissions());
    if (generation !== lifecycleGeneration || revision !== permissionRevision || !visibilityListeners.size) return;
    if (next !== permission) {
      permission = next;
      for (const listener of permissionListeners) listener();
    }
  }
  function refreshPermissionOnResume() {
    // Disabled device services can make this query throw. The actual watch
    // reports unavailability; a query error must not manufacture a denial.
    void refreshPermission().catch(() => {});
  }
  function documentChanged() {
    if (visible()) refreshPermissionOnResume();
    notifyVisibility();
  }
  function startLifecycle() {
    const generation = ++lifecycleGeneration;
    const initialRevision = ++stateRevision;
    nativeActive = false;
    visibilityDocument?.addEventListener("visibilitychange", documentChanged);
    try {
      void app.addListener("appStateChange", state => {
        if (generation !== lifecycleGeneration || !visibilityListeners.size) return;
        stateRevision += 1;
        nativeActive = state.isActive;
        if (nativeActive) refreshPermissionOnResume();
        notifyVisibility();
      }).then(handle => {
        if (generation !== lifecycleGeneration || !visibilityListeners.size) removeListener(handle);
        else appListener = handle;
      }).catch(() => {
        // Without native lifecycle observation, document visibility alone is
        // insufficient to promise this foreground-only adapter stays paused.
        if (generation === lifecycleGeneration) { nativeActive = false; stateRevision += 1; notifyVisibility(); }
      });
      void app.getState().then(state => {
        if (generation !== lifecycleGeneration || initialRevision !== stateRevision || !visibilityListeners.size) return;
        nativeActive = state.isActive;
        if (nativeActive) refreshPermissionOnResume();
        notifyVisibility();
      }).catch(() => {});
    } catch {
      nativeActive = false;
      stateRevision += 1;
    }
  }
  function stopLifecycle() {
    lifecycleGeneration += 1;
    permissionRevision += 1;
    nativeActive = false;
    visibilityDocument?.removeEventListener("visibilitychange", documentChanged);
    if (appListener) removeListener(appListener);
    appListener = undefined;
    for (const id of watches.keys()) clearWatch(id);
    permissionListeners.clear();
  }
  return {
    secure: true,
    visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener);
      if (visibilityListeners.size === 1) startLifecycle();
      return () => {
        visibilityListeners.delete(listener);
        if (!visibilityListeners.size) stopLifecycle();
      };
    },
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    async queryPermission() {
      await refreshPermission();
      return {
        get state() { return permission; },
        subscribe(listener) {
          permissionListeners.add(listener);
          return () => { permissionListeners.delete(listener); };
        },
      };
    },
    geolocation: {
      watchPosition(success, failure, options = {}) {
        const id = ++nextWatchId, watch: { cancelled: boolean; nativeId?: string } = { cancelled: false };
        watches.set(id, watch);
        const fail = (error: unknown) => { if (!watch.cancelled && visible()) failure?.(positionError(error)); };
        const register = async () => {
          // The Android plugin requests fine permission again for a high-
          // accuracy watch. Respect an existing approximate grant on every
          // restart instead of repeatedly prompting during stationary refresh.
          let permissions: Awaited<ReturnType<NativeLocationPort["checkPermissions"]>> | undefined;
          try { permissions = await geolocation.checkPermissions(); } catch { /* The watch reports service failures. */ }
          if (watch.cancelled || !visible()) return;
          if (permissions && permissionState(permissions) !== "granted") {
            // Ask before registering a watch: clearWatch cannot cancel the
            // plugin's pending permission callback on every native platform.
            permissions = await geolocation.requestPermissions({ permissions: ["location"] });
            if (watch.cancelled || !visible()) return;
            if (permissionState(permissions) !== "granted") { fail({ code: "OS-PLUG-GLOC-0003" }); return; }
          }
          const nativeOptions = permissions?.coarseLocation === "granted" && permissions.location !== "granted"
            ? { ...options, enableHighAccuracy: false } : options;
          const nativeId = await geolocation.watchPosition(nativeOptions, (position, error) => {
            if (watch.cancelled || !visible()) return;
            if (error !== undefined && error !== null) fail(error);
            else if (position) success(browserPosition(position));
            else fail(undefined);
          });
          watch.nativeId = nativeId;
          // Permission UI and native registration can outlive stop/logout.
          if (watch.cancelled) clearNativeWatch(nativeId);
        };
        void register().catch(fail);
        return id;
      },
      clearWatch,
    },
  };
}
