"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { claimBoatFishingCourse, createBoatFishingCoach, type BoatCoachObservation } from "./boat-fishing-coach";

const storage = () => { try { return window.localStorage; } catch { return null; } };

/** Hint completion is scoped to this account on this device; it never changes a voyage. */
export function useBoatFishingCoach(owner: string) {
  const session = useMemo(() => createBoatFishingCoach(owner), [owner]);
  const [snapshot, setSnapshot] = useState(() => session.snapshot());
  useEffect(() => {
    // Server and first hydration render show the same lesson. Browser storage is optional.
    const frame = requestAnimationFrame(() => { session.restore(storage()); setSnapshot(session.snapshot()); });
    return () => cancelAnimationFrame(frame);
  }, [session]);
  const observe = useCallback((sample: BoatCoachObservation) => {
    if (session.observe(sample, storage())) setSnapshot(session.snapshot());
  }, [session]);
  const replay = useCallback(() => { session.reset(storage()); setSnapshot(session.snapshot()); }, [session]);
  const offerCourse = useCallback(() => claimBoatFishingCourse(owner, storage()), [owner]);
  return { offerCourse, view: snapshot.owner === owner ? snapshot : session.snapshot(), observe, replay };
}
