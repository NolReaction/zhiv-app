import { createTradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";
import { clampCamera, type Camera, type VerticalCameraInsets, type Viewport } from "./camera";

/** DEV framing keeps the south berth above the HUD on a portrait screen. */
export function tradeShipCamera(view: Viewport, bounds: Viewport, insets: VerticalCameraInsets): Camera {
  const berth = createTradeShipMotion().berth;
  const inset = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(view.height * .45, value)) : 0;
  const top = inset(insets.top), bottom = inset(insets.bottom);
  const availableHeight = Math.max(64, view.height - top - bottom);
  // camera.ts reveals HUD pan room only after the scaled map exceeds the
  // viewport by these insets. Merely filling its height leaves the ship behind
  // the bottom HUD and clamps away a requested southward focus on mobile.
  const zoom = Math.max((view.height + top + bottom) / bounds.height,
    Math.min(2, view.width / (berth.width * 2.1), availableHeight / (berth.width * 1.1)));
  const visibleCenterY = top + availableHeight / 2;
  return clampCamera({ x: berth.x + berth.width * .3,
    y: berth.y + berth.width * .3 - (visibleCenterY - view.height / 2) / zoom, zoom }, view, bounds, { top, bottom });
}
