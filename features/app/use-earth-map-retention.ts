"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthMapRetention, type EarthMapRetentionContext } from "./earth-map-retention";
import { createEarthCameraSession } from "@/features/earth/camera-session";

export function useEarthMapRetention(context: EarthMapRetentionContext) {
  const controller = useMemo(() => createEarthMapRetention(), []);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const { owner, selected, available, documentHidden } = context;
  // The lightweight camera outlives Map resources, including the game overlay
  // and retention expiry, but is replaced immediately with the account owner.
  const camera = useMemo(() => createEarthCameraSession(owner), [owner]);
  useLayoutEffect(() => camera.activate(), [camera]);
  useLayoutEffect(() => () => controller.dispose(), [controller]);
  useLayoutEffect(() => {
    controller.setContext({ owner, selected, available, documentHidden });
  }, [controller, owner, selected, available, documentHidden]);
  const onReadyChange = useCallback((ready: boolean) => {
    if (owner) controller.reportReady(owner, ready);
  }, [controller, owner]);
  // A new visible selection mounts immediately; retained state is always scoped
  // to this owner, so an account change cannot paint the former owner's map.
  const mounted = Boolean(owner && available && ((selected && !documentHidden)
    || (snapshot.owner === owner && snapshot.mounted)));
  return { mounted, onReadyChange, cameraSession: camera.session };
}
