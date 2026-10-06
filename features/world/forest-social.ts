import { cancelBuilderVisit, requestBuilderVisit, type BuilderMind } from "./builder-mind";
import { FOREST_ANIMAL_LINES, FOREST_CHAT_TOPICS, forestClickLines } from "./forest-social-dialogue";
import type { ResidentOccupant } from "./resident-traffic";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type ForestSpeaker = "mochlik" | "plesk" | "builder";
export type ForestSpeechContext = "idle" | "walk" | "build" | "ready" | "fish" | "cook" | "trade" | "sleep" | "busy" | "animal";
export type ForestSpeechFrame = { id: string; speaker: ForestSpeaker; text: string; elapsed: number; duration: number };
export type ForestSocialActor = { id: ForestSpeaker; position: WorldPoint; size: number; visible: boolean;
  /** Available for a conversation; cosmetic click replies do not need this. */
  available: boolean; context: ForestSpeechContext; canSpeak?: boolean };
export type ForestAnimalEvent = { id: string; speaker: ForestSpeaker; kind: "butterfly" | "firefly" | "bird" };
export type ForestSocialEnvironment = { scene: FixedWorldScene; builder: BuilderMind | null;
  actors: readonly ForestSocialActor[]; occupants?: readonly ResidentOccupant[]; enabled?: boolean;
  /** Still presentation may answer a tap without starting autonomous visits. */
  ambient?: boolean;
  dusk?: number; rain?: number; animalEvents?: readonly ForestAnimalEvent[] };
type Line = { speaker: ForestSpeaker; text: string };
type Meeting = { anchor: WorldPoint; phase: "approach" | "talk"; age: number };
export type ForestSocialState = {
  elapsed: number; seed: number; sequence: number;
  nextEncounterAt: number; nextAnimalAt: number; nextManualAt: number;
  manualAfter: Record<ForestSpeaker, number>;
  topicHistory: string[]; lineHistory: string[]; seenEvents: string[];
  current: ForestSpeechFrame | null; queue: Line[]; gapUntil: number;
  meeting: Meeting | null;
};
export const FOREST_SOCIAL_LIMITS = { maxDelta: 1, manualGlobal: 5, manualCharacter: 18,
  firstEncounter: 45, firstEncounterVariation: 30, encounter: 180, encounterVariation: 120,
  approach: 18, conversation: 15, retry: 25, animal: 150,
  historyTopics: 8, historyLines: 24, historyEvents: 16, gap: .4 } as const;
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0 || 1;
}
function random(state: ForestSocialState): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}
function remember(history: string[], value: string, maximum: number): void {
  history.push(value); if (history.length > maximum) history.splice(0, history.length - maximum);
}
function choose(state: ForestSocialState, options: readonly string[]): string {
  const unseen = options.filter(option => !state.lineHistory.includes(option));
  if (unseen.length) return unseen[Math.floor(random(state) * unseen.length)];
  // A tiny context pool can be exhausted; use the least recently spoken entry.
  return options.slice().sort((a, b) => state.lineHistory.lastIndexOf(a) - state.lineHistory.lastIndexOf(b))[0];
}
function actor(env: ForestSocialEnvironment, id: ForestSpeaker): ForestSocialActor | undefined {
  return env.actors.find(item => item.id === id && item.visible && item.canSpeak !== false
    && item.context !== "sleep" && Number.isFinite(item.position.x) && Number.isFinite(item.position.y));
}

/** A session-only director: no timers, network, rewards or persistent dialogue.
 * Feed the existing owner clock; reading frames never advances a conversation. */
export function createForestSocial(seed: string | number = "forest"): ForestSocialState {
  const state: ForestSocialState = { elapsed: 0, seed: hash(String(seed)), sequence: 0,
    nextEncounterAt: 0, nextAnimalAt: 45, nextManualAt: 0,
    manualAfter: { mochlik: 0, plesk: 0, builder: 0 }, topicHistory: [], lineHistory: [], seenEvents: [],
    current: null, queue: [], gapUntil: 0, meeting: null };
  state.nextEncounterAt = FOREST_SOCIAL_LIMITS.firstEncounter + random(state) * FOREST_SOCIAL_LIMITS.firstEncounterVariation;
  return state;
}
function speak(state: ForestSocialState, line: Line): void {
  state.current = { id: `forest-speech-${++state.sequence}`, ...line, elapsed: 0,
    duration: Math.min(4.4, 2.8 + line.text.length * .027) };
  remember(state.lineHistory, line.text, FOREST_SOCIAL_LIMITS.historyLines);
}
function postponeMeeting(state: ForestSocialState): void {
  state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.encounter + random(state) * FOREST_SOCIAL_LIMITS.encounterVariation;
}
function endMeeting(state: ForestSocialState, env: ForestSocialEnvironment): void {
  // A neighbour who walks away has not had a conversation yet. Retry quietly
  // later instead of consuming several minutes of the successful-chat budget.
  if (state.meeting?.phase === "approach") state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.retry + random(state) * 20;
  cancelBuilderVisit(env.builder); state.meeting = null; state.current = null; state.queue = [];
}
/** Explicit control/visibility changes can release the pair even at dt=0. */
export function cancelForestSocial(state: ForestSocialState, env: ForestSocialEnvironment): void {
  endMeeting(state, env);
}

export function noticeForestSocial(state: ForestSocialState, speaker: ForestSpeaker, env: ForestSocialEnvironment): boolean {
  const resident = actor(env, speaker);
  if (env.enabled === false || !resident || state.current || state.queue.length || state.meeting
    || state.elapsed < state.nextManualAt || state.elapsed < state.manualAfter[speaker]) return false;
  speak(state, { speaker, text: choose(state, forestClickLines(speaker, resident.context)) });
  state.manualAfter[speaker] = state.elapsed + FOREST_SOCIAL_LIMITS.manualCharacter;
  state.nextManualAt = state.elapsed + FOREST_SOCIAL_LIMITS.manualGlobal;
  // An intentional greeting should have some quiet around it.
  state.nextEncounterAt = Math.max(state.nextEncounterAt, state.elapsed + 30);
  state.nextAnimalAt = Math.max(state.nextAnimalAt, state.elapsed + 30);
  return true;
}
function beginConversation(state: ForestSocialState, env: ForestSocialEnvironment): void {
  const eligible = FOREST_CHAT_TOPICS.filter(topic => !topic.weather
    || topic.weather === "night" && (env.dusk ?? 0) > .55
    || topic.weather === "day" && (env.dusk ?? 0) <= .55 && (env.rain ?? 0) <= .35
    || topic.weather === "rain" && (env.rain ?? 0) > .35);
  const fresh = eligible.filter(topic => !state.topicHistory.includes(topic.id));
  const choices = fresh.length ? fresh : eligible;
  const topic = choices[Math.floor(random(state) * choices.length)];
  remember(state.topicHistory, topic.id, FOREST_SOCIAL_LIMITS.historyTopics);
  state.queue = [{ speaker: "mochlik", text: choose(state, topic.reply) }, { speaker: "builder", text: choose(state, topic.close) }];
  state.meeting!.phase = "talk"; state.meeting!.age = 0;
  postponeMeeting(state);
  speak(state, { speaker: "builder", text: choose(state, topic.open) });
  state.nextManualAt = state.elapsed + FOREST_SOCIAL_LIMITS.conversation + FOREST_SOCIAL_LIMITS.manualGlobal;
  state.nextAnimalAt = Math.max(state.nextAnimalAt, state.elapsed + FOREST_SOCIAL_LIMITS.animal);
}
function advanceMeeting(state: ForestSocialState, env: ForestSocialEnvironment, step: number): boolean {
  const meeting = state.meeting; if (!meeting) return false;
  const hero = actor(env, "mochlik"), builder = actor(env, "builder"), mind = env.builder;
  meeting.age += step;
  if (!hero?.available || !builder || !mind?.socialVisit || mind.job || !mind.available || mind.blocked
    || mind.scene !== env.scene || distance(hero.position, meeting.anchor) > Math.max(10, hero.size * .3)
    || meeting.age > (meeting.phase === "approach" ? FOREST_SOCIAL_LIMITS.approach : FOREST_SOCIAL_LIMITS.conversation)) {
    endMeeting(state, env); return false;
  }
  if (meeting.phase === "approach" && !mind.route && mind.action !== "walk") {
    const gap = (hero.size + builder.size) * .56;
    if (distance(hero.position, mind.position) > gap + 12) { endMeeting(state, env); return false; }
    beginConversation(state, env);
  }
  return true;
}

export function advanceForestSocial(state: ForestSocialState, dt: number, env: ForestSocialEnvironment): void {
  if (env.enabled === false) { endMeeting(state, env); return; }
  if (env.ambient === false && state.meeting) endMeeting(state, env);
  // A still-mode one-shot expiry can account for real quiet time without an
  // animation loop. It never starts a visit or replays intermediate dialogue.
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(env.ambient === false ? 30 : FOREST_SOCIAL_LIMITS.maxDelta, dt)) : 0;
  // Availability and job preemption remain immediate even on a still frame.
  if (state.meeting) advanceMeeting(state, env, step);
  if (state.current && !actor(env, state.current.speaker)) endMeeting(state, env);
  if (!step) return;
  state.elapsed += step;
  if (state.current) {
    state.current.elapsed += step;
    if (state.current.elapsed >= state.current.duration) { state.current = null; state.gapUntil = state.elapsed + FOREST_SOCIAL_LIMITS.gap; }
  }
  if (!state.current && state.queue.length && state.elapsed >= state.gapUntil) speak(state, state.queue.shift()!);
  if (state.meeting?.phase === "talk" && !state.current && !state.queue.length) endMeeting(state, env);

  // Events are consumed even while a bubble is visible: there is no backlog of
  // old animal greetings waiting to flood the next quiet moment.
  let animalEvent: ForestAnimalEvent | undefined;
  for (const event of (env.animalEvents ?? []).slice(0, 8)) {
    const key = `${event.speaker}:${event.kind}:${event.id}`;
    if (state.seenEvents.includes(key)) continue;
    remember(state.seenEvents, key, FOREST_SOCIAL_LIMITS.historyEvents);
    if (!animalEvent && actor(env, event.speaker)) animalEvent = event;
  }
  if (state.current || state.queue.length || state.meeting || env.ambient === false) return;
  if (state.elapsed >= state.nextEncounterAt) {
    const hero = actor(env, "mochlik"), builder = actor(env, "builder");
    if (hero?.available && builder?.available && hero.context === "idle" && env.builder && !env.builder.job
      && distance(hero.position, builder.position) < 300) {
      // Busy time does not consume the next quiet opportunity. Only an actual
      // bounded navigation attempt needs a retry delay; this gate is cheap.
      state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.retry;
      if (requestBuilderVisit(env.builder, env.scene, hero, env.occupants)) {
        state.meeting = { anchor: { ...hero.position }, phase: "approach", age: 0 }; return;
      }
    }
  }
  if (animalEvent && state.elapsed >= state.nextAnimalAt && state.elapsed >= state.nextManualAt) {
    speak(state, { speaker: animalEvent.speaker, text: choose(state, FOREST_ANIMAL_LINES[animalEvent.kind]) });
    state.nextAnimalAt = state.elapsed + FOREST_SOCIAL_LIMITS.animal;
    state.nextManualAt = state.elapsed + FOREST_SOCIAL_LIMITS.manualGlobal;
    state.nextEncounterAt = Math.max(state.nextEncounterAt, state.elapsed + 45);
  }
}

/** The hero is held only for the actual exchange, never while a visitor walks.
 * The scene must release this optional hold for any manual or economic action. */
export function forestSocialHolding(state: ForestSocialState): "mochlik" | null {
  return state.meeting?.phase === "talk" ? "mochlik" : null;
}
export function forestSocialFrames(state: ForestSocialState): ForestSpeechFrame[] {
  return state.current ? [{ ...state.current }] : [];
}
