import { ApiError } from "@/lib/check-in-api";
import type { MeResponse } from "@/lib/check-in-contract";

const RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function isTransientIdentityFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === "TimeoutError");
}

type IdentityRecoveryOptions = {
  load: (signal: AbortSignal) => Promise<MeResponse | null>;
  isOnline: () => boolean;
  isVisible: () => boolean;
  onLoading: () => void;
  onIdentity: (identity: MeResponse | null) => void;
  onFailure: (error: unknown, attempted: boolean) => void;
};

/** Only reads the current session. Account creation is never part of recovery. */
export function createIdentityRecovery(options: IdentityRecoveryOptions) {
  let disposed = false;
  let resolved = false;
  let transient = true;
  let retries = 0;
  let generation = 0;
  let cooldownUntil = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay: number) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      attempt();
    }, Math.min(delay, 2_147_483_647));
  }

  function attempt() {
    if (disposed || resolved || controller || !options.isVisible()) return;
    if (!options.isOnline()) {
      transient = true;
      options.onFailure(new TypeError("Нет подключения к сети"), false);
      return;
    }
    const cooldown = cooldownUntil - Date.now();
    if (cooldown > 0) {
      schedule(cooldown);
      return;
    }
    const request = new AbortController();
    const requestGeneration = ++generation;
    controller = request;
    options.onLoading();
    void Promise.resolve().then(() => options.load(request.signal)).then(identity => {
      if (disposed || requestGeneration !== generation) return;
      controller = null;
      resolved = true;
      options.onIdentity(identity);
    }).catch(error => {
      if (disposed || requestGeneration !== generation) return;
      controller = null;
      transient = isTransientIdentityFailure(error);
      if (error instanceof ApiError && error.retryAfterMs) {
        cooldownUntil = Date.now() + error.retryAfterMs;
      }
      options.onFailure(error, true);
      if (!disposed && transient && retries < RETRY_DELAYS_MS.length) {
        schedule(Math.max(RETRY_DELAYS_MS[retries++], cooldownUntil - Date.now()));
      }
    });
  }

  function retry() {
    if (disposed || resolved || controller) return;
    clearTimer();
    retries = 0;
    attempt();
  }

  function resume() {
    // A burst of pageshow/focus/online events must not start parallel reads.
    if (!transient || controller || timer !== null) return;
    retry();
  }

  function pause() {
    clearTimer();
    generation += 1;
    controller?.abort();
    controller = null;
  }

  return {
    retry,
    resume,
    pause,
    dispose() {
      disposed = true;
      pause();
    },
  };
}

export type IdentityRecovery = ReturnType<typeof createIdentityRecovery>;
