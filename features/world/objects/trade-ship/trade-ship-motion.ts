/** Preview manoeuvre in world pixels. This does not grant a berth or validate water collision masks. */
export type TradeShipVoyagePhase = "arriving" | "deploying" | "docked" | "retracting" | "departing" | "departed";
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
  /** Fully stowed = 0, fully connected to shore = 1. Nonzero only at the stationary berth. */
  gangway: number;
  berth: TradeShipBerth;
}>;

export const TRADE_SHIP_VOYAGE = {
  arrivalDuration: 18, departureDuration: 22, backingDuration: 6, turnDuration: 6,
  arrivalHeading: .28, departureHeading: -.6,
} as const;
export const TRADE_SHIP_GANGWAY = { deployDuration: 2.4, retractDuration: 2 } as const;
const DEFAULT_BERTH: TradeShipBerth = { x: 705, y: 1102, width: 310 };
type Point = { x: number; y: number };
type Curve = readonly [Point, Point, Point, Point];

function validBerth(berth: TradeShipBerth): TradeShipBerth {
  return {
    x: Number.isFinite(berth.x) ? berth.x : DEFAULT_BERTH.x,
    y: Number.isFinite(berth.y) ? berth.y : DEFAULT_BERTH.y,
    width: Number.isFinite(berth.width) && berth.width > 0 ? berth.width : DEFAULT_BERTH.width,
  };
}

function route(berth: TradeShipBerth, departing: boolean): Curve {
  const { x, y, width: w } = berth;
  // This is the second leg: a small leftward drift from the cleared position,
  // downward into open water while the actual picture turns counterclockwise.
  if (departing) return [
    { x: x + w * .36, y }, { x: x + w * .34, y: y + w * .03 },
    { x: x + w * .18, y: y + w * .15 },
    { x: x + w * .04, y: Math.max(1380, y + w * 1.05) },
  ];
  return [
    { x: x + w * 1.1, y: Math.max(1330, y + w * .72) },
    { x: x + w * .8, y: y + w * .43 },
    // Approach from deeper water before the final shore-side docking position.
    { x: x + w * .28, y: y + w * .15 }, { x, y },
  ];
}

function throttle(t: number, duration: number) {
  return { u: t * t * t * (10 + t * (-15 + 6 * t)), rate: 30 * t * t * (1 - t) ** 2 / duration };
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

function phaseDuration(phase: TradeShipVoyagePhase) {
  if (phase === "arriving") return TRADE_SHIP_VOYAGE.arrivalDuration;
  if (phase === "deploying") return TRADE_SHIP_GANGWAY.deployDuration;
  if (phase === "retracting") return TRADE_SHIP_GANGWAY.retractDuration;
  if (phase === "departing") return TRADE_SHIP_VOYAGE.departureDuration;
  return 0;
}

function atBerth(phase: "deploying" | "docked" | "retracting", berth: TradeShipBerth,
  elapsed: number, progress: number, gangway: number): TradeShipMotion {
  return { ...berth, phase, elapsed, progress, heading: 0, velocityX: 0, velocityY: 0,
    speed: 0, reverse: false, visible: true, gangway, berth };
}

/**
 * Analytic image choreography: clockwise-tilted approach, level berth, straight
 * rightward clearance, then a counterclockwise turn with a small down-left drift.
 * Position, velocity and acceleration are continuous, including zero velocity/acceleration
 * at departure and docking. Sampling absolute elapsed time avoids Euler drift between FPS.
 * Both departure legs meet at rest with continuous position, angle and acceleration.
 */
export function sampleTradeShipMotion(
  phase: TradeShipVoyagePhase, elapsed: number, inputBerth: TradeShipBerth = DEFAULT_BERTH,
): TradeShipMotion {
  const berth = validBerth(inputBerth);
  if (phase === "docked") return atBerth("docked", berth, 0, 1, 1);
  if (phase === "deploying" || phase === "retracting") {
    const duration = phaseDuration(phase);
    const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(duration, elapsed)) : 0;
    if (time >= duration - 1e-9) return sampleTradeShipMotion(phase === "deploying" ? "docked" : "departing", 0, berth);
    const progress = time / duration, open = throttle(progress, duration).u;
    return atBerth(phase, berth, time, progress, phase === "deploying" ? open : 1 - open);
  }
  const reverse = phase === "departing" || phase === "departed";
  const duration = reverse ? TRADE_SHIP_VOYAGE.departureDuration : TRADE_SHIP_VOYAGE.arrivalDuration;
  const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(duration, elapsed)) : 0;
  const finished = time >= duration - 1e-9;
  if (phase === "arriving" && finished) return atBerth("deploying", berth, 0, 0, 0);
  const current = phase === "departing" && finished ? "departed" : phase;
  const stationary = current === "departed";
  const t = stationary ? 1 : time / duration;
  const backing = current === "departing" && time < TRADE_SHIP_VOYAGE.backingDuration;
  const legDuration = reverse ? backing ? TRADE_SHIP_VOYAGE.backingDuration
    : duration - TRADE_SHIP_VOYAGE.backingDuration : duration;
  const legTime = stationary ? 1 : reverse && !backing
    ? (time - TRADE_SHIP_VOYAGE.backingDuration) / legDuration : time / legDuration;
  const { u, rate: movingRate } = throttle(legTime, legDuration);
  const rate = stationary ? 0 : movingRate;
  const point = backing ? { x: berth.x + berth.width * .36 * u, y: berth.y, dx: berth.width * .36, dy: 0 }
      : curveAt(route(berth, reverse), u);
  const velocityX = point.dx * rate, velocityY = point.dy * rate;
  // Canvas-positive is clockwise even for the nose-left mirrored image.
  const turn = throttle(Math.min(1, Math.max(0, (time - TRADE_SHIP_VOYAGE.backingDuration)
    / TRADE_SHIP_VOYAGE.turnDuration)), TRADE_SHIP_VOYAGE.turnDuration).u;
  const heading = backing ? 0 : reverse
    ? TRADE_SHIP_VOYAGE.departureHeading * (stationary ? 1 : turn) : TRADE_SHIP_VOYAGE.arrivalHeading * (1 - u);
  return {
    phase: current, elapsed: stationary ? 0 : time, progress: t,
    x: point.x, y: point.y, width: berth.width, heading,
    velocityX, velocityY, speed: Math.hypot(velocityX, velocityY),
    reverse: backing, visible: current !== "departed", gangway: 0, berth,
  };
}

export function createTradeShipMotion(phase: "arriving" | "docked" = "docked", berth?: TradeShipBerth) {
  return sampleTradeShipMotion(phase, 0, berth);
}

/** The caller owns pause/hidden/reduced-motion policy; an invalid or nonpositive dt does nothing. */
export function advanceTradeShipMotion(state: TradeShipMotion, deltaSeconds: number): TradeShipMotion {
  if (state.phase === "docked" || state.phase === "departed" || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return state;
  // A complete leg crosses at most two animated phases. Cap pathological dt,
  // but carry its remainder so changing FPS cannot lose time at the gangway.
  const bound = TRADE_SHIP_VOYAGE.arrivalDuration + TRADE_SHIP_GANGWAY.deployDuration
    + TRADE_SHIP_GANGWAY.retractDuration + TRADE_SHIP_VOYAGE.departureDuration;
  let remaining = Math.min(bound, deltaSeconds), current = state;
  for (let transition = 0; transition < 4; transition++) {
    if (current.phase === "docked" || current.phase === "departed") return current;
    const consumed = Math.min(remaining, Math.max(0, phaseDuration(current.phase) - current.elapsed));
    const next = sampleTradeShipMotion(current.phase, current.elapsed + consumed, current.berth);
    remaining -= consumed;
    if (next.phase === current.phase || remaining <= 0) return next;
    current = next;
  }
  return current;
}

/** Leaving early or pressing the button twice never teleports/restarts the ship. */
export function departTradeShip(state: TradeShipMotion): TradeShipMotion {
  return state.phase === "docked" ? sampleTradeShipMotion("retracting", 0, state.berth) : state;
}
