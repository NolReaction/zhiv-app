"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { getStartupAudioEntry, INITIAL_STARTUP_AUDIO } from "./startup-audio";

export function useStartupAudio(logoReady: boolean, active: boolean) {
  const [state, setState] = useState(INITIAL_STARTUP_AUDIO);
  const entry = useRef<ReturnType<typeof getStartupAudioEntry> | null>(null);
  useEffect(() => {
    const runtime = getAudioRuntime();
    const current = getStartupAudioEntry(runtime, { visible: () => !document.hidden });
    entry.current = current;
    let attached = true;
    const update = () => { if (attached) setState(current.getPresentation()); };
    const unsubscribe = current.subscribePresentation(update);
    const unsubscribeRuntime = runtime.subscribe(current.refresh);
    const visibility = () => { if (document.hidden) current.hide(); };
    document.addEventListener("visibilitychange", visibility);
    current.start();
    queueMicrotask(update);
    return () => {
      attached = false;
      unsubscribe();
      unsubscribeRuntime();
      document.removeEventListener("visibilitychange", visibility);
      // Do not abort shared preparation on StrictMode's temporary detach.
      if (entry.current === current) entry.current = null;
    };
  }, []);
  useEffect(() => { if (logoReady && state.revealReady) entry.current?.reveal(); }, [logoReady, state.revealReady]);
  useEffect(() => { if (!active) entry.current?.close(); }, [active]);
  const requestSound = useCallback(() => entry.current?.requestSound(), []);
  return { ...state, requestSound };
}
