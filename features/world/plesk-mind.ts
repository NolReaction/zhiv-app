import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { FISHING_PACK_RELEASE, type FishingMotion } from "./fishing-props";
import type { ForestTrail } from "./forest-trails";
import { canTraverse, isWalkable } from "./navigation";
import { PLESK, measurePleskTrail, pleskLocalPlaces, pleskTravelTime, reversePleskTrail, samplePleskTrail,
  type PleskAction, type PleskPlaces, type PleskResidentFrame, type PleskStop } from "./plesk-resident";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type PleskIntent = "fish" | "trade" | "rest" | "look" | "greet" | "tackle";
export type PleskNeeds = { energy: number; patience: number; social: number };
export type PleskEnvironment = { rain: number; dusk: number; playerNear?: boolean };
export type PleskObservation = {
  action: PleskAction; intent: PleskIntent; reason: string; needs: PleskNeeds;
  catchCount: number; destinationId: string; decisions: number;
};
type MindStage = FishingMotion & { action: PleskAction; duration: number; target: PleskStop;
  direction?: PixelDirection; trail?: ForestTrail; caught?: boolean; deposit?: boolean; sell?: boolean };
export type PleskMind = {
  elapsed: number; position: WorldPoint; stopId: string; needs: PleskNeeds; catchCount: number;
  intent: PleskIntent; reason: string; decisions: number; recent: PleskIntent[]; seed: number;
  stage: MindStage; age: number; queue: MindStage[]; noticePending: boolean; greetAfter: number;
  scene: FixedWorldScene; available: boolean; observation: PleskObservation;
};
export const PLESK_MIND_LIMITS = { maxDelta: 1, transitions: 8, recent: 6, basket: 3 } as const;
const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
function random(mind: PleskMind) { mind.seed = (Math.imul(mind.seed, 1664525) + 1013904223) >>> 0; return mind.seed / 4294967296; }
function observe(mind: PleskMind) {
  mind.observation = { action: mind.stage.action, intent: mind.intent, reason: mind.reason, needs: { ...mind.needs },
    catchCount: mind.catchCount, destinationId: mind.stage.target.id, decisions: mind.decisions };
}

/** Transient resident needs and caught props belong to this one live session.
 * There is no offline advancement, economic inventory or independent timer. */
export function createPleskMind(scene: FixedWorldScene, seed = 0x706c6573): PleskMind | null {
  const places = pleskLocalPlaces(scene); if (!places) return null;
  const mind: PleskMind = { elapsed: 0, position: { ...places.base.position }, stopId: places.base.id,
    needs: { energy: .88, patience: .9, social: .25 }, catchCount: 0, intent: "look", reason: "Осматривает свой пирс перед рыбалкой.",
    decisions: 0, recent: [], seed: Number.isFinite(seed) ? seed >>> 0 : 0x706c6573,
    stage: { action: "idle", duration: 1, target: places.base }, age: 0, queue: [], noticePending: false, greetAfter: 0,
    scene, available: true, observation: {} as PleskObservation };
  observe(mind); return mind;
}

function routeBetween(places: PleskPlaces, from: string, target: PleskStop): ForestTrail | undefined {
  if (from === target.id) return;
  const { base, trade, rest, toTrade, toRest, tradeToRest } = places;
  if (from === base.id) return target.id === trade?.id ? toTrade : target.id === rest?.id ? toRest : undefined;
  if (target.id === base.id) return from === trade?.id && toTrade ? reversePleskTrail(toTrade)
    : from === rest?.id && toRest ? reversePleskTrail(toRest) : undefined;
  if (from === trade?.id && target.id === rest?.id) {
    if (tradeToRest) return tradeToRest;
    if (toTrade && toRest) return measurePleskTrail([...toTrade.points].reverse().concat(toRest.points.slice(1)));
  }
  if (from === rest?.id && target.id === trade?.id) {
    if (tradeToRest) return reversePleskTrail(tradeToRest);
    if (toRest && toTrade) return measurePleskTrail([...toRest.points].reverse().concat(toTrade.points.slice(1)));
  }
}

function selectIntent(mind: PleskMind, places: PleskPlaces, env: PleskEnvironment): { intent: PleskIntent; reason: string } {
  const { energy, patience, social } = mind.needs;
  const candidates: { intent: PleskIntent; score: number; reason: string }[] = [
    { intent: "rest", score: (1 - energy) * 2.4 + env.rain * 1.1 + env.dusk * .65 + (energy < .22 ? 4 : 0),
      reason: env.rain > .6 ? "Дождь усилился — откладывает удочку и отдыхает у пирса." : env.dusk > .7 ? "Стемнело — решила немного передохнуть." : "Устала — пора восстановить силы." },
    { intent: "look", score: (1 - patience) * 1.1 + .12, reason: "Клёв не радует — осматривается и набирается терпения." },
    { intent: "tackle", score: (1 - patience) * .75 + .16, reason: "Проверяет снасти перед следующим забросом." },
  ];
  if (places.waterTarget && energy > .18 && env.rain < .82 && mind.catchCount < PLESK_MIND_LIMITS.basket) candidates.push({ intent: "fish",
    score: .55 + energy * .6 + patience * .45 - env.rain * .5 - env.dusk * .55,
    reason: "Отдохнула, снасти готовы — можно попробовать поймать ещё рыбу." });
  if (places.trade && mind.catchCount > 0) candidates.push({ intent: "trade",
    score: mind.catchCount * .55 + social * .55 + (mind.catchCount >= PLESK_MIND_LIMITS.basket ? 2 : 0),
    reason: mind.catchCount >= 2 ? "Набрался улов — несёт корзинку к своему торговому месту." : "Хочется пообщаться — покажет свежий улов у пирса." });
  if ((mind.noticePending || env.playerNear) && mind.elapsed >= mind.greetAfter) candidates.push({ intent: "greet",
    score: mind.noticePending ? 8 : .3 + social * 1.6, reason: "Заметила гостя — здоровается." });
  for (const item of candidates) {
    item.score += random(mind) * .18;
    item.score -= mind.recent.slice(-3).filter(action => action === item.intent).length * .18;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function decide(mind: PleskMind, places: PleskPlaces, env: PleskEnvironment) {
  const choice = selectIntent(mind, places, env);
  mind.intent = choice.intent; mind.reason = choice.reason; mind.decisions++;
  mind.recent.push(choice.intent); if (mind.recent.length > PLESK_MIND_LIMITS.recent) mind.recent.shift();
  const current = [places.base, places.trade, places.rest].find(stop => stop?.id === mind.stopId) ?? places.base;
  const target = choice.intent === "fish" ? places.base : choice.intent === "trade" ? places.trade!
    : choice.intent === "rest" || choice.intent === "tackle" ? places.rest ?? places.base : current;
  const stages: MindStage[] = [];
  const trail = routeBetween(places, mind.stopId, target);
  if (trail) stages.push({ action: "walk", duration: pleskTravelTime(trail), target, trail });
  const add = (action: PleskAction, duration: number, extra: Partial<MindStage> = {}) => stages.push({ action, duration, target, ...extra });
  if (choice.intent === "fish") {
    const draw = random(mind), outcome = draw < .19 ? "miss" : draw > .79 ? "large" : "small";
    const motion: FishingMotion = { outcome, catchScale: outcome === "large" ? 1.35 : 1 };
    add("pack", 1.5); add("cast", 1.8, motion);
    add("fish", 9 + random(mind) * 12 + (1 - mind.needs.patience) * 3, { ...motion, variation: random(mind) < .5 ? "check" : "calm" });
    add("bite", 1.1 + random(mind) * .5, { ...motion, variation: "nibble" });
    add("reel", outcome === "large" ? 4 : 2.8, { ...motion, variation: outcome === "miss" ? "escape" : "struggle" });
    if (outcome !== "miss") { add("catch", 3, { ...motion, caught: true }); add("pack", 2.8, { ...motion, caught: true, deposit: true }); }
    else add("idle", 2, { ...motion, variation: "escape" });
  } else if (choice.intent === "trade") {
    add("greet", 2.5, { direction: "front" }); add("trade", 12 + random(mind) * 10, { direction: "front", sell: true });
    add("pack", 2, { direction: "front" });
  } else if (choice.intent === "rest") add("rest", 10 + (1 - mind.needs.energy) * 22 + random(mind) * 5, { direction: "front" });
  else if (choice.intent === "tackle") { add("pack", 3, { direction: "front" }); add("idle", 3 + random(mind) * 3, { direction: "left" }); }
  else if (choice.intent === "greet") {
    mind.noticePending = false; mind.greetAfter = mind.elapsed + 25; add("greet", 2.5, { direction: "front" });
  } else add("idle", 4 + random(mind) * 5, { direction: random(mind) < .5 ? "left" : "back" });
  mind.queue = stages; startNext(mind);
}

function startNext(mind: PleskMind) { mind.stage = mind.queue.shift()!; mind.age = 0; }
function finishStage(mind: PleskMind) {
  const stage = mind.stage;
  if (stage.trail) { mind.position = { ...stage.target.position }; mind.stopId = stage.target.id; }
  if (stage.deposit) { mind.catchCount = Math.min(PLESK_MIND_LIMITS.basket, mind.catchCount + 1); mind.needs.patience = clamp(mind.needs.patience + .25); }
  if (stage.sell) { mind.catchCount = 0; mind.needs.social = clamp(mind.needs.social - .65); }
  if (stage.action === "greet") mind.needs.social = clamp(mind.needs.social - .5);
  if (stage.action === "idle" && stage.outcome === "miss") mind.needs.patience = clamp(mind.needs.patience - .15);
}

/** Validate changed building/DEV geometry once; edits cannot move feet or let an
 * already planned path cross a new wall. A fresh session adopts moved markers. */
function acceptScene(mind: PleskMind, scene: FixedWorldScene, places: PleskPlaces) {
  if (mind.scene === scene && mind.available) return true;
  mind.scene = scene;
  const targets = [places.base, places.trade, places.rest];
  mind.available = isWalkable(places.nav, mind.position) && [mind.stage, ...mind.queue].every(stage => {
    const target = targets.find(stop => stop?.id === stage.target.id);
    return target && Math.hypot(target.position.x - stage.target.position.x, target.position.y - stage.target.position.y) < .01
      && (!stage.trail || stage.trail.points.every((point, index, points) => index === 0 || canTraverse(places.nav, points[index - 1], point)));
  });
  if (!mind.available) mind.reason = "Личное место изменилось: ждёт безопасной разметки.";
  return mind.available;
}

export function noticePleskMind(mind: PleskMind | null): void { if (mind) mind.noticePending = true; }

export function advancePleskMind(mind: PleskMind | null, scene: FixedWorldScene, dt: number, environment: PleskEnvironment): void {
  if (!mind || !Number.isFinite(dt) || dt <= 0) return;
  const places = pleskLocalPlaces(scene);
  if (!places) { mind.available = false; mind.reason = "Личный пирс недоступен — ждёт безопасной разметки."; observe(mind); return; }
  if (!acceptScene(mind, scene, places)) { observe(mind); return; }
  const env = { rain: clamp(environment.rain), dusk: clamp(environment.dusk), playerNear: Boolean(environment.playerNear) };
  if (mind.stage.action === "fish" && mind.age > 1 && (env.rain > .82 || mind.noticePending && mind.elapsed >= mind.greetAfter)) {
    mind.reason = env.rain > .82 ? "Начался сильный дождь — аккуратно сматывает леску." : "Гость позвал — сматывает леску, чтобы ответить.";
    mind.queue = [{ action: "reel", duration: 1.4, target: mind.stage.target, outcome: "miss", variation: "escape" },
      { action: "pack", duration: 1.5, target: mind.stage.target }];
    startNext(mind);
  } else if (mind.noticePending && mind.elapsed >= mind.greetAfter && ["idle", "rest", "trade"].includes(mind.stage.action)) {
    // Complete the paused harmless activity after greeting; catches and walking
    // are never interrupted mid-transfer or between navigation points.
    mind.queue.unshift({ ...mind.stage, duration: Math.max(.1, mind.stage.duration - mind.age) });
    mind.stage = { action: "greet", duration: 2.5, target: mind.stage.target, direction: "front" };
    mind.age = 0; mind.noticePending = false; mind.greetAfter = mind.elapsed + 25;
    mind.reason = "Заметила гостя — здоровается.";
  }
  let remaining = Math.min(PLESK_MIND_LIMITS.maxDelta, dt);
  for (let transitions = 0; remaining > 1e-8 && transitions < PLESK_MIND_LIMITS.transitions; transitions++) {
    const slice = Math.min(remaining, Math.max(0, mind.stage.duration - mind.age)), action = mind.stage.action;
    mind.age += slice; mind.elapsed += slice; remaining -= slice;
    mind.needs.energy = clamp(mind.needs.energy + slice * (action === "rest" ? .018 : action === "walk" ? -.0035 : -.0014));
    mind.needs.patience = clamp(mind.needs.patience + slice * (action === "fish" ? -.008 : ["idle", "rest", "pack"].includes(action) ? .013 : -.001));
    mind.needs.social = clamp(mind.needs.social + slice * (action === "trade" || action === "greet" ? -.016 : .002));
    if (mind.stage.trail) { const point = samplePleskTrail(mind.stage.trail, mind.age); mind.position = { x: point.x, y: point.y }; }
    if (mind.age >= mind.stage.duration - 1e-8) {
      finishStage(mind);
      if (mind.queue.length) startNext(mind); else decide(mind, places, env);
    }
  }
  observe(mind);
}

/** Rendering is read-only. Reduced motion freezes the current real feet rather
 * than moving a walking resident back to her original fishing marker. */
export function pleskMindFrame(mind: PleskMind | null, scene: FixedWorldScene, still: boolean): PleskResidentFrame | null {
  const places = pleskLocalPlaces(scene);
  if (!mind || !mind.available || !places || mind.scene !== scene && !isWalkable(places.nav, mind.position)) return null;
  const stage = mind.stage, phase = still ? .5 : clamp(mind.age / stage.duration);
  const walk = stage.trail ? samplePleskTrail(stage.trail, mind.age) : undefined;
  const direction = walk?.direction ?? stage.direction ?? (stage.target.id === places.base.id ? places.direction : "front");
  return { id: "plesk", ...mind.position, size: PLESK.size, direction, action: stage.action, phase,
    frame: still ? 0 : walk?.frame ?? Math.floor(mind.age * 8) % 32,
    destinationId: stage.target.id, carryingFish: mind.catchCount > 0 || Boolean(stage.caught),
    basketFilled: mind.catchCount > 0 || Boolean(stage.deposit && phase >= FISHING_PACK_RELEASE),
    ...(stage.variation ? { variation: stage.variation } : {}), ...(stage.outcome ? { outcome: stage.outcome } : {}),
    ...(stage.catchScale ? { catchScale: stage.catchScale } : {}),
    ...(places.waterTarget && stage.target.id === places.base.id && !stage.trail ? { waterTarget: { ...places.waterTarget } } : {}) };
}
