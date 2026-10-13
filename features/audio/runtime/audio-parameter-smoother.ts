/** Continuously retarget live spatial voices on the audio thread. Rebuilding a
 * linear envelope from a rounded JS clock introduces steps during camera drag,
 * especially in browsers without cancelAndHoldAtTime. Native target automation
 * starts from the rendered value and needs no cancellation or manual anchor. */
export function createAudioParameterSmoother(context: Pick<BaseAudioContext, "currentTime">) {
  const targets = new WeakMap<AudioParam, number>();
  return {
    has: (param: AudioParam) => targets.has(param),
    smooth(param: AudioParam, target: number, timeConstant: number, force = false) {
      if (!Number.isFinite(target) || !Number.isFinite(timeConstant) || timeConstant <= 0) return;
      const time = context.currentTime;
      if (!Number.isFinite(time) || time < 0) return;
      const previous = targets.get(param);
      if (!force && previous !== undefined && Math.abs(previous - target) < .00001) return;
      // No future endpoint is left behind: release and a quick return to a
      // source can retarget this same parameter without replaying the sample.
      param.setTargetAtTime(target, time, Math.max(.001, timeConstant));
      targets.set(param, target);
    },
  };
}
