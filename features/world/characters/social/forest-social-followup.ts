import type { ForestSocialEnvironment, ForestSocialState, ForestSpeaker } from "./forest-social";
import type { ForestConversation } from "./forest-conversations";
import { rememberForestPromiseOutcome } from "./forest-social-continuity";
import { forestSocialPairKey } from "./forest-social-context";
import type { ForestSocialFollowupRequest } from "./forest-social-context";

export type ForestSocialFollowup = ForestSocialFollowupRequest & { topicId: string; pair?: string;
  phase: "queued" | "approach" | "inspect"; age: number };
export const FOREST_SOCIAL_FOLLOWUP_LIMITS = { queued: 8, approach: 45, inspect: 3,
  quiet: 240, history: 8 } as const;
export function queueForestSocialFollowup(state: ForestSocialState, topic?: ForestConversation,
  participants?: readonly [ForestSpeaker, ForestSpeaker]): void {
  if (!topic?.followup || state.followup) return;
  const pair = forestSocialPairKey(topic.followup.speaker, topic.followup.host);
  if (forestSocialPairKey(...topic.pair.split("-") as [ForestSpeaker, ForestSpeaker]) !== pair
    || participants && forestSocialPairKey(...participants) !== pair) return;
  state.followup = { ...topic.followup, id: `forest-followup-${state.sequence}-${topic.id}`,
    topicId: topic.id, pair, phase: "queued", age: 0 };
}
export function finishForestSocialFollowup(state: ForestSocialState, env: ForestSocialEnvironment,
  status: "completed" | "interrupted" | "blocked"): void {
  const followup = state.followup; if (!followup) return;
  rememberForestPromiseOutcome(state, followup, status);
  if (followup.phase !== "queued") env.cancelFollowup?.(followup.speaker);
  state.lastFollowupResult = { speaker: followup.speaker, kind: followup.kind, status, at: state.elapsed };
  state.followup = null;
  const history = state.followupHistory ?? (state.followupHistory = []);
  history.push(followup.topicId); history.splice(0, Math.max(0, history.length - FOREST_SOCIAL_FOLLOWUP_LIMITS.history));
  (state.followupAfter ?? (state.followupAfter = {}))[followup.speaker] = state.elapsed + FOREST_SOCIAL_FOLLOWUP_LIMITS.quiet;
}
export function advanceForestSocialFollowup(state: ForestSocialState, step: number, env: ForestSocialEnvironment): void {
  const followup = state.followup; if (!followup) return;
  const resident = env.actors.find(item => item.id === followup.speaker);
  const host = env.actors.find(item => item.id === followup.host);
  followup.age += step;
  if (env.enabled === false || env.ambient === false || !resident?.visible || !resident.available
    || !["idle", "walk"].includes(resident.context) || (env.rain ?? 0) >= .6 || (env.dusk ?? 0) >= .72
    || followup.kind === "inspect-window" && (!host?.visible || !host.available || !host.window)) {
    finishForestSocialFollowup(state, env, "interrupted"); return;
  }
  if (!env.requestFollowup || !env.cancelFollowup || !env.followupStatus) {
    finishForestSocialFollowup(state, env, "blocked"); return;
  }
  if (followup.phase === "queued") {
    if (state.current || state.queue.length || state.meeting) {
      if (followup.age >= FOREST_SOCIAL_FOLLOWUP_LIMITS.queued) finishForestSocialFollowup(state, env, "blocked");
      return;
    }
    if (!env.requestFollowup(followup)) { finishForestSocialFollowup(state, env, "blocked"); return; }
    followup.phase = "approach"; followup.age = 0;
  }
  const status = env.followupStatus(followup.speaker);
  if (!status) { finishForestSocialFollowup(state, env, "interrupted"); return; }
  if (followup.phase === "approach") {
    if (status === "arrived") { followup.phase = "inspect"; followup.age = 0; }
    else if (followup.age >= FOREST_SOCIAL_FOLLOWUP_LIMITS.approach) finishForestSocialFollowup(state, env, "blocked");
  } else if (status !== "arrived") finishForestSocialFollowup(state, env, "interrupted");
  else if (followup.age >= FOREST_SOCIAL_FOLLOWUP_LIMITS.inspect) finishForestSocialFollowup(state, env, "completed");
}
/** Only the arrived optional inspection is held. Real work/doors/manual routes
 * keep their existing preemption and can invalidate followupStatus at dt=0. */
export function forestSocialFollowupHolding(state: ForestSocialState, speaker: ForestSpeaker): boolean {
  return state.followup?.speaker === speaker && state.followup.phase === "inspect";
}
