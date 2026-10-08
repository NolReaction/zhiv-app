"use client";

import { useEffect, useState } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { createEconomyAudioFeedbackTracker, type EconomyAudioFeedbackView } from "./audio-feedback";

/** Mount once at the app composition root. Keep tracking while disabled so
 * account switches, background synchronization and sound toggles cannot replay
 * old rewards. The audio runtime drops muted/hidden/locked events immediately. */
export function useEconomyAudioFeedback(view: EconomyAudioFeedbackView, enabled = true) {
  const [tracker] = useState(createEconomyAudioFeedbackTracker);
  const { snapshot, busy, uncertain, error, notice, inventoryGains, completedConstructions } = view;
  useEffect(() => {
    const events = tracker.update({ snapshot, busy, uncertain, error, notice, inventoryGains, completedConstructions }, enabled);
    if (!events.length) return;
    const audio = getAudioRuntime();
    for (const event of events) audio.play(event);
  }, [tracker, enabled, snapshot, busy, uncertain, error, notice, inventoryGains, completedConstructions]);
}
