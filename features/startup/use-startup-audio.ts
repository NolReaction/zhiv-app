"use client";

import { useEffect, useRef, useState } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { getStartupAudioEntry } from "./startup-audio";

export function useStartupAudio(logoReady: boolean, active: boolean) {
  const [settled, setSettled] = useState(false);
  const entry = useRef<ReturnType<typeof getStartupAudioEntry> | null>(null);
  useEffect(() => {
    const current = getStartupAudioEntry(getAudioRuntime(), { visible: () => !document.hidden });
    entry.current = current;
    const unsubscribe = current.subscribe(() => setSettled(true));
    const visibility = () => { if (document.hidden) current.hide(); };
    document.addEventListener("visibilitychange", visibility);
    current.start();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
      // Do not abort shared preparation on StrictMode's temporary detach.
      if (entry.current === current) entry.current = null;
    };
  }, []);
  useEffect(() => { if (logoReady) entry.current?.reveal(); }, [logoReady]);
  useEffect(() => { if (!active) entry.current?.close(); }, [active]);
  return settled;
}
