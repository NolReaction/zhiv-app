"use client";

import { useEffect, useRef, useState } from "react";
import { bindSceneLoaderEnvironment, createSceneLoader } from "./scene-loader";
import type { SceneLoadState } from "./scene-load-state";

export function useStartupModules(enabled: boolean, retrySignal: number): SceneLoadState {
  const [state, setState] = useState<SceneLoadState>("loading");
  const loader = useRef<ReturnType<typeof createSceneLoader<void>> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const current = createSceneLoader<void>({
      load: async () => { await Promise.all([import("@/features/world/world-portal"), import("@/features/world/scene/map-engine")]); },
      release() {}, onReady() {}, onState: setState,
    });
    loader.current = current;
    const unbind = bindSceneLoaderEnvironment(current);
    current.retry();
    return () => { unbind(); current.dispose(); if (loader.current === current) loader.current = null; };
  }, [enabled]);
  useEffect(() => { if (retrySignal > 0) loader.current?.retry(); }, [retrySignal]);
  return state;
}
