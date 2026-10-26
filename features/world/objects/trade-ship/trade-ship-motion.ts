/** Preview manoeuvre in world pixels. This does not grant a berth or validate water collision masks. */
export type TradeShipVoyagePhase = "arriving" | "docked" | "departing" | "departed";
export type TradeShipBerth = Readonly<{ x: number; y: number; width: number }>;
export type TradeShipMotion = Readonly<{
  phase: TradeShipVoyagePhase;
  elapsed: number;
  progress: number;
  x: number;
  y: number;
  width: number;
  heading: number;
  velocityX: number;
  velocityY: number;
  speed: number;
  reverse: boolean;
  visible: boolean;
  berth: TradeShipBerth;
}>;

export const TRADE_SHIP_VOYAGE = { arrivalDuration: 18, departureDuration: 22 } as const;
const DEFAULT_BERTH: TradeShipBerth = { x: 705, y: 1090, width: 310 };
type Point = { x: number; y: number };
type Curve = readonly [Point, Point, Point, Point];

function validBerth(berth: TradeShipBerth): TradeShipBerth {
  return {
    x: Number.isFinite(berth.x) ? berth.x : DEFAULT_BERTH.x,
    y: Number.isFinite(berth.y) ? berth.y : DEFAULT_BERTH.y,
    width: Number.isFinite(berth.width) && berth.width > 0 ? berth.width : DEFAULT_BERTH.width,
  };
}

function route(berth: TradeShipBerth, reverse: boolean): Curve {
  const { x, y, width: w } = berth;
  // A short stern-first move clears the berth before a continuous down-left exit.
  // The rightmost excursion is about .19 widths, rather than another full ship.
  // The entire art box starts/ends beyond the bottom map edge, not just its centre.
  if (reverse) return [
    { x, y }, { x: x + w * .32, y: y + w * .15 },
    { x: x + w * .32, y: y + w * .45 },
    { x: x - w * .65, y: Math.max(1350, y + w * .95) },
  ];
  return [
    { x: x + w * 1.1, y: Math.max(1330, y + w * .72) },
    { x: x + w * .8, y: y + w * .43 },
    // Approach from deeper water before the final shore-side docking position.
    { x: x + w * .28, y: y + w * .15 }, { x, y },
  ];
}

function curveAt(curve: Curve, u: number) {
  const [a, b, c, d] = curve, v = 1 - u;
  return {
    x: v ** 3 * a.x + 3 * v * v * u * b.x + 3 * v * u * u * c.x + u ** 3 * d.x,
    y: v ** 3 * a.y + 3 * v * v * u * b.y + 3 * v * u * u * c.y + u ** 3 * d.y,
    dx: 3 * v * v * (b.x - a.x) + 6 * v * u * (c.x - b.x) + 3 * u * u * (d.x - c.x),
    dy: 3 * v * v * (b.y - a.y) + 6 * v * u * (c.y - b.y) + 3 * u * u * (d.y - c.y),
  };
}

/**
 * Analytic kinematic trajectory: a quintic throttle/braking envelope along a curved channel.
 * Position, velocity and acceleration are continuous, including zero velocity/acceleration
 * at departure and docking. Sampling absolute elapsed time avoids Euler drift between FPS.
 * The fixed three-quarter drawing retains its pose; its base angle belongs to the sprite.
 */
export function sampleTradeShipMotion(
  phase: TradeShipVoyagePhase, elapsed: number, inputBerth: TradeShipBerth = DEFAULT_BERTH,
): TradeShipMotion {
  const berth = validBerth(inputBerth);
  const reverse = phase === "departing" || phase === "departed";
  const duration = reverse ? TRADE_SHIP_VOYAGE.departureDuration : TRADE_SHIP_VOYAGE.arrivalDuration;
  const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(duration, elapsed)) : 0;
  const finished = time >= duration - 1e-9;
  const current = phase === "arriving" && finished ? "docked" : phase === "departing" && finished ? "departed" : phase;
  const stationary = current === "docked" || current === "departed";
  const t = stationary ? 1 : time / duration;
  const u = t * t * t * (10 + t * (-15 + 6 * t));
  const rate = stationary ? 0 : 30 * t * t * (1 - t) ** 2 / duration;
  const point = current === "docked" ? { ...berth, dx: 0, dy: 0 } : curveAt(route(berth, reverse), u);
  const velocityX = point.dx * rate, velocityY = point.dy * rate;
  // A single PNG cannot turn in 3D. Moving along the channel must not rotate its
  // waterline onto the bank or snap the picture when arrival becomes docked.
  const heading = 0;
  return {
    phase: current, elapsed: stationary ? 0 : time, progress: t,
    x: point.x, y: point.y, width: berth.width, heading,
    velocityX, velocityY, speed: Math.hypot(velocityX, velocityY),
    reverse: reverse && point.dx > 0, visible: current !== "departed", berth,
  };
}

export function createTradeShipMotion(phase: "arriving" | "docked" = "docked", berth?: TradeShipBerth) {
  return sampleTradeShipMotion(phase, 0, berth);
}

/** The caller owns pause/hidden/reduced-motion policy; an invalid or nonpositive dt does nothing. */
export function advanceTradeShipMotion(state: TradeShipMotion, deltaSeconds: number): TradeShipMotion {
  if (state.phase === "docked" || state.phase === "departed" || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return state;
  const duration = state.phase === "arriving" ? TRADE_SHIP_VOYAGE.arrivalDuration : TRADE_SHIP_VOYAGE.departureDuration;
  return sampleTradeShipMotion(state.phase, state.elapsed + Math.min(duration, deltaSeconds), state.berth);
}

/** Leaving early or pressing the button twice never teleports/restarts the ship. */
export function departTradeShip(state: TradeShipMotion): TradeShipMotion {
  return state.phase === "docked" ? sampleTradeShipMotion("departing", 0, state.berth) : state;
}
