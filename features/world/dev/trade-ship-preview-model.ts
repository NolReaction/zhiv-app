import { TRADE_SHIP_ART } from "@/features/world/objects/trade-ship/trade-ship-art";

export type TradeShipPreviewMode = "detail" | "map";
export const TRADE_SHIP_MAP_CROP = { x: 640, y: 1020, width: 420, height: 234, worldSize: 1254 } as const;
export const TRADE_SHIP_PREVIEW_BERTH = { x: 705, y: 1066, width: 310 } as const;

/** The preview owns its clock; leaving the tab never advances an animation. */
export function advanceTradeShipPreviewClock(time: number, delta: number, options: {
  playing: boolean; visible: boolean; reducedMotion: boolean;
}) {
  const current = Number.isFinite(time) ? Math.max(0, time) : 0;
  if (!options.playing || !options.visible || options.reducedMotion || !Number.isFinite(delta) || delta <= 0) return current;
  return current + Math.min(.05, delta);
}

export function tradeShipPreviewLayout(width: number, height: number, mode: TradeShipPreviewMode) {
  const w = Number.isFinite(width) ? Math.max(1, width) : 1;
  const h = Number.isFinite(height) ? Math.max(1, height) : 1;
  if (mode === "map") {
    const scale = Math.min(w / TRADE_SHIP_MAP_CROP.width, h / TRADE_SHIP_MAP_CROP.height);
    return { scale, x: (w - TRADE_SHIP_MAP_CROP.width * scale) / 2, y: (h - TRADE_SHIP_MAP_CROP.height * scale) / 2,
      ship: { ...TRADE_SHIP_PREVIEW_BERTH } };
  }
  const shipWidth = Math.min(w * .94, h * .94 * TRADE_SHIP_ART.width / TRADE_SHIP_ART.height);
  return { scale: 1, x: 0, y: 0,
    ship: { x: (w - shipWidth) / 2, y: (h - shipWidth * TRADE_SHIP_ART.height / TRADE_SHIP_ART.width) / 2, width: shipWidth } };
}
