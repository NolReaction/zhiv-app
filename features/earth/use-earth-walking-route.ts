"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { EARTH_POSITION_MAX_AGE_MS, type EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { canUseEarthWalkingRoute, createEarthWalkingRouteBinding, earthWalkingRouteErrorMessage, earthWalkingRouteLimiter,
  EARTH_WALKING_ROUTE_TIMEOUT_MS, EarthWalkingRouteError, fetchEarthWalkingRoute,
  type EarthWalkingRouteBinding, type EarthWalkingRouteData, type EarthWalkingRouteState } from "./walking-route";

export type EarthWalkingRouteContext = {
  foreground: boolean; online: boolean; allowed: boolean;
  position: EarthPosition | null; person: EarthMapPerson | null;
};
type RouteEnvironment = {
  wallNow: () => number; monotonicNow: () => number; visible: () => boolean; online: () => boolean;
  onAvailabilityChange: (listener: () => void) => () => void;
  schedule: (listener: () => void, milliseconds: number) => () => void;
  fetchRoute: (binding: EarthWalkingRouteBinding, signal: AbortSignal) => Promise<EarthWalkingRouteData>;
  limiter: Pick<typeof earthWalkingRouteLimiter, "remaining" | "take">;
};
const EMPTY: EarthWalkingRouteState = Object.freeze({ status: "idle", route: null, error: null, canRequest: false });
const DISABLED: EarthWalkingRouteContext = { foreground: false, online: false, allowed: false, position: null, person: null };

function browserEnvironment(): RouteEnvironment {
  return {
    wallNow: Date.now, monotonicNow: () => performance.now(), visible: () => !document.hidden, online: () => navigator.onLine !== false,
    onAvailabilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("offline", listener); window.addEventListener("online", listener);
      return () => { document.removeEventListener("visibilitychange", listener); window.removeEventListener("offline", listener); window.removeEventListener("online", listener); };
    },
    schedule(listener, milliseconds) { const timer = setTimeout(listener, milliseconds); return () => clearTimeout(timer); },
    fetchRoute: fetchEarthWalkingRoute, limiter: earthWalkingRouteLimiter,
  };
}

/** One selected friend, one owner, RAM only. Reconciliation never starts a request. */
export function createEarthWalkingRouteController(owner: string | null, getEnvironment: () => RouteEnvironment = browserEnvironment) {
  let snapshot = EMPTY, context = DISABLED, environment: RouteEnvironment | null = null, active = false, activation = 0;
  let generation = 0, controller: AbortController | null = null, binding: EarthWalkingRouteBinding | null = null;
  let selfFreshness: { timestamp: number; deadline: number } | null = null;
  let cancelTimer: (() => void) | undefined, removeAvailability: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: EarthWalkingRouteState) => {
    if (snapshot.status === next.status && snapshot.route === next.route && snapshot.error === next.error && snapshot.canRequest === next.canRequest) return;
    snapshot = next; listeners.forEach(listener => listener());
  };
  const retire = () => { generation++; controller?.abort(); controller = null; binding = null; };
  const eligible = () => Boolean(active && owner && environment && context.foreground && context.allowed && context.online && environment.visible() && environment.online());
  function selfDeadline() {
    if (!environment || !context.position || !Number.isFinite(context.position.timestamp)) return -Infinity;
    const timestamp = context.position.timestamp;
    const deadline = environment.monotonicNow() + Math.min(EARTH_POSITION_MAX_AGE_MS, timestamp + EARTH_POSITION_MAX_AGE_MS - environment.wallNow());
    if (!selfFreshness || timestamp > selfFreshness.timestamp) selfFreshness = { timestamp, deadline };
    else selfFreshness.deadline = Math.min(selfFreshness.deadline, deadline);
    return selfFreshness.deadline;
  }
  const currentBinding = () => {
    if (!eligible() || !environment) return null;
    const deadline = selfDeadline();
    if (environment.monotonicNow() >= deadline) return null;
    const value = createEarthWalkingRouteBinding(owner, context.position, context.person, environment.monotonicNow(), environment.wallNow());
    return value ? { ...value, expiresAtMonotonic: Math.min(value.expiresAtMonotonic, deadline) } : null;
  };
  const validBinding = (value: EarthWalkingRouteBinding | null) => eligible() && environment && environment.monotonicNow() < selfDeadline()
    && canUseEarthWalkingRoute(value, context.position, context.person, environment.monotonicNow(), environment.wallNow());
  function schedule() {
    cancelTimer?.(); cancelTimer = undefined;
    if (!active || !environment || !eligible()) return;
    const cooldown = environment.limiter.remaining(environment.monotonicNow(), environment.wallNow());
    // Local access/clock checks only. There is no polling, retry or prefetch of routes.
    if (binding || currentBinding() || cooldown > 0)
      cancelTimer = environment.schedule(reconcile, Math.max(1, Math.min(1_000, cooldown > 0 ? cooldown : 1_000)));
  }
  function reconcile() {
    if (!eligible()) { retire(); publish(EMPTY); schedule(); return; }
    if (binding && !validBinding(binding)) { retire(); publish(EMPTY); }
    if (binding && snapshot.status === "loading" && environment
      && environment.monotonicNow() - binding.createdAtMonotonic >= EARTH_WALKING_ROUTE_TIMEOUT_MS) {
      retire(); publish({ status: "error", route: null, error: earthWalkingRouteErrorMessage(new EarthWalkingRouteError("timeout")), canRequest: false });
    }
    const canRequest = Boolean(snapshot.status !== "loading" && currentBinding() && environment
      && environment.limiter.remaining(environment.monotonicNow(), environment.wallNow()) === 0);
    publish({ ...snapshot, canRequest }); schedule();
  }
  function clear() { retire(); publish(EMPTY); reconcile(); }
  function request() {
    reconcile();
    const current = currentBinding(), env = environment;
    if (!current || !env || snapshot.status === "loading" || !env.limiter.take(env.monotonicNow(), env.wallNow())) return false;
    retire();
    binding = current;
    const ticket = generation, signal = new AbortController(); controller = signal;
    publish({ status: "loading", route: null, error: null, canRequest: false }); schedule();
    const live = () => active && ticket === generation && binding === current && !signal.signal.aborted && validBinding(current);
    void Promise.resolve().then(() => live() ? env.fetchRoute(current, signal.signal) : null).then(data => {
      if (!live()) { if (ticket === generation) reconcile(); return; }
      if (!data) return;
      controller = null;
      publish({ status: "ready", route: { ...data, ...current }, error: null, canRequest: false }); reconcile();
    }).catch(error => {
      if (!live()) { if (ticket === generation) reconcile(); return; }
      controller = null; binding = null;
      publish({ status: "error", route: null, error: earthWalkingRouteErrorMessage(error), canRequest: false }); reconcile();
    });
    return true;
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      const lease = ++activation;
      active = Boolean(owner); environment ??= getEnvironment();
      removeAvailability?.(); removeAvailability = environment.onAvailabilityChange(reconcile); reconcile();
      return () => {
        if (lease !== activation) return;
        active = false; retire(); cancelTimer?.(); cancelTimer = undefined; removeAvailability?.(); removeAvailability = undefined;
        context = DISABLED; selfFreshness = null; snapshot = EMPTY;
      };
    },
    update(value: EarthWalkingRouteContext) {
      if (context.person?.circleId !== value.person?.circleId || context.person?.user.publicId !== value.person?.user.publicId) {
        retire(); publish(EMPTY);
      }
      // Copy the required current facts; later mutations cannot silently rewrite a binding.
      context = { ...value, position: value.position ? { ...value.position } : null,
        person: value.person ? { ...value.person, user: { ...value.person.user } } : null };
      reconcile();
    },
    request, clear,
  };
}

export function useEarthWalkingRoute({ owner, foreground, online, allowed, position, person }: EarthWalkingRouteContext & { owner: string | null }) {
  const controller = useMemo(() => createEarthWalkingRouteController(owner), [owner]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useLayoutEffect(() => controller.activate(), [controller]);
  useLayoutEffect(() => { controller.update({ foreground, online, allowed, position, person }); }, [controller, foreground, online, allowed, position, person]);
  return { snapshot, request: controller.request, clear: controller.clear };
}
