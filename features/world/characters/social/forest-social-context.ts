import { forestSocialPairKey, forestConversationContinuation, forestConversationOutcome, pruneForestPromiseOutcomes } from "./forest-social-continuity";
import type { ForestConversation } from "./forest-conversations";
import type { ForestSocialPurpose } from "./forest-purpose-conversations";
import type { ForestSocialActor, ForestSocialState, ForestSpeaker } from "./forest-social";

/** Facts are supplied by the confirmed owner snapshot or actual completed scene
 * actions. Dialogue never infers an inventory, a sale or a reward from a pose. */
export type ForestSocialContextEvent =
  | { id: string; kind: "construction"; siteId: string; level: number }
  | { id: string; kind: "wood" | "mining" | "fishing"; speaker: ForestSpeaker };
export type ForestSocialContext = { events?: readonly ForestSocialContextEvent[] };
export type ForestSocialFact = ForestSocialContextEvent & { key: string; at: number };
export type ForestSocialFollowupKind = "inspect-window" | "check-woodpile";
export type ForestSocialFollowupRequest = { id: string; speaker: "builder" | "lopukh";
  kind: ForestSocialFollowupKind; host: "leaftail" };
export type ForestConversationCondition = "recent-pair" | "window-inspected" | "woodpile-checked"
  | "construction" | "wood" | "mining" | "fishing";
export const FOREST_SOCIAL_CONTEXT_LIMITS = { facts: 8, seenFacts: 24, pairMemories: 15,
  pairTopics: 3, eventStories: 24, factLife: 300, familiarLife: 600 } as const;
export { forestSocialPairKey } from "./forest-social-continuity";
function valid(event: ForestSocialContextEvent): boolean {
  return typeof event?.id === "string" && event.id.length > 0 && event.id.length <= 160
    && (event.kind === "construction" ? typeof event.siteId === "string" && event.siteId.length > 0
      && Number.isInteger(event.level) && event.level > 0 && event.level <= 100
      : ["wood", "mining", "fishing"].includes(event.kind)
        && ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"].includes(event.speaker));
}
export function observeForestSocialContext(state: ForestSocialState, context?: ForestSocialContext): void {
  pruneForestPromiseOutcomes(state);
  if (!state.contextFacts?.length && !context?.events?.length) return;
  const facts = state.contextFacts ?? (state.contextFacts = []), seen = state.seenContextFacts ?? (state.seenContextFacts = []);
  for (const event of (context?.events ?? []).slice(0, FOREST_SOCIAL_CONTEXT_LIMITS.facts)) {
    if (!valid(event)) continue;
    const key = `${event.kind}:${event.id}`;
    if (seen.includes(key)) continue;
    seen.push(key); facts.push({ ...event, key, at: state.elapsed });
  }
  seen.splice(0, Math.max(0, seen.length - FOREST_SOCIAL_CONTEXT_LIMITS.seenFacts));
  state.contextFacts = facts.filter(fact => state.elapsed - fact.at <= FOREST_SOCIAL_CONTEXT_LIMITS.factLife)
    .slice(-FOREST_SOCIAL_CONTEXT_LIMITS.facts);
}
export function forestConversationFact(topic: ForestConversation, state: ForestSocialState,
  guest: ForestSpeaker, host: ForestSpeaker): ForestSocialFact | undefined {
  const condition = topic.condition;
  if (!condition || !["construction", "wood", "mining", "fishing"].includes(condition)) return undefined;
  return state.contextFacts?.slice().reverse().find(fact => fact.kind === condition
    && (fact.kind === "construction" ? !topic.siteId || topic.siteId === fact.siteId : [guest, host].includes(fact.speaker))
    && !(state.eventStoryHistory ?? []).includes(`${forestSocialPairKey(guest, host)}:${fact.key}`));
}
/** Pure selection contract: contextual stories are additive, ordinary complete
 * scripts remain available; an exhausted purpose can never mask the rest. */
export function eligibleForestConversations(topics: readonly ForestConversation[], state: ForestSocialState,
  guest: ForestSocialActor, host: ForestSocialActor, purpose: ForestSocialPurpose, canFollowup: boolean): ForestConversation[] {
  const pair = forestSocialPairKey(guest.id, host.id), memory = state.pairMemories?.find(item => item.pair === pair);
  return topics.filter(topic => (!host.window || topic.purpose === "window")
    && (host.context !== "fish" || topic.purpose === "fish" || topic.condition === "fishing")
    && forestSocialPairKey(...topic.pair.split("-") as [ForestSpeaker, ForestSpeaker]) === pair
    && (purpose === "passing" ? topic.purpose === "passing" : topic.purpose !== "passing"
      && (!topic.purpose || topic.purpose === purpose))
    && (!forestConversationContinuation(topic) || Boolean(forestConversationOutcome(topic, state, guest.id, host.id)))
    && (!topic.followup || canFollowup && (state.followupAfter?.[topic.followup.speaker] ?? 0) <= state.elapsed
      && !(state.followupHistory ?? []).includes(topic.id))
    && (!topic.condition || topic.condition === "recent-pair" && Boolean(memory && state.elapsed - memory.at < FOREST_SOCIAL_CONTEXT_LIMITS.familiarLife)
      || (topic.condition === "window-inspected" || topic.condition === "woodpile-checked")
        && Boolean(forestConversationOutcome(topic, state, guest.id, host.id))
      || Boolean(forestConversationFact(topic, state, guest.id, host.id))));
}
export function rememberForestConversation(state: ForestSocialState, topic: ForestConversation,
  guest: ForestSpeaker, host: ForestSpeaker): void {
  const pair = forestSocialPairKey(guest, host), memories = state.pairMemories ?? (state.pairMemories = []);
  const old = memories.findIndex(item => item.pair === pair), prior = old >= 0 ? memories.splice(old, 1)[0] : null;
  memories.push({ pair, at: state.elapsed, topics: [...prior?.topics ?? [], topic.id].slice(-FOREST_SOCIAL_CONTEXT_LIMITS.pairTopics) });
  memories.splice(0, Math.max(0, memories.length - FOREST_SOCIAL_CONTEXT_LIMITS.pairMemories));
  const fact = forestConversationFact(topic, state, guest, host);
  if (fact) {
    const history = state.eventStoryHistory ?? (state.eventStoryHistory = []);
    history.push(`${pair}:${fact.key}`); history.splice(0, Math.max(0, history.length - FOREST_SOCIAL_CONTEXT_LIMITS.eventStories));
  }
}
