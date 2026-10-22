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
  denied: "Разреши геопозицию для этого сайта в браузере и доступ к местоположению в настройках устройства. Затем нажми «Найти меня».",
  unavailable: "Браузер не смог получить геопозицию. Проверь доступ к местоположению в настройках устройства и браузера, затем нажми «Найти меня».",
  timeout: "Не удалось дождаться геопозиции после повторного поиска. Проверь доступ к местоположению в настройках устройства и нажми «Найти меня».",
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
 * A visible map may request its initial private lookup, including the browser's
 * native permission prompt. The browser owns permission; friend sharing is separate.
 */
export function createEarthLocationController(
  ownerPublicId: string,
  getEnvironment: () => EarthLocationEnvironment = browserEarthLocationEnvironment,
  onPermissionDenied: () => void = () => {},
) {
  let state = IDLE;
  const listeners = new Set<() => void>();
  let environment: EarthLocationEnvironment | null = null;
  let mounted = false;
  let enabled = false;
  let allowed = true;
  let requested = false;
  let automaticPolicy: boolean | null = false;
  let automaticAttempted = false;
  let automaticSuppressed = false;
  let automaticLookup = false;
  let watchId: number | null = null;
  let watching = false;
  let watchEpoch = 0;
  let fallbackAttempted = false;
  let freshLookup = false;
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
    automaticLookup = false;
    clearWatch();
    clearPermission();
    // Persist the refusal before a possible unmount. Retire the request first:
    // preference subscribers must not replace the real denial with a pause.
    if (status === "denied") onPermissionDenied();
    // A transient provider failure does not erase the last private fix. Keep its
    // original timestamp: it must never look like a freshly acquired position.
    publish({ position: status === "unavailable" || status === "timeout" ? state.position : null, status, error: ERRORS[status] });
  }

  function observePermission() {
    if (!environment?.queryPermission) return;
    const epoch = ++permissionEpoch;
    void environment.queryPermission().then(permission => {
      if (!mounted || !requested || epoch !== permissionEpoch) return;
      let previousState = permission.state;
      const changed = () => {
        if (!mounted || !requested || epoch !== permissionEpoch) return;
        if (permission.state === previousState) return;
        // A granted permission returning to prompt was revoked in browser settings.
        if (permission.state === "denied" || (previousState === "granted" && permission.state === "prompt")) {
          fail("denied");
          return;
        }
        previousState = permission.state;
      };
      removePermissionListener = permission.subscribe(changed);
      // A cold browser can initially report a stale permission snapshot. The
      // real watch owns the result of this request; only later permission
      // changes can revoke it. In particular, do not cancel the first lookup
      // with a stale "denied" before Geolocation has answered.
    }).catch(() => {
      // Some browsers expose Permissions but cannot query geolocation. The watch
      // still reports denial through its error callback in those browsers.
    });
  }

  function reconcile() {
    if (!mounted || !allowed || !requested || !environment) return;
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
      if (!mounted || !allowed || !requested || epoch !== watchEpoch) return false;
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
        // Desktop network positioning and mobile low-power fixes can fail while
        // another device source remains usable. Make one bounded foreground
        // attempt; denial never retries or changes sharing consent.
        if ((error.code === 2 || error.code === 3) && !fallbackAttempted) {
          fallbackAttempted = true;
          clearWatch();
          reconcile();
          return;
        }
        fail(error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable");
      }, { enableHighAccuracy: !fallbackAttempted, maximumAge: freshLookup ? 0 : 15_000, timeout: fallbackAttempted ? 20_000 : 30_000 });
      // Also handles implementations that invoke their callback synchronously.
      if (epoch !== watchEpoch || !mounted || !requested) geolocation.clearWatch(id);
      else watchId = id;
    } catch {
      if (epoch === watchEpoch) fail("unavailable");
    }
  }

  function halt(keepPosition: boolean) {
    automaticAttempted = true;
    requested = false;
    automaticLookup = false;
    clearWatch();
    clearPermission();
    publish(keepPosition && state.position ? { ...state, status: "paused", error: null } : IDLE);
  }
  function stop() { halt(false); }
  // Freeze only this account's in-memory marker. No watch or automatic restart
  // survives; an explicit private lookup is still available in ghost mode.
  function freeze() { halt(true); }

  // WebKit can report prompt until Geolocation has run in this page. Native
  // Geolocation owns grant/denial; Permissions only observes later revocation.
  function maybeStartAutomatically() {
    if (automaticPolicy !== true || automaticAttempted || !mounted || !allowed || !enabled || requested
      || !ownerPublicId || !environment?.visible()) return;
    automaticAttempted = true;
    startLookup(true);
  }
  function startLookup(automatically: boolean, fresh = false) {
    if (!mounted || !allowed || !ownerPublicId || requested) return;
    automaticAttempted = true;
    automaticLookup = automatically;
    fallbackAttempted = false;
    freshLookup = fresh;
    requested = true;
    reconcile();
    if (requested) observePermission();
  }
  function start() { startLookup(false); }
  // A deliberate lookup refreshes a stale watch without changing any sharing
  // permission. Keep the old private marker until a fresh fix arrives.
  function locate({ fresh = false }: { fresh?: boolean } = {}) {
    if (!mounted || !allowed || !ownerPublicId) return;
    automaticLookup = false;
    if (!requested) { startLookup(false, fresh); return; }
    // A newly acquired sharing lease needs a post-consent fix even when the
    // private entry lookup is still pending. Replace it once with no cache.
    if (state.status === "requesting" && !fresh) return;
    fallbackAttempted = false;
    freshLookup = fresh;
    clearWatch();
    reconcile();
  }
  function visibilityChanged() {
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
      automaticAttempted = automaticSuppressed;
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
      reconcile();
      maybeStartAutomatically();
    },
    /** Device-wide OFF is stronger than hiding/pausing: forget the private fix. */
    setAllowed(value: boolean) {
      if (allowed === value) return;
      allowed = value;
      if (!allowed) stop();
      // An ON transition only unlocks explicit actions. Never revive the watch
      // from before the user's OFF.
      else automaticAttempted = true;
    },
    /** null waits for privacy metadata; false permanently suppresses this mount's auto attempt. */
    setAutomaticStartPolicy(value: boolean | null) {
      automaticPolicy = value;
      if (value === false) {
        automaticSuppressed = true;
        automaticAttempted = true;
        if (requested && automaticLookup) freeze();
      }
      maybeStartAutomatically();
    },
    start,
    locate,
    stop,
    freeze,
  };
}
