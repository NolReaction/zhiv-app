const STEP = 1 / 120;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Stable, repeatable surface samples in world pixels. */
export function garageWaterHeight(x, seconds, amplitude = 10) {
  const size = clamp(finite(amplitude, 10), 0, 30);
  return size * (.68 * Math.sin(x / 310 - seconds * 1.12) + .32 * Math.sin(x / 137 + seconds * .73 + 1.4));
}

export function initialGarageWaterMotion() {
  return { tick: 0, remainder: 0, heave: 0, velocity: 0, roll: 0, angularVelocity: 0 };
}

/** Two buoyancy samples drive a damped heave/roll body. The fixed step makes
 * ordinary render-frame partitions produce the same body trajectory.
 * The accumulator drops long gaps: background time is never simulated.
 * This visual rig has no mass/economy/persistent scene state. */
export function advanceGarageWaterMotion(previous, elapsedSeconds, options = {}) {
  const elapsed = clamp(finite(elapsedSeconds, 0), 0, .25);
  const beam = clamp(finite(options.beam, 700), 80, 10_000);
  const centerX = finite(options.centerX, 0);
  const amplitude = clamp(finite(options.amplitude, 10), 0, 30);
  const state = { ...previous, remainder: previous.remainder + elapsed };
  const steps = Math.floor((state.remainder + 1e-10) / STEP);
  state.remainder = Math.max(0, state.remainder - steps * STEP);
  for (let index = 0; index < steps; index++) {
    state.tick++;
    const seconds = state.tick * STEP;
    const span = beam * .58;
    const left = garageWaterHeight(centerX - span / 2, seconds, amplitude);
    const right = garageWaterHeight(centerX + span / 2, seconds, amplitude);
    const targetHeave = (left + right) / 2;
    const targetRoll = clamp(Math.atan2(right - left, span) * 180 / Math.PI, -3, 3);
    state.velocity += ((targetHeave - state.heave) * 8 - state.velocity * 4.3) * STEP;
    state.heave = clamp(state.heave + state.velocity * STEP, -32, 32);
    state.angularVelocity += ((targetRoll - state.roll) * 7 - state.angularVelocity * 4.2) * STEP;
    state.roll = clamp(state.roll + state.angularVelocity * STEP, -3.2, 3.2);
  }
  return state;
}

export function garageWaterRigTransform(state, center) {
  return `translate(0 ${state.heave.toFixed(4)}) rotate(${state.roll.toFixed(4)} ${center.x} ${center.y})`;
}
