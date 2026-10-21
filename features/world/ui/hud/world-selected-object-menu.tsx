"use client";
import { useSyncExternalStore } from "react";
import { WorldObjectMenu, type WorldObjectMenuProps } from "@/features/economy/ui/stations/world-object-menu";
import type { createMapSelectionStore } from "@/features/world/scene/map-selection-store";

export function WorldSelectedObjectMenu({ position, ...props }: WorldObjectMenuProps & {
  position: ReturnType<typeof createMapSelectionStore>;
}) {
  const current = useSyncExternalStore(position.subscribe, position.getSnapshot, position.getSnapshot);
  return <WorldObjectMenu {...props} selection={current?.objectId === props.selection.objectId ? current : props.selection} />;
}
