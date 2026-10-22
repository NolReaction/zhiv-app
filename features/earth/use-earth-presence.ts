"use client";

import { useEffect, useRef } from "react";
import { useEarthLocation } from "./use-earth-location";
import type { useEarthSharing } from "./use-earth-sharing";

/** One account-owned GPS watch. Consented sharing outlives map navigation, but
 * never document backgrounding; without a publisher GPS is private and map-only. */
export function useEarthPresence({ ownerPublicId, enabled, mapVisible, sharing, temporarilyPaused = false }: {
  ownerPublicId: string | null; enabled: boolean; mapVisible: boolean; temporarilyPaused?: boolean;
  sharing: ReturnType<typeof useEarthSharing>;
}) {
  const { setPosition, stopPublishing, pendingGhost, pendingPrivacyMode, publishing, publicationGeneration } = sharing;
  const locationEnabled = enabled && !temporarilyPaused && (mapVisible || publishing);
  const autoStart = pendingGhost || sharing.settings?.mode === "GHOST" ? false
    : sharing.settings && locationEnabled ? true : null;
  const location = useEarthLocation({ ownerPublicId, enabled: locationEnabled, autoStart });
  const { stop, freeze, locateForPublication } = location;
  const requestedFix = useRef({ owner: ownerPublicId, generation: 0 });
  const previous = useRef({ owner: ownerPublicId, publishing: false, privacy: null as string | null });
  useEffect(() => {
    const needsFreshFix = publishing && publicationGeneration > 0
      && (requestedFix.current.owner !== ownerPublicId || requestedFix.current.generation !== publicationGeneration);
    setPosition(locationEnabled && location.allowed && location.status === "active" ? location.position : null);
    // A new lease can render alongside the previous failed GPS snapshot. Its
    // upcoming fresh lookup owns recovery; that old error must not kill it first.
    if (!temporarilyPaused && !needsFreshFix && ["denied", "unavailable", "timeout", "unsupported", "insecure"].includes(location.status)) stopPublishing(location.error ?? undefined);
  }, [ownerPublicId, publishing, temporarilyPaused, locationEnabled, location.allowed, location.status, location.error, location.position, publicationGeneration, setPosition, stopPublishing]);

  useEffect(() => {
    if (!publishing || !publicationGeneration || requestedFix.current.owner === ownerPublicId && requestedFix.current.generation === publicationGeneration
      || pendingGhost || !locationEnabled || !location.allowed || document.hidden) return;
    requestedFix.current = { owner: ownerPublicId, generation: publicationGeneration };
    // Native position callbacks obtained before a lease cannot be published.
    // A stationary phone therefore needs a fresh lookup after the acknowledgement.
    locateForPublication();
  }, [publishing, publicationGeneration, pendingGhost, locationEnabled, location.allowed, locateForPublication, ownerPublicId]);

  useEffect(() => {
    const privacy = pendingGhost ? pendingPrivacyMode : null;
    const prior = previous.current.owner === ownerPublicId ? previous.current : null;
    if (privacy && privacy !== prior?.privacy) {
      if (privacy === "OFF") stop(); else freeze();
    } else if (!temporarilyPaused && prior?.publishing && !publishing && !location.error) freeze();
    previous.current = { owner: ownerPublicId, publishing, privacy };
  }, [ownerPublicId, pendingGhost, pendingPrivacyMode, publishing, temporarilyPaused, location.error, stop, freeze]);
  return location;
}
