import type { ComponentType } from "react";
import type { WorldDevPanelProps } from "./world-dev-panel";
import { takeWorldLightingStudioHandoff } from "./world-lighting-studio-session";

export type WorldDevPanelModule = { default: ComponentType<WorldDevPanelProps> };
export type WorldDevPanelLoad = () => Promise<WorldDevPanelModule>;
type LoaderState = Readonly<{ Panel: ComponentType<WorldDevPanelProps> | null; pending: boolean; failed: boolean; noticeOpen: boolean; initialLightingStudio: boolean }>;

/** Per-entry loader state survives Fast Refresh without sharing ownership across views. */
export function createWorldDevPanelLoader() {
  const initial: LoaderState = Object.freeze({ Panel: null, pending: false, failed: false, noticeOpen: false, initialLightingStudio: false });
  let state = initial, mounted = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<LoaderState>) => {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof LoaderState] === value)) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const fail = (error: unknown) => {
    if (!mounted) return;
    publish({ Panel: null, pending: false, failed: true, noticeOpen: true });
    console.warn("DEV panel is unavailable; the game remains open.", error);
  };
  const open = async (load: WorldDevPanelLoad | null, initialLightingStudio: boolean) => {
    if (!load || state.pending) return;
    if (state.failed) { publish({ noticeOpen: !state.noticeOpen }); return; }
    publish({ pending: true, initialLightingStudio });
    try { const panel = await load(); if (mounted) publish({ Panel: panel.default, pending: false }); }
    catch (error) { fail(error); }
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    mount: () => { mounted = true; },
    unmount: () => { mounted = false; },
    fail,
    closeNotice: () => publish({ noticeOpen: false }),
    requestStudio: () => publish({ initialLightingStudio: true }),
    open,
    claimHandoff: (load: WorldDevPanelLoad | null, worldView: boolean, active = true) => {
      if (!worldView || !active || state.pending || !takeWorldLightingStudioHandoff()) return;
      if (state.Panel) publish({ initialLightingStudio: true });
      else return open(load, true);
    },
  };
}
