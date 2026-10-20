export type EarthPosition = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};

export type EarthLocationStatus =
  | "idle" | "requesting" | "active" | "paused"
  | "denied" | "unavailable" | "timeout" | "unsupported" | "insecure";

export type EarthLocationState = {
  position: EarthPosition | null;
  status: EarthLocationStatus;
  error: string | null;
};

type LocationPermission = {
  readonly state: PermissionState;
  subscribe: (listener: () => void) => () => void;
};

export type EarthLocationEnvironment = {
  secure: boolean;
  geolocation: Pick<Geolocation, "watchPosition" | "clearWatch"> | null;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  queryPermission?: () => Promise<LocationPermission>;
};

const IDLE: EarthLocationState = { position: null, status: "idle", error: null };
const ERRORS = {
  denied: "Доступ к геопозиции отключён. Разреши его в настройках браузера и нажми «Где я» ещё раз.",
  unavailable: "Не удалось определить местоположение. Проверь геолокацию устройства и попробуй ещё раз.",
  timeout: "Определение местоположения заняло слишком много времени. Попробуй ещё раз.",
  unsupported: "Этот браузер не поддерживает определение местоположения.",
  insecure: "Геопозиция доступна по HTTPS или на localhost. Открой защищённую версию приложения.",
} as const;

/** Accept only usable browser coordinates; no altitude, heading or speed is retained. */
export function readEarthPosition(value: GeolocationPosition): EarthPosition | null {
  const { latitude, longitude, accuracy } = value.coords;
  const timestamp = value.timestamp;
  if (![latitude, longitude, accuracy, timestamp].every(Number.isFinite)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
    || accuracy < 0 || timestamp < 0) return null;
  return { latitude, longitude, accuracy, timestamp };
}

/** The browser adapter is created on mount, never during SSR or a React render. */
export function browserEarthLocationEnvironment(): EarthLocationEnvironment {
  return {
    secure: window.isSecureContext,
    geolocation: navigator.geolocation ?? null,
    visible: () => document.visibilityState === "visible",
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    queryPermission: navigator.permissions?.query ? async () => {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      return {
        get state() { return permission.state; },
        subscribe(listener) {
          permission.addEventListener("change", listener);
          return () => permission.removeEventListener("change", listener);
        },
      };
    } : undefined,
  };
}

/**
 * One foreground session belongs to one account and lives only in memory.
 * The optional initial private lookup requires an already granted permission.
 * Explicit start() remains separate from permission probing and friend sharing.
 */
export function createEarthLocationController(
  ownerPublicId: string,
  getEnvironment: () => EarthLocationEnvironment = browserEarthLocationEnvironment,
) {
  let state = IDLE;
  const listeners = new Set<() => void>();
  let environment: EarthLocationEnvironment | null = null;
  let mounted = false;
  let enabled = false;
  let requested = false;
  let automaticPolicy: boolean | null = false;
  let automaticAttempted = false;
  let automaticEpoch = 0;
  let watchId: number | null = null;
  let watching = false;
  let watchEpoch = 0;
  let permissionEpoch = 0;
  let removeVisibilityListener: (() => void) | undefined;
  let removePermissionListener: (() => void) | undefined;

  function publish(next: EarthLocationState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function clearWatch() {
    watchEpoch += 1;
    watching = false;
    const previousId = watchId;
    watchId = null;
    if (previousId !== null) environment?.geolocation?.clearWatch(previousId);
  }

  function clearPermission() {
    permissionEpoch += 1;
    removePermissionListener?.();
    removePermissionListener = undefined;
  }

  function fail(status: keyof typeof ERRORS) {
    requested = false;
    clearWatch();
    clearPermission();
    publish({ position: null, status, error: ERRORS[status] });
  }

  function observePermission() {
    if (!environment?.queryPermission) return;
    const epoch = ++permissionEpoch;
    void environment.queryPermission().then(permission => {
      if (!mounted || !requested || epoch !== permissionEpoch) return;
      let previousState = permission.state;
      const changed = () => {
        if (!mounted || !requested || epoch !== permissionEpoch) return;
        // A granted permission returning to prompt was revoked in browser settings.
        if (permission.state === "denied" || (previousState === "granted" && permission.state === "prompt")) {
          fail("denied");
          return;
        }
        previousState = permission.state;
      };
      removePermissionListener = permission.subscribe(changed);
      changed();
    }).catch(() => {
      // Some browsers expose Permissions but cannot query geolocation. The watch
      // still reports denial through its error callback in those browsers.
    });
  }

  function reconcile() {
    if (!mounted || !requested || !environment) return;
    if (!enabled || !environment.visible()) {
      clearWatch();
      if (state.status !== "paused") publish({ ...state, status: "paused", error: null });
      return;
    }
    if (watching) return;
    if (!environment.secure) { fail("insecure"); return; }
    const geolocation = environment.geolocation;
    if (!geolocation) { fail("unsupported"); return; }

    watching = true;
    const epoch = ++watchEpoch;
    const canAccept = () => {
      if (!mounted || !requested || epoch !== watchEpoch) return false;
      if (!enabled || !environment?.visible()) { reconcile(); return false; }
      return true;
    };
    publish({ ...state, status: "requesting", error: null });
    try {
      const id = geolocation.watchPosition(value => {
        if (!canAccept()) return;
        const position = readEarthPosition(value);
        if (!position) { fail("unavailable"); return; }
        if (state.position && position.timestamp < state.position.timestamp) return;
        publish({ position, status: "active", error: null });
      }, error => {
        if (!canAccept()) return;
        fail(error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable");
      }, { enableHighAccuracy: false, maximumAge: 15_000, timeout: 20_000 });
      // Also handles implementations that invoke their callback synchronously.
      if (epoch !== watchEpoch || !mounted || !requested) geolocation.clearWatch(id);
      else watchId = id;
    } catch {
      if (epoch === watchEpoch) fail("unavailable");
    }
  }

  function halt(keepPosition: boolean) {
    automaticAttempted = true;
    automaticEpoch += 1;
    requested = false;
    clearWatch();
    clearPermission();
    publish(keepPosition && state.position ? { ...state, status: "paused", error: null } : IDLE);
  }
  function stop() { halt(false); }
  // Freeze only this account's in-memory marker. No watch or automatic restart
  // survives; an explicit private lookup is still available in ghost mode.
  function freeze() { halt(true); }

  // Permissions.query is passive: an unknown/prompt permission never opens a
  // browser prompt. A delayed answer cannot revive a stopped/hidden session.
  function maybeStartAutomatically() {
    if (automaticPolicy !== true || automaticAttempted || !mounted || !enabled || requested
      || !ownerPublicId || !environment?.visible()) return;
    automaticAttempted = true;
    if (!environment.secure || !environment.geolocation || !environment.queryPermission) return;
    const epoch = ++automaticEpoch;
    const currentEnvironment = environment;
    void environment.queryPermission().then(permission => {
      if (!mounted || !enabled || requested || epoch !== automaticEpoch || automaticPolicy !== true
        || environment !== currentEnvironment || !environment.visible() || permission.state !== "granted") return;
      start();
    }).catch(() => {
      // Without a reliable permission result, the explicit private GPS button
      // remains available; never try geolocation just to discover permission.
    });
  }
  function start() {
    if (!mounted || !ownerPublicId || requested) return;
    automaticAttempted = true;
    automaticEpoch += 1;
    requested = true;
    reconcile();
    if (requested) observePermission();
  }
  function visibilityChanged() {
    if (!environment?.visible()) automaticEpoch += 1;
    reconcile();
    maybeStartAutomatically();
  }

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => IDLE,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() {
      mounted = true;
      automaticAttempted = false;
      automaticEpoch += 1;
      environment = getEnvironment();
      removeVisibilityListener = environment.onVisibilityChange(visibilityChanged);
      maybeStartAutomatically();
      return () => {
        mounted = false;
        stop();
        removeVisibilityListener?.();
        removeVisibilityListener = undefined;
        environment = null;
      };
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!enabled) automaticEpoch += 1;
      reconcile();
      maybeStartAutomatically();
    },
    /** null waits for privacy metadata; false permanently suppresses this mount's auto attempt. */
    setAutomaticStartPolicy(value: boolean | null) {
      automaticPolicy = value;
      if (value === false) { automaticAttempted = true; automaticEpoch += 1; }
      maybeStartAutomatically();
    },
    start,
    stop,
    freeze,
  };
}
