"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { getStartupAudioEntry, INITIAL_STARTUP_AUDIO } from "./startup-audio";
import { attachStartupAudioGestures } from "./startup-audio-gestures";

export function useStartupAudio(logoReady: boolean, active: boolean) {
  const [state, setState] = useState(INITIAL_STARTUP_AUDIO);
  const entry = useRef<ReturnType<typeof getStartupAudioEntry> | null>(null);
  useEffect(() => {
    const runtime = getAudioRuntime();
    const current = getStartupAudioEntry(runtime, { visible: () => !document.hidden });
    const detach = current.attach();
    entry.current = current;
    let attached = true;
    const update = () => { if (attached) setState(current.getPresentation()); };
    const unsubscribe = current.subscribePresentation(update);
    const unsubscribeRuntime = runtime.subscribe(current.refresh);
    const detachGestures = attachStartupAudioGestures(current, document);
    const visibility = () => { if (document.hidden) current.hide(); };
    document.addEventListener("visibilitychange", visibility);
    current.start();
    queueMicrotask(update);
    return () => {
      attached = false;
      unsubscribe();
      unsubscribeRuntime();
      detachGestures();
      document.removeEventListener("visibilitychange", visibility);
      detach();
      if (entry.current === current) entry.current = null;
    };
  }, []);
  useEffect(() => { if (logoReady && state.revealReady) entry.current?.reveal(); }, [logoReady, state.revealReady]);
  // Close in the leaving commit, before a pending resume/decode microtask can
  // start branding during the transition to the app.
  useLayoutEffect(() => { if (!active) entry.current?.close(); }, [active]);
  return state;
}
