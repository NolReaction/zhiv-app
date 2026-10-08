"use client";

import { useEffect, type ReactNode } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { attachAudioLifecycle } from "./audio-lifecycle";

/** Mount once, above both the clearing and the portaled world. No context per scene. */
export function AudioProvider({ children }: { children: ReactNode }) {
  useEffect(() => attachAudioLifecycle(getAudioRuntime(), document, window), []);
  return children;
}
