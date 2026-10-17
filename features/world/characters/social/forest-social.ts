import { cancelBuilderVisit, requestBuilderVisit, type BuilderMind } from "@/features/world/characters/builder/builder-mind";
import { forestAnimalLines, forestClickLines } from "./forest-social-dialogue";
import { FOREST_CONVERSATIONS, type ForestConversation } from "./forest-conversations";
import type { ForestSocialPurpose } from "./forest-purpose-conversations";
import { eligibleForestConversations, rememberForestConversation, observeForestSocialContext,
  type ForestSocialContext, type ForestSocialFact, type ForestSocialFollowupRequest, type ForestSocialFollowupKind } from "./forest-social-context";
import { forestConversationOutcome, completeForestConversationOutcome,
  type ForestPromiseOutcome } from "./forest-social-continuity";
import { advanceForestSocialFollowup, finishForestSocialFollowup, queueForestSocialFollowup,
  type ForestSocialFollowup } from "./forest-social-followup";
export { forestSocialFollowupHolding } from "./forest-social-followup";
export type { ForestSocialContext, ForestSocialContextEvent, ForestSocialFollowupRequest } from "./forest-social-context";
import { canTraverse, createWorldNavigation } from "@/features/world/navigation/navigation";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type ForestSpeaker = "mochlik" | "plesk" | "builder" | "lopukh" | "kamneshmyg" | "leaftail";
export type ForestSpeechContext = "idle" | "walk" | "build" | "ready" | "fish" | "cook" | "trade" | "sleep" | "busy" | "animal" | "chop" | "mine" | "arrive";
export type ForestSpeechFrame = { id: string; speaker: ForestSpeaker; text: string; elapsed: number; duration: number;
  /** A direct reply addresses the player; autonomous chatter stays in the world. */
  origin: "interaction" | "ambient" };
export type ForestSocialActor = { id: ForestSpeaker; position: WorldPoint; size: number; visible: boolean;
  /** Available for a conversation; cosmetic click replies do not need this. */
  available: boolean; context: ForestSpeechContext; canSpeak?: boolean;
  moving?: boolean; canPausePassing?: boolean; socialNeed?: number;
  /** A stationary fisher/shopkeeper can receive a question without abandoning
   * the activity. Work with tools, packing and real player trade stay busy. */
  canReceiveVisit?: boolean;
  /** A window voice is presentation only; approach is a proven exterior foot
   * stop and never an occupant standing inside a collision polygon. */
  window?: boolean; approach?: WorldPoint; speechAnchor?: WorldPoint };
export type ForestAnimalEvent = { id: string; speaker: ForestSpeaker; kind: "butterfly" | "firefly" | "bird" };
export type ForestSocialEnvironment = { scene: FixedWorldScene; builder: BuilderMind | null;
  actors: readonly ForestSocialActor[]; occupants?: readonly ResidentOccupant[]; enabled?: boolean;
  /** Still presentation may answer a tap without starting autonomous visits. */
  ambient?: boolean;
  /** The scene adapts its resident minds; this director never owns their feet. */
  requestVisit?: (guest: ForestSpeaker, host: ForestSocialActor, occupants?: readonly ResidentOccupant[]) => boolean;
  cancelVisit?: (guest: ForestSpeaker) => void;
  visitStatus?: (guest: ForestSpeaker) => "approach" | "arrived" | null;
  context?: ForestSocialContext;
  /** The scene resolves semantic destinations through existing checked routes.
   * No job, item, purchase or reward is issued by a followup. */
  requestFollowup?: (request: ForestSocialFollowupRequest) => boolean;
  cancelFollowup?: (speaker: "builder" | "lopukh") => void;
  followupStatus?: (speaker: "builder" | "lopukh") => "approach" | "arrived" | null;
  dusk?: number; rain?: number; animalEvents?: readonly ForestAnimalEvent[] };
type Line = { speaker: ForestSpeaker; text: string };
type Meeting = { anchor: WorldPoint; guestAnchor: WorldPoint; host: ForestSpeaker;
  guest: ForestSpeaker; visit: "builder" | "resident" | null; phase: "approach" | "talk"; age: number;
  purpose?: ForestSocialPurpose; approach?: WorldPoint; hostContext?: ForestSpeechContext; topicId?: string; continuationId?: string };
export type ForestSocialState = {
  elapsed: number; seed: number; sequence: number;
  nextEncounterAt: number; nextAnimalAt: number; nextManualAt: number;
  manualAfter: Record<ForestSpeaker, number>;
  topicHistory: string[]; lineHistory: string[]; seenEvents: string[];
  current: ForestSpeechFrame | null; queue: Line[]; gapUntil: number;
  meeting: Meeting | null;
  passingPairs?: string[]; passingAfter?: Partial<Record<ForestSpeaker, number>>; pairAfter?: Record<string, number>;
  nextPassingAt?: number;
  contextFacts?: ForestSocialFact[]; seenContextFacts?: string[]; eventStoryHistory?: string[];
  pairMemories?: { pair: string; at: number; topics: string[] }[];
  promiseOutcomes?: ForestPromiseOutcome[];
  followup?: ForestSocialFollowup | null; followupHistory?: string[];
  followupAfter?: Partial<Record<"builder" | "lopukh", number>>;
  lastFollowupResult?: { speaker: "builder" | "lopukh"; kind: ForestSocialFollowupKind;
    status: "completed" | "interrupted" | "blocked"; at: number };
  lastMeetingResult?: { guest: ForestSpeaker; host: ForestSpeaker; purpose: ForestSocialPurpose;
    status: "completed" | "interrupted" | "blocked"; at: number };
};
export const FOREST_SOCIAL_LIMITS = { maxDelta: 1, manualGlobal: 5, manualCharacter: 18,
  firstEncounter: 30, firstEncounterVariation: 20, encounter: 110, encounterVariation: 70,
  approach: 18, conversation: 32, retry: 25, animal: 150,
  navigationAttempts: 4, passingChance: .38, passingRadius: 82, passingQuiet: 36, personalQuiet: 65, pairQuiet: 150,
  historyTopics: 12, historyLines: 48, historyEvents: 16, gap: .4 } as const;
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const speechDuration = (text: string) => Math.min(4.4, 2.8 + text.length * .027);
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
    && item.context !== "sleep" && Number.isFinite(item.size) && item.size > 0
    && Number.isFinite(item.position.x) && Number.isFinite(item.position.y));
}
const pairKey = (first: ForestSpeaker, second: ForestSpeaker) => [first, second].sort().join(":");
const idle = (item: ForestSocialActor) => item.available && item.context === "idle";
const passingReady = (item: ForestSocialActor) => item.available && !item.window
  && (item.context === "idle" || item.context === "walk" && item.canPausePassing === true);
const receiving = (item: ForestSocialActor) => item.available && (item.context === "idle"
  || item.canReceiveVisit === true && ["fish", "trade"].includes(item.context));
const purposeOf = (host: ForestSocialActor): ForestSocialPurpose => host.window ? "window"
  : host.id === "plesk" ? "fish" : host.id === "leaftail" ? "trade" : "neighbour";
function rememberPair(state: ForestSocialState, guest: ForestSpeaker, host: ForestSpeaker) {
  const personal = state.passingAfter ?? (state.passingAfter = {}), pairs = state.pairAfter ?? (state.pairAfter = {});
  personal[guest] = personal[host] = state.elapsed + FOREST_SOCIAL_LIMITS.personalQuiet;
  pairs[pairKey(guest, host)] = state.elapsed + FOREST_SOCIAL_LIMITS.pairQuiet;
  for (const key of Object.keys(pairs)) if (pairs[key] <= state.elapsed) delete pairs[key];
}

/** A session-only director: no timers, network, rewards or persistent dialogue.
 * Feed the existing owner clock; reading frames never advances a conversation. */
export function createForestSocial(seed: string | number = "forest"): ForestSocialState {
  const state: ForestSocialState = { elapsed: 0, seed: hash(String(seed)), sequence: 0,
    nextEncounterAt: 0, nextAnimalAt: 45, nextManualAt: 0,
    manualAfter: { mochlik: 0, plesk: 0, builder: 0, lopukh: 0, kamneshmyg: 0, leaftail: 0 }, topicHistory: [], lineHistory: [], seenEvents: [],
    current: null, queue: [], gapUntil: 0, meeting: null, contextFacts: [], seenContextFacts: [], eventStoryHistory: [],
    pairMemories: [], promiseOutcomes: [], followup: null, followupHistory: [], followupAfter: {} };
  state.nextEncounterAt = FOREST_SOCIAL_LIMITS.firstEncounter + random(state) * FOREST_SOCIAL_LIMITS.firstEncounterVariation;
  return state;
}
function speak(state: ForestSocialState, line: Line, origin: ForestSpeechFrame["origin"] = "ambient"): void {
  state.current = { id: `forest-speech-${++state.sequence}`, ...line, origin, elapsed: 0,
    duration: speechDuration(line.text) };
  remember(state.lineHistory, line.text, FOREST_SOCIAL_LIMITS.historyLines);
}
function postponeMeeting(state: ForestSocialState): void {
  state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.encounter + random(state) * FOREST_SOCIAL_LIMITS.encounterVariation;
}
function endMeeting(state: ForestSocialState, env: ForestSocialEnvironment,
  status: NonNullable<ForestSocialState["lastMeetingResult"]>["status"] = "interrupted"): void {
  const meeting = state.meeting;
  const topic = status === "completed" ? FOREST_CONVERSATIONS.find(item => item.id === state.meeting?.topicId) : undefined;
  if (state.meeting) state.lastMeetingResult = { guest: state.meeting.guest, host: state.meeting.host,
    purpose: state.meeting.purpose ?? "neighbour", status, at: state.elapsed };
  // A neighbour who walks away has not had a conversation yet. Retry quietly
  // later instead of consuming several minutes of the successful-chat budget.
  if (state.meeting?.phase === "approach") state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.retry + random(state) * 20;
  if (state.meeting?.visit === "builder") cancelBuilderVisit(env.builder);
  if (state.meeting?.visit === "resident") env.cancelVisit?.(state.meeting.guest);
  state.meeting = null; state.current = null; state.queue = [];
  if (status === "completed" && meeting) {
    completeForestConversationOutcome(state, meeting.continuationId, meeting.guest, meeting.host);
    queueForestSocialFollowup(state, topic, [meeting.guest, meeting.host]);
  }
}
/** Explicit control/visibility changes can release the pair even at dt=0. */
export function cancelForestSocial(state: ForestSocialState, env: ForestSocialEnvironment): void {
  endMeeting(state, env);
  finishForestSocialFollowup(state, env, "interrupted");
}

export function noticeForestSocial(state: ForestSocialState, speaker: ForestSpeaker, env: ForestSocialEnvironment): boolean {
  const resident = actor(env, speaker);
  if (env.enabled === false || !resident || state.current || state.queue.length || state.meeting
    || state.elapsed < state.nextManualAt || state.elapsed < state.manualAfter[speaker]) return false;
  speak(state, { speaker, text: choose(state, forestClickLines(speaker, resident.context)) }, "interaction");
  state.manualAfter[speaker] = state.elapsed + FOREST_SOCIAL_LIMITS.manualCharacter;
  state.nextManualAt = state.elapsed + FOREST_SOCIAL_LIMITS.manualGlobal;
  // An intentional greeting should have some quiet around it.
  state.nextEncounterAt = Math.max(state.nextEncounterAt, state.elapsed + 30);
  state.nextAnimalAt = Math.max(state.nextAnimalAt, state.elapsed + 30);
  state.nextPassingAt = Math.max(state.nextPassingAt ?? 0, state.elapsed + 30);
  return true;
}
/** Location-specific banter only refers to something actually near the pair.
 * All other scripts discuss their ordinary work without claiming game state. */
function nearbyTopic(topic: ForestConversation, env: ForestSocialEnvironment, anchor: WorldPoint): boolean {
  if (!topic.place) return true;
  const points = topic.place === "river" ? (env.scene.destinations ?? [])
    .filter(item => ["fishing", "plesk-fishing", "plesk-rest", "plesk-trade"].includes(item.id)).map(item => item.position)
    : topic.place === "garden" ? (env.scene.bushes ?? []).map(item => item.entry)
    : topic.place === "campfire" ? (env.scene.campfires ?? []).map(item => item.position)
    : env.scene.sites.filter(item => item.id === topic.place).map(item => item.anchor);
  return points.some(point => distance(point, anchor) <= 180);
}
function beginConversation(state: ForestSocialState, env: ForestSocialEnvironment): void {
  const meeting = state.meeting!;
  const guest = actor(env, meeting.guest)!, host = actor(env, meeting.host)!;
  const eligible = eligibleForestConversations(FOREST_CONVERSATIONS, state, guest, host,
    meeting.purpose ?? "neighbour", Boolean(env.requestFollowup && env.cancelFollowup && env.followupStatus))
    .filter(topic => nearbyTopic(topic, env, meeting.anchor) && (!topic.weather
      || topic.weather === "night" && (env.dusk ?? 0) > .55
      || topic.weather === "day" && (env.dusk ?? 0) <= .55 && (env.rain ?? 0) <= .35
      || topic.weather === "rain" && (env.rain ?? 0) > .35));
  if (!eligible.length) { endMeeting(state, env, "blocked"); return; }
  const memory = state.pairMemories?.find(item => item.pair === pairKey(guest.id, host.id));
  const fresh = eligible.filter(topic => !state.topicHistory.includes(topic.id) && !memory?.topics.includes(topic.id));
  const continuations = eligible.filter(topic => forestConversationOutcome(topic, state, guest.id, host.id));
  let choices = continuations.length ? continuations : fresh.length ? fresh : eligible.slice().sort((a, b) =>
    state.topicHistory.lastIndexOf(a.id) - state.topicHistory.lastIndexOf(b.id)).slice(0, 1);
  // Fresh facts/weather usually lead the exchange; purposeful visits still
  // have room for ordinary complete stories rather than one permanent script.
  const contextual = choices.filter(topic => topic.condition || topic.continuation || topic.weather === "rain" || topic.weather === "night");
  const purposeful = choices.filter(topic => topic.purpose === meeting.purpose);
  if (contextual.length && random(state) < .8) choices = contextual;
  else if (purposeful.length && random(state) < .65) choices = purposeful;
  const topic = choices[Math.floor(random(state) * choices.length)];
  meeting.topicId = topic.id;
  meeting.continuationId = forestConversationOutcome(topic, state, guest.id, host.id)?.id;
  rememberForestConversation(state, topic, guest.id, host.id);
  remember(state.topicHistory, topic.id, FOREST_SOCIAL_LIMITS.historyTopics);
  state.queue = topic.lines.slice(1).map(line => ({ ...line }));
  meeting.phase = "talk"; meeting.age = 0;
  meeting.guestAnchor = { ...actor(env, meeting.guest)!.position };
  if (meeting.purpose === "passing") state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.passingQuiet;
  else postponeMeeting(state);
  rememberPair(state, meeting.guest, meeting.host);
  state.nextPassingAt = state.elapsed + FOREST_SOCIAL_LIMITS.passingQuiet;
  speak(state, topic.lines[0]);
  const duration = topic.lines.reduce((total, line) => total + speechDuration(line.text), 0)
    + (topic.lines.length - 1) * FOREST_SOCIAL_LIMITS.gap;
  state.nextManualAt = state.elapsed + duration + FOREST_SOCIAL_LIMITS.manualGlobal;
  state.nextAnimalAt = Math.max(state.nextAnimalAt, state.elapsed + FOREST_SOCIAL_LIMITS.animal);
}
function advanceMeeting(state: ForestSocialState, env: ForestSocialEnvironment, step: number): boolean {
  const meeting = state.meeting; if (!meeting) return false;
  const host = actor(env, meeting.host), guest = actor(env, meeting.guest), mind = env.builder;
  const passing = meeting.purpose === "passing";
  meeting.age += step;
  if (!host || !(passing ? passingReady(host) : receiving(host)) || !guest?.available
    || meeting.visit === "builder" && (!mind?.socialVisit || mind.job || !mind.available || mind.blocked || mind.scene !== env.scene)
    || meeting.visit === "resident" && !env.visitStatus?.(meeting.guest)
    || distance(host.position, meeting.anchor) > Math.max(10, host.size * .3)
    || meeting.phase === "talk" && (!(passing ? passingReady(guest) : guest.context === "idle")
      || distance(guest.position, meeting.guestAnchor) > Math.max(10, guest.size * .3))
    || meeting.age > (meeting.phase === "approach" ? FOREST_SOCIAL_LIMITS.approach : FOREST_SOCIAL_LIMITS.conversation)) {
    endMeeting(state, env); return false;
  }
  const arrived = meeting.visit === "builder" ? Boolean(mind && !mind.route && mind.action !== "walk")
    : meeting.visit === "resident" && env.visitStatus?.(meeting.guest) === "arrived";
  if (meeting.phase === "approach" && arrived) {
    const gap = (host.size + guest.size) * .56;
    const navigation = createWorldNavigation(env.scene, Math.min(guest.size, host.size) * .1);
    const target = meeting.approach ?? host.position;
    if (guest.context !== "idle" || distance(target, guest.position) > (meeting.approach ? 12 : gap + 12)
      || !navigation || !canTraverse(navigation, guest.position, target)) { endMeeting(state, env); return false; }
    beginConversation(state, env);
  }
  return true;
}

function pairMatches(pair: string, guest: ForestSpeaker, host: ForestSpeaker): boolean {
  return pair === `${guest}-${host}` || pair === `${host}-${guest}`;
}
function visitKind(guest: ForestSocialActor, host: ForestSocialActor, env: ForestSocialEnvironment): Meeting["visit"] {
  if (guest.window || guest.id === "mochlik") return null;
  if (guest.id === "builder" && env.builder && !env.builder.job && !host.approach) return "builder";
  return env.requestVisit && env.cancelVisit && env.visitStatus ? "resident" : null;
}
function startVisit(state: ForestSocialState, guest: ForestSocialActor, host: ForestSocialActor,
  env: ForestSocialEnvironment, visit: Meeting["visit"]): boolean {
  if (visit === "builder") {
    if (!requestBuilderVisit(env.builder, env.scene, host, env.occupants)) return false;
  } else if (visit === "resident") {
    if (!env.requestVisit?.(guest.id, host, env.occupants)) return false;
  } else {
    const navigation = createWorldNavigation(env.scene, Math.min(guest.size, host.size) * .1);
    const target = host.approach ?? host.position;
    if (!navigation || host.window && (!host.approach || distance(guest.position, target) > 12)
      || !canTraverse(navigation, guest.position, target)) return false;
  }
  state.meeting = { anchor: { ...host.position }, guestAnchor: { ...guest.position },
    host: host.id, guest: guest.id, visit, phase: visit ? "approach" : "talk", age: 0,
    purpose: purposeOf(host), hostContext: host.context,
    ...(host.approach ? { approach: { ...host.approach } } : {}) };
  if (state.meeting.phase === "talk") beginConversation(state, env);
  return Boolean(state.meeting);
}

/** A deterministic request for an isolated rehearsal or an intentional visit.
 * It still needs real availability, callback ownership and a safe approach. */
export function requestForestSocialVisit(state: ForestSocialState, guestId: ForestSpeaker, hostId: ForestSpeaker,
  env: ForestSocialEnvironment): boolean {
  if (guestId === hostId || env.enabled === false || env.ambient === false || state.current || state.queue.length || state.meeting || state.followup) return false;
  const guest = actor(env, guestId), host = actor(env, hostId);
  if (!guest || !host || !(passingReady(guest) || guest.id === "builder" && guest.available && guest.context === "walk")
    || !receiving(host)) return false;
  const visit = visitKind(guest, host, env);
  if (!visit && distance(guest.position, host.approach ?? host.position) > (host.window ? 12 : Math.max(75, (guest.size + host.size) * 1.1))) return false;
  return startVisit(state, guest, host, env, visit);
}

function inviteNeighbours(state: ForestSocialState, env: ForestSocialEnvironment): void {
  const residents = env.actors.map(item => actor(env, item.id)).filter((item): item is ForestSocialActor => Boolean(item));
  const candidates: { guest: ForestSocialActor; host: ForestSocialActor; visit: Meeting["visit"] }[] = [];
  for (const guest of residents) {
    if (state.followup?.speaker === guest.id || !guest.available || guest.window || guest.id !== "builder" && !passingReady(guest)) continue;
    for (const host of residents) {
      const visit = visitKind(guest, host, env);
      if (state.followup?.speaker !== host.id && host.id !== guest.id && visit && receiving(host) && distance(host.approach ?? host.position, guest.position) < 420
        && (state.pairAfter?.[pairKey(guest.id, host.id)] ?? 0) <= state.elapsed) candidates.push({ guest, host, visit });
    }
  }
  // Already nearby pairs speak from their present safe feet. No player
  // destination, fishing trip or work route is borrowed just to make a circle.
  for (let index = 0; index < residents.length; index++) for (const host of residents.slice(index + 1)) {
    const guest = residents[index];
    if (state.followup?.speaker === guest.id || state.followup?.speaker === host.id || !idle(guest) || !receiving(host) || host.window || (state.pairAfter?.[pairKey(guest.id, host.id)] ?? 0) > state.elapsed
      || distance(guest.position, host.position) > Math.max(75, (guest.size + host.size) * 1.1)) continue;
    const navigation = createWorldNavigation(env.scene, Math.min(guest.size, host.size) * .1);
    if (!navigation || !canTraverse(navigation, guest.position, host.position)) continue;
    // Already nearby neighbours need no artificial circle around each other.
    // Keep a real route only when the pair still has distance to cover.
    for (let at = candidates.length - 1; at >= 0; at--)
      if (pairMatches(`${candidates[at].guest.id}-${candidates[at].host.id}`, guest.id, host.id)) candidates.splice(at, 1);
    candidates.push({ guest, host, visit: null });
  }
  if (!candidates.length) return;
  const previousPair = FOREST_CONVERSATIONS.find(topic => topic.id === state.topicHistory.at(-1))?.pair;
  const start = Math.floor(random(state) * candidates.length);
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)]
    .sort((a, b) => Number(Boolean(previousPair && pairMatches(previousPair, a.guest.id, a.host.id)))
      - Number(Boolean(previousPair && pairMatches(previousPair, b.guest.id, b.host.id)))
      || (b.guest.socialNeed ?? .5) - (a.guest.socialNeed ?? .5));
  // Busy time does not consume a quiet opportunity. Bounded navigation attempts
  // do have a retry delay, even when the selected nearby bank is inaccessible.
  state.nextEncounterAt = state.elapsed + FOREST_SOCIAL_LIMITS.retry;
  for (const { guest, host, visit } of ordered.slice(0, FOREST_SOCIAL_LIMITS.navigationAttempts)) {
    if (startVisit(state, guest, host, env, visit)) return;
  }
}

/** A crossing is sampled once when neighbours enter personal range. Watching
 * another camera, remaining nearby, and busy speech never queue another try. */
function passingNeighbours(state: ForestSocialState, env: ForestSocialEnvironment, canStart: boolean): void {
  const residents = env.actors.map(item => actor(env, item.id)).filter((item): item is ForestSocialActor => Boolean(item && !item.window))
    .sort((a, b) => a.id.localeCompare(b.id));
  const previous = new Set(state.passingPairs ?? []), nearby: string[] = [];
  let attempts = 0;
  for (let index = 0; index < residents.length; index++) for (const host of residents.slice(index + 1)) {
    const guest = residents[index], key = pairKey(guest.id, host.id);
    if (distance(guest.position, host.position) > FOREST_SOCIAL_LIMITS.passingRadius) continue;
    nearby.push(key);
    if (previous.has(key) || !canStart || state.meeting || !passingReady(guest) || !passingReady(host)
      || !(guest.moving || host.moving) || state.elapsed < (state.nextPassingAt ?? 0)
      || state.elapsed < (state.passingAfter?.[guest.id] ?? 0) || state.elapsed < (state.passingAfter?.[host.id] ?? 0)
      || state.elapsed < (state.pairAfter?.[key] ?? 0) || attempts >= FOREST_SOCIAL_LIMITS.navigationAttempts) continue;
    if (random(state) >= FOREST_SOCIAL_LIMITS.passingChance) continue;
    attempts++;
    const navigation = createWorldNavigation(env.scene, Math.min(guest.size, host.size) * .1);
    if (!navigation || !canTraverse(navigation, guest.position, host.position)) continue;
    state.meeting = { anchor: { ...host.position }, guestAnchor: { ...guest.position }, host: host.id,
      guest: guest.id, visit: null, phase: "talk", age: 0, purpose: "passing" };
    beginConversation(state, env);
  }
  state.passingPairs = nearby.slice(0, 15);
}

export function advanceForestSocial(state: ForestSocialState, dt: number, env: ForestSocialEnvironment): void {
  if (env.enabled === false) { cancelForestSocial(state, env); return; }
  if (env.ambient === false && (state.meeting || state.followup)) cancelForestSocial(state, env);
  // A still-mode one-shot expiry can account for real quiet time without an
  // animation loop. It never starts a visit or replays intermediate dialogue.
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(env.ambient === false ? 30 : FOREST_SOCIAL_LIMITS.maxDelta, dt)) : 0;
  // Availability and job preemption remain immediate even on a still frame.
  if (state.meeting) advanceMeeting(state, env, step);
  if (state.current && !actor(env, state.current.speaker)) endMeeting(state, env);
  advanceForestSocialFollowup(state, 0, env);
  if (!step) return;
  state.elapsed += step;
  observeForestSocialContext(state, env.context);
  if (state.current) {
    state.current.elapsed += step;
    if (state.current.elapsed >= state.current.duration) { state.current = null; state.gapUntil = state.elapsed + FOREST_SOCIAL_LIMITS.gap; }
  }
  if (!state.current && state.queue.length && state.elapsed >= state.gapUntil) speak(state, state.queue.shift()!);
  if (state.meeting?.phase === "talk" && !state.current && !state.queue.length) endMeeting(state, env, "completed");
  advanceForestSocialFollowup(state, step, env);

  // Events are consumed even while a bubble is visible: there is no backlog of
  // old animal greetings waiting to flood the next quiet moment.
  let animalEvent: ForestAnimalEvent | undefined;
  for (const event of (env.animalEvents ?? []).slice(0, 8)) {
    const key = `${event.speaker}:${event.kind}:${event.id}`;
    if (state.seenEvents.includes(key)) continue;
    remember(state.seenEvents, key, FOREST_SOCIAL_LIMITS.historyEvents);
    if (!animalEvent && actor(env, event.speaker)) animalEvent = event;
  }
  passingNeighbours(state, env, !state.current && !state.queue.length && !state.meeting && !state.followup && env.ambient !== false
    && state.elapsed >= state.nextManualAt && (env.rain ?? 0) < .35 && (env.dusk ?? 0) < .65);
  if (state.current || state.queue.length || state.meeting || state.followup || env.ambient === false) return;
  if (state.elapsed >= state.nextEncounterAt) {
    inviteNeighbours(state, env);
    if (state.meeting) return;
  }
  if (animalEvent && state.elapsed >= state.nextAnimalAt && state.elapsed >= state.nextManualAt) {
    speak(state, { speaker: animalEvent.speaker, text: choose(state, forestAnimalLines(animalEvent.speaker, animalEvent.kind)) });
    state.nextAnimalAt = state.elapsed + FOREST_SOCIAL_LIMITS.animal;
    state.nextManualAt = state.elapsed + FOREST_SOCIAL_LIMITS.manualGlobal;
    state.nextEncounterAt = Math.max(state.nextEncounterAt, state.elapsed + 45);
  }
}

/** The hero is held only for the actual exchange, never while a visitor walks.
 * The scene must release this optional hold for any manual or economic action. */
export function forestSocialHolding(state: ForestSocialState): "mochlik" | null {
  return forestSocialPartner(state, "mochlik") ? "mochlik" : null;
}
/** The scene uses this to hold/facing only the two actual participants. */
export function forestSocialPartner(state: ForestSocialState, speaker: ForestSpeaker): ForestSpeaker | null {
  const meeting = state.meeting;
  if (meeting?.phase !== "talk") return null;
  return meeting.host === speaker ? meeting.guest : meeting.guest === speaker ? meeting.host : null;
}
/** A neighbour who agreed to receive a visitor waits briefly at the promised
 * spot. The player-controlled hero keeps choosing his own actions until talk. */
export function forestSocialWaitingHost(state: ForestSocialState): Exclude<ForestSpeaker, "mochlik"> | null {
  const meeting = state.meeting;
  return meeting?.phase === "approach" && meeting.host !== "mochlik" ? meeting.host : null;
}
export function forestSocialFrames(state: ForestSocialState): ForestSpeechFrame[] {
  return state.current ? [{ ...state.current }] : [];
}
