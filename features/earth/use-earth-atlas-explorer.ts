"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { earthAtlasEntry, type EarthAtlasEntry } from "./earth-atlas";
import { earthAtlasJourneyStop, transitionEarthAtlasJourney, type EarthAtlasJourneyAction, type EarthAtlasJourneyState } from "./earth-atlas-journeys";
import type { EarthAtlasPreview } from "./earth-atlas-preview";

type AtlasFocus = { center: [number, number]; zoom: number; requestId: number; entryId: string };
type ExplorerSnapshot = Readonly<{
  entry: EarthAtlasEntry | null;
  journeyState: EarthAtlasJourneyState;
  request: AtlasFocus | null;
  preview: EarthAtlasPreview | null;
}>;
const EMPTY: ExplorerSnapshot = Object.freeze({ entry: null, journeyState: null, request: null, preview: null });

/** One owner-scoped, transient explorer. Opening/closing the catalogue never recreates it. */
export function createEarthAtlasExplorer(owner: string | null) {
  let snapshot = EMPTY, active = false, activation = 0, requestId = 0;
  const listeners = new Set<() => void>();
  // Map callbacks invalidate this synchronously, before React can commit a disabled button.
  const previewRef: { current: EarthAtlasPreview | null } = { current: null };
  const publish = (next: ExplorerSnapshot) => {
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const select = (entry: EarthAtlasEntry, journeyState: EarthAtlasJourneyState) => {
    const canonical = earthAtlasEntry(entry.id);
    if (!active || !owner || !canonical?.center || canonical.zoom === null || canonical.kind === "meeting") return false;
    previewRef.current = null;
    publish({ entry: canonical, journeyState, preview: null,
      request: { center: [...canonical.center], zoom: canonical.zoom, requestId: ++requestId, entryId: canonical.id } });
    return true;
  };
  const close = (endJourney = false) => {
    previewRef.current = null;
    if (snapshot.entry || snapshot.preview || endJourney && snapshot.journeyState)
      publish({ ...EMPTY, journeyState: endJourney ? null : snapshot.journeyState });
  };
  const navigate = (action: EarthAtlasJourneyAction) => {
    if (!active || !owner) return false;
    if (action.type === "stop") { close(true); return true; }
    const next = transitionEarthAtlasJourney(snapshot.journeyState, action);
    if (action.type === "select" && next === snapshot.journeyState && action.stopIndex !== snapshot.journeyState?.stopIndex) return false;
    const current = earthAtlasJourneyStop(next);
    if (!current || next === snapshot.journeyState && action.type !== "select") return false;
    return select(current.entry, next);
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    previewRef,
    activate() {
      const lease = ++activation;
      active = Boolean(owner);
      return () => { if (lease === activation) { active = false; previewRef.current = null; snapshot = EMPTY; } };
    },
    selectEntry: (entry: EarthAtlasEntry) => select(entry, null),
    focusEntry(entry: EarthAtlasEntry) {
      const current = earthAtlasJourneyStop(snapshot.journeyState);
      return select(entry, current?.entry.id === entry.id ? snapshot.journeyState : null);
    },
    startJourney: (journeyId: string) => navigate({ type: "start", journeyId }),
    navigate,
    close,
    setPreview(value: EarthAtlasPreview | null) {
      if (!active || !snapshot.request) return;
      if (value && (value.entryId !== snapshot.entry?.id || value.requestId !== snapshot.request.requestId)) return;
      previewRef.current = value;
      if (snapshot.preview?.entryId === value?.entryId && snapshot.preview?.requestId === value?.requestId
        && snapshot.preview?.status === value?.status) return;
      publish({ ...snapshot, preview: value });
    },
    canDiscover(entry: EarthAtlasEntry, context: { foreground: boolean; hidden: boolean; loaded: boolean }) {
      const canonical = earthAtlasEntry(entry.id), preview = previewRef.current, request = snapshot.request;
      return Boolean(active && owner && context.foreground && !context.hidden && context.loaded
        && canonical?.kind !== "meeting" && canonical && canonical === snapshot.entry && request
        && preview?.entryId === canonical.id && preview.requestId === request.requestId && preview.status === "ready");
    },
  };
}

export function useEarthAtlasExplorer(owner: string | null) {
  const controller = useMemo(() => createEarthAtlasExplorer(owner), [owner]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useLayoutEffect(() => controller.activate(), [controller]);
  return { ...controller, snapshot, journey: earthAtlasJourneyStop(snapshot.journeyState) };
}
