"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthSharingController } from "./sharing";
import * as transport from "./sharing-api";

/** Keep this hook in AppShell so explicit privacy commands survive map unmounts. */
export function useEarthSharing({ ownerPublicId, visible, isOnline, onSessionLost }: {
  ownerPublicId: string | null; visible: boolean; isOnline: boolean; onSessionLost?: () => void;
}) {
  const controller = useMemo(() => createEarthSharingController({ ownerPublicId, transport }), [ownerPublicId]);
  useLayoutEffect(() => { controller.configure({ onSessionLost }); }, [controller, onSessionLost]);
  useLayoutEffect(() => controller.activate(), [controller]);
  useLayoutEffect(() => { controller.setContext({ visible, isOnline }); }, [controller, visible, isOnline]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return { ...state, share: controller.share, ghost: controller.ghost, off: controller.off,
    setFrozen: controller.setFrozen, revokeRecipient: controller.revokeRecipient,
    stopPublishing: controller.stopPublishing, refresh: controller.refresh, setPosition: controller.setPosition };
}
