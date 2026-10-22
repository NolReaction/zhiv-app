"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthSharingController } from "./sharing";
import type { EarthShareOptions } from "./sharing";
import type { EarthPosition } from "./location";
import { getEarthLocationPreferenceStore } from "./location-preferences";
import * as transport from "./sharing-api";

/** Keep this hook in AppShell so explicit privacy commands survive map unmounts. */
export function useEarthSharing({ ownerPublicId, visible, publicationVisible = visible, isOnline, onSessionLost }: {
  ownerPublicId: string | null; visible: boolean; publicationVisible?: boolean; isOnline: boolean; onSessionLost?: () => void;
}) {
  const controller = useMemo(() => createEarthSharingController({ ownerPublicId, transport }), [ownerPublicId]);
  const preference = useMemo(() => getEarthLocationPreferenceStore(ownerPublicId), [ownerPublicId]);
  const locationChoice = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getServerSnapshot);
  useLayoutEffect(() => { controller.configure({ onSessionLost }); }, [controller, onSessionLost]);
  useLayoutEffect(() => {
    const deactivate = controller.activate();
    let previousEnabled: boolean | undefined;
    const changed = () => {
      const choice = preference.getSnapshot(), enabled = choice.enabled;
      controller.setAutomaticResumeAllowed(choice.automaticStartAllowed);
      if (!enabled) {
        // Retire queued uploads and pending enable replies before React renders
        // the disabled UI. OFF uses the controller's durable retry mechanism.
        controller.stopPublishing();
        if (ownerPublicId && previousEnabled !== false && controller.getSnapshot().pendingPrivacyMode !== "OFF") controller.off();
      }
      previousEnabled = enabled;
    };
    changed();
    const unsubscribe = preference.subscribe(changed);
    return () => { unsubscribe(); deactivate(); };
  }, [controller, preference, ownerPublicId]);
  useLayoutEffect(() => {
    const choice = preference.getSnapshot();
    controller.setContext({ visible, publicationVisible: publicationVisible && choice.enabled, isOnline, automaticResumeAllowed: choice.automaticStartAllowed });
  }, [controller, preference, visible, publicationVisible, isOnline, locationChoice.enabled, locationChoice.automaticStartAllowed]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const share = useCallback((options: EarthShareOptions) => preference.allowAutomaticStart() ? controller.share(options) : Promise.resolve(false), [controller, preference]);
  const resume = useCallback((resumeGhost = false) => preference.allowAutomaticStart() ? controller.resume(resumeGhost) : Promise.resolve(false), [controller, preference]);
  const setFrozen = useCallback((circleId: string, frozen: boolean) => frozen || preference.allowAutomaticStart()
    ? controller.setFrozen(circleId, frozen) : Promise.resolve(false), [controller, preference]);
  const ghost = useCallback(() => { if (preference.getSnapshot().enabled) controller.ghost(); }, [controller, preference]);
  const setPosition = useCallback((position: EarthPosition | null) => controller.setPosition(preference.getSnapshot().enabled ? position : null), [controller, preference]);
  return { ...state, share, resume, ghost, off: controller.off,
    setFrozen, revokeRecipient: controller.revokeRecipient,
    stopPublishing: controller.stopPublishing, refresh: controller.refresh, setPosition };
}
