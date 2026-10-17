import type { ForestConversation } from "./forest-conversations";
import type { ForestSocialState, ForestSpeaker } from "./forest-social";
import type { ForestSocialFollowup } from "./forest-social-followup";
import type { ForestSocialFollowupKind } from "./forest-social-context";

export const forestSocialPairKey = (first: ForestSpeaker, second: ForestSpeaker) => [first, second].sort().join(":");

export type ForestConversationContinuation = { kind: ForestSocialFollowupKind; result: "completed" | "unfinished" };
export type ForestPromiseOutcome = { id: string; pair: string; speaker: "builder" | "lopukh"; host: "leaftail";
  kind: ForestSocialFollowupKind; status: "completed" | "interrupted" | "blocked"; topicId: string; at: number; consumedAt?: number };
export const FOREST_SOCIAL_CONTINUITY_LIMITS = { outcomes: 8, lifetime: 600 } as const;

export function pruneForestPromiseOutcomes(state: ForestSocialState): void {
  if (!state.promiseOutcomes?.length) return;
  const seen = new Set<string>();
  state.promiseOutcomes = state.promiseOutcomes.slice().reverse().filter(item => {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 256 || seen.has(item.id)
      || typeof item.topicId !== "string" || !item.topicId || item.topicId.length > 160
      || item.host !== "leaftail" || !["builder", "lopukh"].includes(item.speaker)
      || item.pair !== forestSocialPairKey(item.speaker, item.host)
      || item.kind !== (item.speaker === "builder" ? "inspect-window" : "check-woodpile")
      || !["completed", "interrupted", "blocked"].includes(item.status) || !Number.isFinite(item.at)
      || item.at > state.elapsed || state.elapsed - item.at >= FOREST_SOCIAL_CONTINUITY_LIMITS.lifetime
      || item.consumedAt !== undefined && (!Number.isFinite(item.consumedAt) || item.consumedAt < item.at || item.consumedAt > state.elapsed)) return false;
    seen.add(item.id); return true;
  }).slice(0, FOREST_SOCIAL_CONTINUITY_LIMITS.outcomes).reverse();
}
/** A promised action and its exact pair survive unrelated neighbours' actions.
 * This remembers an inspection, never a repaired window or an inventory gain. */
export function rememberForestPromiseOutcome(state: ForestSocialState, followup: ForestSocialFollowup,
  status: ForestPromiseOutcome["status"]): void {
  if (status === "completed" && (followup.phase !== "inspect" || followup.age < 3)) return;
  const pair = forestSocialPairKey(followup.speaker, followup.host);
  if (followup.pair && followup.pair !== pair) return;
  pruneForestPromiseOutcomes(state);
  const outcomes = state.promiseOutcomes ?? (state.promiseOutcomes = []);
  if (outcomes.some(item => item.id === followup.id)) return;
  outcomes.push({ id: followup.id, pair, speaker: followup.speaker, host: followup.host, kind: followup.kind,
    status, topicId: followup.topicId, at: state.elapsed });
  outcomes.splice(0, Math.max(0, outcomes.length - FOREST_SOCIAL_CONTINUITY_LIMITS.outcomes));
}
export function forestConversationContinuation(topic: ForestConversation): ForestConversationContinuation | undefined {
  return topic.continuation ?? (topic.condition === "window-inspected" ? { kind: "inspect-window", result: "completed" }
    : topic.condition === "woodpile-checked" ? { kind: "check-woodpile", result: "completed" } : undefined);
}
export function forestConversationOutcome(topic: ForestConversation, state: ForestSocialState,
  guest: ForestSpeaker, host: ForestSpeaker): ForestPromiseOutcome | undefined {
  const continuation = forestConversationContinuation(topic); if (!continuation) return undefined;
  const pair = forestSocialPairKey(guest, host);
  // A later result supersedes the earlier attempt for this pair/kind. A
  // finished or already acknowledged action cannot resurrect an old failure.
  const latest = state.promiseOutcomes?.slice().reverse().find(item => item.pair === pair
    && item.pair === forestSocialPairKey(item.speaker, item.host) && item.kind === continuation.kind
    && item.at <= state.elapsed && state.elapsed - item.at < FOREST_SOCIAL_CONTINUITY_LIMITS.lifetime);
  return latest && latest.consumedAt === undefined
    && (continuation.result === "completed" ? latest.status === "completed" : latest.status !== "completed") ? latest : undefined;
}
/** A continuation is acknowledged only after every authored reply. Cancelling
 * its conversation leaves the real outcome available for a later quiet moment. */
export function completeForestConversationOutcome(state: ForestSocialState, id: string | undefined,
  guest: ForestSpeaker, host: ForestSpeaker): void {
  const pair = forestSocialPairKey(guest, host);
  const outcome = state.promiseOutcomes?.find(item => item.id === id && item.pair === pair);
  if (outcome && outcome.consumedAt === undefined) outcome.consumedAt = state.elapsed;
}
