"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthMapRetention, type EarthMapRetentionContext } from "./earth-map-retention";

export function useEarthMapRetention(context: EarthMapRetentionContext) {
  const controller = useMemo(() => createEarthMapRetention(), []);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const { owner, selected, available, documentHidden } = context;
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
  return { mounted, onReadyChange };
}
