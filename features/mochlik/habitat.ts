import { naturalItems, type GameItemId } from "@/features/game/game-rewards";
import { CONSUMED_PROGRESS, EAT_DURATION } from "./feeding";

import { HOUSE_ANCHORS } from "./home-layout";
import { FOREST_MAP } from "@/features/world/map-manifest";
import { homeToWorld, worldToHome, pointInPolygon } from "@/features/world/map-layout";

/** Screen-space choreography for a pixel 2D habitat. No account or game state. */
export type Point = { x: number; y: number };
export type Activity = "idle" | "walk" | "sniff" | "groom" | "look" | "crouch" | "jump"
  | "hide" | "peek" | "emerge" | "enter" | "sleep" | "stir" | "wake" | "leave" | "approach" | "greet" | "eat"
  | "watch" | "chase" | "pounce" | "balance" | "release"
  | "sneeze" | "scratch" | "yawn" | "shake" | "leaf-drift" | "pickup" | "toss" | "catch" | "carry" | "place"
  | "rain-notice" | "shelter" | "shelter-peek" | "wonder" | "discover" | "show" | "depart";
export type InsectKind = "butterfly" | "firefly";
export type Moment = "insects" | "leaf" | "find" | "rain" | "wonder" | "emotion";
export type PropKind = "leaf" | "cone" | "stone";
export type Layer = "clearing" | "bush" | "house";
export type Destination = "bush" | "home" | "mushrooms";
export type Mushroom = { id: number; position: Point; growth: number; growSeconds: number };
export const START = worldToHome(FOREST_MAP.clearing.spawn);
export const BUSH = worldToHome(FOREST_MAP.bush.inside);
export const BUSH_EDGE = worldToHome(FOREST_MAP.bush.approach);
export const DOORSTEP = HOUSE_ANCHORS.doorstep;
export const HOME = HOUSE_ANCHORS.inside;
export const FRONT = worldToHome(FOREST_MAP.clearing.front);
// The existing recessed doorway shelters Mochlik without another object over the lawn.
export const SHELTER = HOME;
export const LEAF_SPOT = { x: .46, y: .66 };
export const FIND_SPOT = { x: .60, y: .69 };
export const KEEPSAKE_SPOT = worldToHome(FOREST_MAP.clearing.keepsake);
export const depositedPosition = (kind: PropKind): Point => ({
  x: KEEPSAKE_SPOT.x + (kind === "leaf" ? -5 : 4) / 256, y: KEEPSAKE_SPOT.y + 2 / 256,
});
export const INACTIVITY_SECONDS = 60;
export const LONG_ABSENCE_SECONDS = 5 * 60;
export const MUSHROOM_PATCHES = [
  { x: .43, y: .65 }, { x: .62, y: .60 }, { x: .65, y: .73 },
];
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const smooth = (t: number) => t * t * (3 - 2 * t);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const sizeAt = (p: Point) => clamp(.17 + (p.y - .50) * .22, .15, .23);

type Segment = { activity: Activity; duration: number; to?: Point; size?: number; layer?: Layer };
export type HabitatState = {
  travel: "home" | "departing" | "away";
  position: Point; size: number; activity: Activity; activityTime: number; duration: number;
  elapsed: number; distance: number; layer: Layer; progress: number; lift: number;
  direction: "front" | "back" | "left" | "right"; lampOn: boolean; visiting: boolean;
  inactiveFor: number; resting: boolean; mushrooms: Mushroom[]; feedingId: number | null; eaten: number;
  wakeTaps: number; wakeTapsNeeded: number; playing: boolean; insectKind: InsectKind | null;
  insectPosition: Point; playTarget: Point;
  moment: Moment | null; prop: PropKind | null; propPosition: Point; propGround: Point;
  leafDelivered: boolean; keepsake: "cone" | "stone" | null; discoveries: number;
  ecologyTime: number; rain: number; gathering: number; decorLevel: number; decorItems: GameItemId[]; decorReveal: number;
};
// Finish these small actions before accepting a new route: no snapping out of foliage or doors.
const ATOMIC = new Set<Activity>(["crouch", "jump", "peek", "emerge", "enter", "leave", "wake", "eat", "pounce", "balance", "release",
  "sneeze", "shake", "pickup", "toss", "catch", "place", "show"]);

export function decorationLevel(bestStreakDays: number) {
  if (!Number.isSafeInteger(bestStreakDays) || bestStreakDays < 0) return 0;
  return [3, 7, 14, 30].filter(days => bestStreakDays >= days).length;
}
export const RAIN_PERIOD_SECONDS = 720;
export const RAIN_START_SECONDS = 180;
export const RAIN_END_SECONDS = 220;
export function rainAt(seconds: number) {
  const phase = ((seconds % RAIN_PERIOD_SECONDS) + RAIN_PERIOD_SECONDS) % RAIN_PERIOD_SECONDS;
  return phase < RAIN_START_SECONDS || phase >= RAIN_END_SECONDS ? 0
    : Math.min(1, (phase - RAIN_START_SECONDS) / 5, (RAIN_END_SECONDS - phase) / 7);
}
export function nextWeatherChange(seconds: number) {
  const phase = seconds % RAIN_PERIOD_SECONDS;
  return [RAIN_START_SECONDS, RAIN_START_SECONDS + 5, RAIN_END_SECONDS - 7, RAIN_END_SECONDS,
    RAIN_PERIOD_SECONDS + RAIN_START_SECONDS].find(at => at > phase + .001)! - phase;
}

export function createHabitat() {
  const state: HabitatState = { travel: "home", position: { ...START }, size: sizeAt(START), activity: "idle", activityTime: 0,
    duration: 4, elapsed: 0, distance: 0, layer: "clearing", progress: 0, lift: 0,
    direction: "front", lampOn: true, visiting: false, inactiveFor: 0, resting: false,
    mushrooms: MUSHROOM_PATCHES.map((position, id) => ({ id, position: { ...position }, growth: .12 - id * .04, growSeconds: 70 + id * 30 })),
    feedingId: null, eaten: 0, wakeTaps: 0, wakeTapsNeeded: 1, playing: false, insectKind: null,
    insectPosition: { x: .56, y: .50 }, playTarget: { x: .56, y: .64 },
    moment: null, prop: null, propPosition: { ...LEAF_SPOT }, propGround: { ...LEAF_SPOT },
    leafDelivered: false, keepsake: null, discoveries: 0, ecologyTime: 0, rain: 0, gathering: 0,
    decorLevel: 0, decorItems: [], decorReveal: 1 };
  let queue: Segment[] = [];
  let segment: Segment = { activity: "idle", duration: 4 };
  let origin = { ...START }, originSize = state.size;
  let destination: Destination | null = null;
  let requestedMushroom: number | null = null;
  let cycle = 0, visitPending = false, homePending = false, visitCooldown = 0, biteTaken = false;
  let playPending = false, playCycle = 0;
  let momentCycle = 0, emotionCycle = 0, findCycle = 0, nextGathering = 135, nextShelter = 0;
  let engaged = false, departurePending = false;
  let departureExit = { x: .80, y: .70 };

  function begin(next: Segment) {
    segment = next; origin = { ...state.position }; originSize = state.size;
    state.activity = next.activity; state.activityTime = 0; state.duration = next.duration; state.progress = 0; state.lift = 0;
    if (next.layer) state.layer = next.layer;
    if (next.activity === "eat") biteTaken = false;
    if (next.to) {
      const dx = next.to.x - origin.x, dy = next.to.y - origin.y;
      state.direction = next.activity === "approach" ? "front" : next.activity === "enter" ? "back"
        : Math.abs(dx) > Math.abs(dy) * 2.8 ? (dx < 0 ? "left" : "right") : dy < 0 ? "back" : "front";
    } else if (["idle", "look", "greet", "groom", "wake", "peek", "eat", "watch", "balance", "release",
      "sneeze", "scratch", "yawn", "shake", "pickup", "toss", "catch", "place", "shelter", "shelter-peek", "wonder", "discover", "show"].includes(next.activity)) state.direction = "front";
  }
  function plan(steps: Segment[]) { queue = steps; begin(queue.shift()!); }
  function walk(to: Point, from = state.position, activity: Activity = "walk"): Segment {
    return { activity, to, size: sizeAt(to), layer: "clearing", duration: Math.max(1.4, distance(from, to) / .047) };
  }
  function homeSteps(from = state.position): Segment[] {
    return [walk(DOORSTEP, from), { activity: "enter", to: HOME, size: .118, duration: 2.6, layer: "house" },
      { activity: "sleep", duration: 25, layer: "house" }];
  }
  function bushSteps(from = state.position): Segment[] {
    return [walk(BUSH_EDGE, from), { activity: "sniff", duration: 2.3, layer: "clearing" },
      { activity: "crouch", duration: .65 },
      { activity: "jump", to: BUSH, size: sizeAt(BUSH), duration: 1.15, layer: "bush" },
      { activity: "hide", duration: 4.5, layer: "bush" }, { activity: "peek", duration: 3, layer: "bush" },
      { activity: "hide", duration: 2, layer: "bush" },
      { activity: "emerge", to: BUSH_EDGE, size: sizeAt(BUSH_EDGE), duration: 1.35, layer: "bush" },
      { activity: "groom", duration: 4, layer: "clearing" }];
  }
  function leaveSteps(): Segment[] {
    if (state.layer === "house") return [{ activity: "wake", duration: 2.8, layer: "house" },
      { activity: "leave", to: DOORSTEP, size: sizeAt(DOORSTEP), duration: 2.6, layer: "house" }];
    if (state.layer === "bush") return [{ activity: "peek", duration: 1.1, layer: "bush" },
      { activity: "emerge", to: BUSH_EDGE, size: sizeAt(BUSH_EDGE), duration: 1.35, layer: "bush" }];
    return [];
  }
  const outside = () => state.layer === "house" ? DOORSTEP : state.layer === "bush" ? BUSH_EDGE : state.position;
  function clearMoment() { state.moment = null; state.prop = null; state.playing = false; }
  function startVisit() {
    const steps = leaveSteps(), from = outside();
    const waking = state.layer === "house";
    clearMoment();
    visitPending = false; homePending = false; destination = null; state.feedingId = null; state.visiting = true;
    plan([...steps, ...(waking ? [{ activity: "yawn" as const, duration: 2.4, layer: "clearing" as const },
      { activity: "shake" as const, duration: 1.4 }] : []), { activity: "look", duration: .8, layer: "clearing" }, walk(FRONT, from, "approach"),
      { activity: "greet", duration: 6, layer: "clearing" }]);
  }
  function goHome() {
    clearMoment();
    homePending = false; playPending = false; state.playing = false; state.feedingId = null;
    // If already inside, simply settle; do not walk through the stump exterior.
    if (state.layer === "house") { plan([{ activity: "sleep", duration: 25, layer: "house" }]); return; }
    plan([...leaveSteps(), ...homeSteps(outside())]);
  }
  function forage(preferredId: number | null = null) {
    const from = outside();
    const mushroom = state.mushrooms.filter(item => item.growth >= 1 && (preferredId === null || item.id === preferredId))
      .sort((a, b) => distance(from, a.position) - distance(from, b.position))[0];
    if (!mushroom) return false;
    state.feedingId = mushroom.id;
    const stop = { x: mushroom.position.x, y: mushroom.position.y - .018 };
    plan([...leaveSteps(), walk(stop, from), { activity: "sniff", duration: 1.5, layer: "clearing" },
      { activity: "eat", duration: EAT_DURATION }, { activity: "groom", duration: 2.5 }, { activity: "look", duration: 2 }]);
    return true;
  }
  function playInsects() {
    playPending = false; destination = null; state.feedingId = null; state.playing = true;
    state.moment = "insects";
    const target = playCycle++ % 2 === 0 ? { x: .56, y: .66 } : { x: .42, y: .67 };
    state.playTarget = target;
    const chase = walk(target, outside(), "chase"); chase.duration = Math.max(1.8, chase.duration * .62);
    plan([...leaveSteps(), { activity: "watch", duration: 1.3, layer: "clearing" }, chase,
      { activity: "crouch", duration: .45 }, { activity: "pounce", duration: 1.15 },
      { activity: "balance", duration: 3.6 },
      ...(state.insectKind === "butterfly" ? [{ activity: "sneeze" as const, duration: 1.25 }] : []),
      { activity: "release", duration: 2.1 },
      { activity: "groom", duration: 1.8 }]);
  }
  function startMoment(kind: Exclude<Moment, "insects">) {
    const steps = leaveSteps(), from = outside();
    playPending = false; destination = null; state.feedingId = null; state.playing = true; state.moment = kind; state.prop = null;
    if (kind === "leaf" || kind === "find") {
      state.prop = kind === "leaf" ? "leaf" : findCycle++ % 2 === 0 ? "cone" : "stone";
      state.propGround = { ...(kind === "leaf" ? LEAF_SPOT : FIND_SPOT) };
      state.propPosition = { ...state.propGround };
      const destination = kind === "leaf" ? DOORSTEP : FRONT;
      plan([...steps, { activity: kind === "leaf" ? "leaf-drift" : "discover", duration: kind === "leaf" ? 2.7 : 1.6, layer: "clearing" },
        walk(state.propGround, from), { activity: "sniff", duration: 1.3 }, { activity: "pickup", duration: 1.25 },
        ...(kind === "leaf" ? [{ activity: "toss" as const, duration: 1.65 }, { activity: "catch" as const, duration: .8 },
          { activity: "toss" as const, duration: 1.8 }, { activity: "catch" as const, duration: .8 }] : []),
        walk(destination, state.propGround, "carry"),
        ...(kind === "find" ? [{ activity: "show" as const, duration: 4 }, walk(DOORSTEP, FRONT, "carry")] : []),
        { activity: "place", duration: 1.4 }, { activity: "greet", duration: 1.8 }]);
    } else if (kind === "rain") {
      nextShelter = state.ecologyTime + 90;
      const shelterWalk = walk(DOORSTEP, from); shelterWalk.duration *= .65;
      const inside = state.layer === "house";
      plan([...(inside ? [] : steps), { activity: "rain-notice", duration: 1.2, layer: inside ? "house" : "clearing" },
        ...(inside ? [] : [shelterWalk, { activity: "enter" as const, to: SHELTER, size: .118, duration: 2.6, layer: "house" as const }]),
        { activity: "shelter", duration: 6, layer: "house" }, { activity: "shelter-peek", duration: 2.4, layer: "house" },
        { activity: "shelter", duration: 4, layer: "house" }, { activity: "shelter-peek", duration: 2.4, layer: "house" },
        { activity: "leave", to: DOORSTEP, size: sizeAt(DOORSTEP), duration: 2.6, layer: "house" },
        walk(START, DOORSTEP), { activity: "shake", duration: 1.5 }, { activity: "scratch", duration: 2.2 }]);
    } else if (kind === "wonder") {
      nextGathering = state.elapsed + 180;
      plan([...steps, walk(START, from), { activity: "wonder", duration: 10, layer: "clearing" },
        { activity: "greet", duration: 2 }, { activity: "look", duration: 2 }]);
    } else {
      const emotion = (["scratch", "yawn", "shake"] as const)[emotionCycle++ % 3];
      plan([...steps, { activity: "look", duration: 1, layer: "clearing" }, { activity: emotion, duration: 2.4 },
        { activity: "groom", duration: 1.8 }, { activity: "idle", duration: 2.5 }]);
    }
  }
  function play() {
    if (state.rain > .15 && state.ecologyTime >= nextShelter) { startMoment("rain"); return; }
    if (state.insectKind === "firefly" && state.elapsed >= nextGathering && state.rain < .1) { startMoment("wonder"); return; }
    switch (momentCycle++ % 5) {
      case 1: startMoment("leaf"); break;
      case 2: startMoment("find"); break;
      case 3: startMoment("emotion"); break;
      default: playInsects();
    }
  }
  function leaveRain() {
    const inside = state.layer === "house";
    plan([...(inside ? [{ activity: "leave" as const, to: DOORSTEP, size: sizeAt(DOORSTEP), duration: 2.6, layer: "house" as const }] : []),
      walk(START, inside ? DOORSTEP : state.position), { activity: "shake", duration: 1.5 }, { activity: "scratch", duration: 2.2 }]);
  }
  function routine() {
    if (state.layer === "house") { plan([...leaveSteps(), walk(START, DOORSTEP), { activity: "sniff", duration: 4 }]); return; }
    if (state.layer === "bush") { plan([...leaveSteps(), { activity: "groom", duration: 4, layer: "clearing" }]); return; }
    if (state.insectKind && state.rain > .15 && state.ecologyTime >= nextShelter) { startMoment("rain"); return; }
    if (state.insectKind === "firefly" && state.elapsed >= nextGathering && state.rain < .1) { startMoment("wonder"); return; }
    // Alternate play with the older routines, including foraging as mushrooms mature.
    if (state.insectKind && cycle % 2 === 1) { cycle++; play(); return; }
    if (forage()) { cycle++; return; }
    switch (cycle++ % 3) {
      case 0: plan(bushSteps()); break;
      case 1:
        plan([walk({ x: .56, y: .64 }), { activity: "sniff", duration: 4 }, { activity: "look", duration: 3 },
          { activity: "groom", duration: 4 }, { activity: "idle", duration: 3 }]); break;
      default: plan([walk(START), { activity: "look", duration: 4 }, { activity: "idle", duration: 4 }]);
    }
  }
  function finish() {
    if (segment.to) state.position = { ...segment.to };
    if (segment.size !== undefined) state.size = segment.size;
    if (state.activity === "leave" || state.activity === "emerge") state.layer = "clearing";
    if (state.activity === "eat") state.feedingId = null;
    if (state.activity === "place" && state.prop) {
      if (state.prop === "leaf") state.leafDelivered = true;
      else { state.keepsake = state.prop; state.discoveries++; }
      state.prop = null;
    }
    state.lift = 0;
    if (state.activity === "depart") { state.travel = "away"; queue = []; return; }
    if (departurePending) { startDeparture(); return; }
    if (state.travel === "departing") { if (queue.length) begin(queue.shift()!); return; }
    if (visitPending && !state.visiting) { startVisit(); return; }
    if (playPending && !state.playing) { play(); return; }
    if (destination && !state.visiting) { startDestination(); return; }
    if (homePending && !state.visiting && !(state.playing && state.prop)) { goHome(); return; }
    if (state.moment === "rain" && state.rain < .01 && (["shelter", "shelter-peek"].includes(state.activity)
      || queue[0]?.activity === "shelter")) { leaveRain(); return; }
    if (queue.length) { begin(queue.shift()!); return; }
    if (state.playing) { clearMoment(); visitCooldown = state.elapsed + 8; }
    if (state.visiting) { state.visiting = false; visitCooldown = state.elapsed + 12; }
    if (state.resting) { goHome(); return; }
    routine();
  }
  function startDestination() {
    const place = destination, mushroomId = requestedMushroom; destination = null; requestedMushroom = null; homePending = false; state.feedingId = null;
    if (place === "home") { state.resting = true; goHome(); return; }
    if (place === "mushrooms") { if (!forage(mushroomId)) routine(); return; }
    plan([...leaveSteps(), ...bushSteps(outside())]);
  }
  function activate() {
    state.inactiveFor = 0; state.resting = false; homePending = false;
  }
  function invite(place: Destination, mushroomId?: number) {
    if (state.visiting || visitPending || state.playing || playPending || destination || ATOMIC.has(state.activity)) return false;
    if (place === "bush" && state.layer === "bush" || place === "home" && state.layer === "house") return false;
    if (place === "mushrooms" && !state.mushrooms.some(item => item.growth >= 1 && (mushroomId === undefined || item.id === mushroomId))) return false;
    activate(); destination = place; requestedMushroom = mushroomId ?? null; return true;
  }
  let away = false;
  function startDeparture() {
    const steps = leaveSteps(), from = outside();
    clearMoment(); departurePending = false; state.feedingId = null;
    const exit = walk(departureExit, from, "depart"); exit.duration = Math.max(2.8, exit.duration * .65);
    plan([...steps, { activity: "greet", duration: 1.15, layer: "clearing" }, exit]);
  }
  function setAway(value: boolean, animate = true, river = false, stageAtHome = false) {
    if (value === away) {
      if (value && !animate && state.travel === "departing") {
        clearMoment(); queue = []; departurePending = false; state.travel = "away";
      }
      return;
    }
    const wasAway = state.travel === "away";
    away = value; visitPending = false; playPending = false; homePending = false; destination = null;
    state.visiting = false; state.gathering = 0; state.wakeTapsNeeded = 1; state.wakeTaps = 0;
    state.resting = false; state.inactiveFor = 0;
    if (value) departureExit = stageAtHome ? { ...START } : river ? { x: .80, y: .53 } : { x: .80, y: .73 };
    if (value) {
      state.travel = animate ? "departing" : "away";
      if (!animate) { clearMoment(); queue = []; departurePending = false; }
      else if (ATOMIC.has(state.activity)) departurePending = true;
      else startDeparture();
    } else {
      if (!animate) {
        clearMoment(); departurePending = false; state.travel = "home";
        state.position = { ...START }; state.size = sizeAt(START); state.layer = "clearing"; state.lift = 0;
        plan([{ activity: "greet", duration: 4, layer: "clearing" }]); return;
      }
      if (!wasAway && ATOMIC.has(state.activity)) { departurePending = false; state.travel = "home"; visitPending = true; return; }
      clearMoment(); departurePending = false; state.travel = "home";
      if (wasAway) { state.position = { ...departureExit }; state.size = sizeAt(state.position); state.layer = "clearing"; }
      plan([...leaveSteps(), walk(START, outside()), { activity: "greet", duration: 4, layer: "clearing" }]);
    }
  }
  function setEngaged(value: boolean) {
    if (engaged === value) return;
    engaged = value;
    if (!value || away) return;
    const waking = state.resting || ["sleep", "stir", "enter"].includes(state.activity);
    activate();
    if (waking) { state.wakeTapsNeeded = 1; state.wakeTaps = 0; visitPending = true; }
  }
  function moveTo(target: Point) {
    if (away || ATOMIC.has(state.activity)) return false;
    // Ground controls stay within the familiar walkable clearing, away from door/bush masks.
    if (!pointInPolygon(homeToWorld(target), FOREST_MAP.clearing.walkable)) return false;
    activate(); clearMoment(); visitPending = false; playPending = false; destination = null;
    state.visiting = false; state.feedingId = null;
    plan([...leaveSteps(), walk(target, outside()), { activity: "look", duration: 2, layer: "clearing" }]);
    return true;
  }
  function notice() {
    if (away) return false;
    const waking = state.resting || state.activity === "sleep";
    if (waking && state.wakeTapsNeeded > 1) {
      state.wakeTaps = Math.min(state.wakeTapsNeeded, state.wakeTaps + 1);
      if (state.wakeTaps < state.wakeTapsNeeded) {
        state.inactiveFor = 0;
        plan([{ activity: "stir", duration: 1.3, layer: "house" }, { activity: "sleep", duration: 25, layer: "house" }]);
        return true;
      }
      state.wakeTapsNeeded = 1; state.wakeTaps = 0;
    }
    // Every accepted button tap means activity, even when the current visit is coalesced.
    activate();
    if (state.visiting || visitPending || state.playing || playPending || state.elapsed < visitCooldown && !waking) return false;
    if (state.insectKind && !waking) { playPending = true; return true; }
    visitPending = true; return true;
  }
  // Ambient light is decorative. Day/night never overrides user activity or sleep.
  function setLamp(on: boolean) { state.lampOn = on; }
  function setInsects(kind: InsectKind) { state.insectKind = kind; state.rain = rainAt(state.ecologyTime); }
  function setDecor(bestStreakDays: number, owned: readonly GameItemId[] = []) {
    const next = [...new Set([...state.decorItems, ...naturalItems(bestStreakDays), ...owned])];
    if (next.length > state.decorItems.length) state.decorReveal = 0;
    state.decorItems = next;
    state.decorLevel = Math.max(state.decorLevel, decorationLevel(bestStreakDays));
  }
  /** Re-enter a resting scene before its first visible frame, discarding unfinished routes. */
  function restAfterAbsence(deep = true) {
    clearMoment(); state.gathering = 0;
    queue = []; visitPending = false; playPending = false; homePending = false; destination = null;
    requestedMushroom = null; state.visiting = false; state.playing = false; state.feedingId = null;
    state.resting = true; state.wakeTaps = 0; state.wakeTapsNeeded = deep ? 3 : 1;
    state.position = { ...HOME }; state.size = .118;
    begin({ activity: "sleep", duration: 25, layer: "house" });
  }
  /** Age only the local ecology and inactivity clock; never fast-forward a movement. */
  function elapse(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    state.inactiveFor = engaged ? 0 : state.inactiveFor + seconds;
    state.ecologyTime += seconds; state.rain = state.insectKind ? rainAt(state.ecologyTime) : 0;
    for (const mushroom of state.mushrooms) {
      if (state.feedingId !== mushroom.id) mushroom.growth = Math.min(1, mushroom.growth + seconds / mushroom.growSeconds);
    }
    if (!away && state.inactiveFor >= INACTIVITY_SECONDS && !state.resting) {
      state.resting = true; homePending = true; destination = null;
    }
  }
  function update(seconds: number, age = true) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const dt = Math.min(seconds, .05);
    state.elapsed += dt; if (age) elapse(dt);
    if (away && state.travel !== "departing") return;
    if (visitPending && !state.visiting && !ATOMIC.has(state.activity)) { startVisit(); }
    else if (playPending && !state.playing && !ATOMIC.has(state.activity)) play();
    else if (destination && !state.visiting && !visitPending && !ATOMIC.has(state.activity)) startDestination();
    else if (homePending && !state.visiting && !visitPending && !(state.playing && state.prop) && !ATOMIC.has(state.activity)) goHome();
    else if (state.moment === "rain" && state.rain < .01 && state.activity === "shelter") leaveRain();
    state.activityTime = Math.min(state.duration, state.activityTime + dt);
    state.progress = clamp(state.activityTime / state.duration, 0, 1);
    if (segment.to) {
      const p = smooth(state.progress), previous = state.position;
      state.position = { x: origin.x + (segment.to.x - origin.x) * p, y: origin.y + (segment.to.y - origin.y) * p };
      state.distance += distance(previous, state.position);
    }
    state.size = originSize + ((segment.size ?? originSize) - originSize) * smooth(state.progress);
    state.lift = ["jump", "emerge", "pounce"].includes(state.activity) ? Math.sin(Math.PI * state.progress) * .066 : 0;
    state.decorReveal = Math.min(1, state.decorReveal + dt / 2);
    const gatheringTarget = state.moment === "wonder" && state.activity === "wonder" && state.insectKind === "firefly" ? 1 : 0;
    state.gathering += (gatheringTarget - state.gathering) * Math.min(1, dt * 1.4);
    const perched = state.moment === "insects" && ["pounce", "balance"].includes(state.activity);
    const focus = perched ? { x: state.position.x + (state.insectKind === "firefly" ? Math.sin(state.elapsed * 2) * .018 : 0),
      y: state.position.y - state.size * (state.insectKind === "firefly" ? .48 : .87) - state.lift }
      : state.moment === "insects" ? { x: state.playTarget.x + .025 * Math.sin(state.elapsed * 2), y: state.playTarget.y - .13 }
        : { x: .53 + .14 * Math.sin(state.elapsed * .43), y: .53 + .045 * Math.cos(state.elapsed * .63) };
    const blend = Math.min(1, dt * (perched ? 8 : 2));
    state.insectPosition = { x: state.insectPosition.x + (focus.x - state.insectPosition.x) * blend,
      y: state.insectPosition.y + (focus.y - state.insectPosition.y) * blend };
    if (state.prop) {
      const a = state.activity, p = smooth(state.progress);
      const hand = { x: state.position.x, y: state.position.y - state.size * (a === "show" ? .58 : .33) };
      if (a === "leaf-drift") state.propPosition = { x: LEAF_SPOT.x - .19 * (1 - p) + Math.sin(p * Math.PI * 4) * .026,
        y: LEAF_SPOT.y - .21 * (1 - p) };
      else if (a === "pickup") state.propPosition = { x: state.propGround.x + (hand.x - state.propGround.x) * p,
        y: state.propGround.y + (hand.y - state.propGround.y) * p };
      else if (a === "toss") state.propPosition = { x: hand.x + Math.sin(Math.PI * state.progress * 2) * .022,
        y: hand.y - Math.sin(Math.PI * state.progress) * .15 };
      else if (a === "place") {
        const target = depositedPosition(state.prop);
        state.propPosition = { x: hand.x + (target.x - hand.x) * p, y: hand.y + (target.y - hand.y) * p };
      }
      else if (["carry", "catch", "show"].includes(a)) {
        const blend = Math.min(1, dt * 12);
        state.propPosition = { x: state.propPosition.x + (hand.x - state.propPosition.x) * blend,
          y: state.propPosition.y + (hand.y - state.propPosition.y) * blend };
      } else state.propPosition = { ...state.propGround };
    }
    if (state.activity === "eat" && state.progress >= CONSUMED_PROGRESS && !biteTaken) {
      const mushroom = state.mushrooms.find(item => item.id === state.feedingId);
      if (mushroom) { mushroom.growth = 0; state.eaten++; }
      biteTaken = true;
    }
    if (state.activityTime >= state.duration) finish();
  }
  /** Reduced motion: explicit controls change a still scene without animation frames. */
  function settle() {
    if (away) { state.travel = "away"; departurePending = false; queue = []; return; }
    visitCooldown = 0;
    state.decorReveal = 1; state.gathering = 0;
    if (playPending && !state.resting) play();
    if (state.moment && state.moment !== "insects") {
      const kind = state.moment;
      if (!state.resting && state.prop) {
        if (state.prop === "leaf") state.leafDelivered = true;
        else { state.keepsake = state.prop; state.discoveries++; }
      }
      clearMoment(); queue = [];
      state.position = { ...(kind === "rain" ? SHELTER : START) }; state.size = kind === "rain" ? .118 : sizeAt(state.position);
      begin({ activity: kind === "rain" ? "shelter" : kind === "emotion" ? "scratch" : "greet", duration: 4, layer: kind === "rain" ? "house" : "clearing" });
    }
    if (playPending || state.playing) {
      playPending = false; clearMoment(); queue = []; state.feedingId = null;
      state.position = { ...START }; state.size = sizeAt(START);
      state.insectPosition = { x: START.x, y: START.y - state.size * .87 };
      begin({ activity: "balance", duration: 4, layer: "clearing" });
    }
    if (visitPending || state.visiting) {
      visitPending = false; homePending = false; destination = null; queue = []; state.visiting = false; state.feedingId = null;
      state.position = { ...FRONT }; state.size = sizeAt(FRONT);
      begin({ activity: "greet", duration: 6, layer: "clearing" });
    } else if (destination && !state.visiting) {
      const place = destination, mushroomId = requestedMushroom; destination = null; requestedMushroom = null; homePending = false; queue = []; state.feedingId = null;
      if (place === "mushrooms") {
        const mushroom = state.mushrooms.find(item => item.growth >= 1 && (mushroomId === null || item.id === mushroomId));
        if (mushroom) {
          state.position = { x: mushroom.position.x, y: mushroom.position.y - .018 };
          state.size = sizeAt(state.position); mushroom.growth = 0; state.eaten++;
          begin({ activity: "groom", duration: 4, layer: "clearing" });
        }
      } else {
        state.resting = place === "home";
        state.position = { ...(place === "home" ? HOME : BUSH) }; state.size = place === "home" ? .118 : sizeAt(BUSH);
        begin({ activity: place === "home" ? "sleep" : "peek", duration: 25, layer: place === "home" ? "house" : "bush" });
        if (place === "bush") state.progress = .5;
      }
    } else if (state.resting && !state.visiting) {
      clearMoment(); homePending = false; queue = []; state.feedingId = null; state.position = { ...HOME }; state.size = .118;
      begin({ activity: "sleep", duration: 25, layer: "house" });

    }
  }
  return { state, notice, invite, moveTo, update, elapse, setLamp, setInsects, setDecor, setAway, setEngaged, restAfterAbsence, settle };
}
