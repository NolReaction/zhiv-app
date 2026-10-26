import { TRADE_SHIP_SPRITE } from "@/features/world/objects/trade-ship/trade-ship-sprite";
import { advanceTradeShipMotion, createTradeShipMotion, departTradeShip, TRADE_SHIP_GANGWAY, TRADE_SHIP_VOYAGE,
  type TradeShipBerth, type TradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";

export type TradeShipPreviewMode = "detail" | "map" | "voyage";
export type TradeShipPreviewLeg = "arriving" | "departing";
export const TRADE_SHIP_MAP_CROP = { x: 640, y: 1020, width: 420, height: 280, worldSize: 1254 } as const;
export const TRADE_SHIP_VOYAGE_CROP = { x: 620, y: 1000, width: 634, height: 320, worldSize: 1254 } as const;
export const TRADE_SHIP_PREVIEW_BERTH = createTradeShipMotion().berth;
export const tradeShipPreviewCrop = (mode: TradeShipPreviewMode) => mode === "voyage" ? TRADE_SHIP_VOYAGE_CROP : TRADE_SHIP_MAP_CROP;

/** Only the real map intersection is sampled; open sea beyond it is painted separately. */
export function tradeShipPreviewMapSource(mode: TradeShipPreviewMode) {
  const crop = tradeShipPreviewCrop(mode);
  const x = Math.max(0, crop.x), y = Math.max(0, crop.y);
  return { x, y, width: Math.max(0, Math.min(crop.worldSize, crop.x + crop.width) - x),
    height: Math.max(0, Math.min(crop.worldSize, crop.y + crop.height) - y) };
}

export function commandTradeShipPreview(state: TradeShipMotion, command: "arrive" | "depart" | "dock") {
  if (command === "dock") return createTradeShipMotion("docked", state.berth);
  if (command === "depart") return departTradeShip(state);
  if (state.phase !== "docked" && state.phase !== "departed") return state;
  return createTradeShipMotion("arriving", state.berth);
}

const legDuration = (leg: TradeShipPreviewLeg) => leg === "arriving"
  ? TRADE_SHIP_VOYAGE.arrivalDuration + TRADE_SHIP_GANGWAY.deployDuration
  : TRADE_SHIP_GANGWAY.retractDuration + TRADE_SHIP_VOYAGE.departureDuration;

/** The slider owns a whole leg, including its bridge animation, rather than a phase clock. */
export function sampleTradeShipPreviewLeg(leg: TradeShipPreviewLeg, progress: number, berth: TradeShipBerth) {
  const unit = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const initial = leg === "arriving" ? createTradeShipMotion("arriving", berth)
    : departTradeShip(createTradeShipMotion("docked", berth));
  return advanceTradeShipMotion(initial, legDuration(leg) * unit);
}

export function tradeShipPreviewLegProgress(state: TradeShipMotion, leg: TradeShipPreviewLeg) {
  let elapsed = 0;
  if (leg === "arriving") {
    if (state.phase === "arriving") elapsed = state.elapsed;
    else if (state.phase === "deploying") elapsed = TRADE_SHIP_VOYAGE.arrivalDuration + state.elapsed;
    else return 1;
  } else {
    if (state.phase === "retracting") elapsed = state.elapsed;
    else if (state.phase === "departing") elapsed = TRADE_SHIP_GANGWAY.retractDuration + state.elapsed;
    else return state.phase === "departed" ? 1 : 0;
  }
  return Math.max(0, Math.min(1, elapsed / legDuration(leg)));
}

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
  if (mode !== "detail") {
    const crop = tradeShipPreviewCrop(mode);
    const scale = Math.min(w / crop.width, h / crop.height);
    return { scale, x: (w - crop.width * scale) / 2, y: (h - crop.height * scale) / 2,
      ship: { ...TRADE_SHIP_PREVIEW_BERTH } };
  }
  const shipWidth = Math.min(w * .94, h * .94 * TRADE_SHIP_SPRITE.width / TRADE_SHIP_SPRITE.height);
  return { scale: 1, x: 0, y: 0,
    ship: { x: (w - shipWidth) / 2, y: (h - shipWidth * TRADE_SHIP_SPRITE.height / TRADE_SHIP_SPRITE.width) / 2, width: shipWidth } };
}
