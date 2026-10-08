import type { AudioFrame, AudioListenerFrame, AudioLoopTarget, AudioPoint, AudioSourceDebug } from "@/features/audio/domain/types";
import { clamp01, dbToGain, distanceGain, stereoPan, zoneGain } from "@/features/audio/domain/spatial";
import { profileCues } from "@/features/audio/catalog/catalog";
import type { FixedWorldScene, WorldAudioEmitter, WorldPoint } from "@/features/world/tiled/types";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";
import { constructionMapPlace } from "@/features/world/scene/construction-map-anchor";
import type { EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { ForestSessionState } from "@/features/world/state/forest-session";

export type WorldAudioCamera = { x: number; y: number; zoom: number; viewportWidth: number };
export type WorldAudioEnvironment = {
  ownerId: string; sceneId: string; ownerPublicId?: string; now: number; dusk: number; rain: number;
  camera?: WorldAudioCamera; levels: Readonly<Record<string, number>>;
  production?: EconomySceneProduction | null; construction?: EconomySceneConstruction | null;
  quarryWorking?: boolean;
  fires: readonly { id: string; position: WorldPoint; lit: boolean; flame: number }[];
  showBuildings?: boolean;
};

/** Logical map coordinates, independent of backing-pixel ratio and screen size. */
export function worldAudioListener(scene: FixedWorldScene, camera?: WorldAudioCamera): AudioListenerFrame {
  const width = camera && Number.isFinite(camera.viewportWidth) && camera.viewportWidth > 0 ? camera.viewportWidth : 350;
  const zoom = camera && Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : width / scene.focus.width;
  const logicalWidth = width / zoom;
  return { position: camera ? { x: camera.x, y: camera.y }
    : { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + scene.focus.height / 2 },
    viewportWidth: logicalWidth, zoom,
    // Far overview keeps the forest bed while reducing tiny sources and feet.
    detail: clamp01((scene.focus.width * 2.5 / logicalWidth - .45) / 1.55) };
}

export function workingAudioStations(snapshot: EconomySceneProduction | null | undefined, now: number, owner?: string): Set<string> {
  const stations = new Set<string>();
  if (!snapshot || owner && snapshot.ownerPublicId !== owner || !Number.isFinite(now)) return stations;
  for (const job of snapshot.jobs) {
    const start = Date.parse(job.startedAt), end = Date.parse(job.finishesAt);
    if (job.stationLevel > 0 && Number.isInteger(job.stationLevel) && Number.isFinite(start) && Number.isFinite(end)
      && end > start && now >= start && now < end) stations.add(job.stationId);
  }
  return stations;
}

export function activeAudioConstructions(snapshot: EconomySceneConstruction | null | undefined, now: number, owner?: string): Set<string> {
  const stations = new Set<string>();
  if (!snapshot || owner && snapshot.ownerPublicId !== owner || !Number.isFinite(now)) return stations;
  for (const job of snapshot.jobs) {
    const start = Date.parse(job.startedAt), end = Date.parse(job.finishesAt);
    if (job.targetLevel > 0 && Number.isInteger(job.targetLevel) && Number.isFinite(start) && Number.isFinite(end)
      && end > start && now >= start && now < end) stations.add(job.stationId);
  }
  return stations;
}

/** Current account journey must still own this exact visible mine visit. A
 * hydrated old journey, entry walk, ready job or cancelled visit cannot hum. */
export function quarryAudioWorking(scene: FixedWorldScene, state: Pick<ForestSessionState, "journeyTravel">,
  journey: EconomySceneJourney | null | undefined, now: number): boolean {
  const travel = state.journeyTravel, route = journey?.routeId ?? "";
  if (!journey || !travel || travel.scene !== scene || travel.jobId !== journey.id || travel.cancelled
    || travel.phase !== "working" || !travel.mining?.prepared
    || !(["cave", "deep_cave", "abandoned_quarry", "quarry_work"].includes(route) || route.startsWith("quarry_"))) return false;
  const start = Date.parse(journey.startedAt), end = Date.parse(journey.finishesAt);
  return Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && end > start && now >= start && now < end;
}

/** Only geometry and read-only server snapshots enter this mixer; never rewards. */
export function buildWorldAudioFrame(scene: FixedWorldScene, input: WorldAudioEnvironment): AudioFrame {
  const listener = worldAudioListener(scene, input.camera), loops = new Map<string, AudioLoopTarget>();
  const sources: AudioSourceDebug[] = [];
  const working = workingAudioStations(input.production, input.now, input.ownerPublicId);
  if (input.quarryWorking) working.add("quarry");
  const constructing = activeAudioConstructions(input.construction, input.now, input.ownerPublicId);
  const night = clamp01(input.dusk), rain = clamp01(input.rain);
  let closeWork = 0;
  const add = (id: string, profile: string, gain: number, pan = 0, reason = "audible", group = id) => {
    const cues = profileCues(profile);
    if (!cues.length) { sources.push({ id, cueId: profile, gain: 0, pan, reason: "unknown-profile" }); return; }
    for (const cue of cues) {
      const level = Number.isFinite(gain) ? Math.max(0, Math.min(4, gain)) : 0;
      sources.push({ id, cueId: cue.id, gain: level, pan, reason: level > .0001 ? reason : reason === "audible" ? "outside-range" : reason });
      if (level <= .0001 || cue.mode === "one-shot") continue;
      const key = `${group}:${cue.id}`, previous = loops.get(key);
      // Several river polygons/production slots describe one acoustic source.
      if (!previous || previous.gain < level) loops.set(key, { id: key, cueId: cue.id, gain: level, pan, priority: cue.priority });
    }
  };
  add("music-day", "music.day", Math.sqrt(1 - night));
  add("music-night", "music.night", Math.sqrt(night));
  add("forest-day", "forest.day", Math.sqrt(1 - night) * (1 - rain * .55));
  add("forest-night", "forest.night", Math.sqrt(night) * (1 - rain * .55));
  add("weather-rain", "weather.rain", rain);
  const audibleWhen = (when: { siteId: string; level: number } | undefined) => !when || input.levels[when.siteId] === when.level;
  const emitters = [...(scene.audio?.emitters ?? [])];
  // Building sites can change location by level. Construction follows their
  // current entry and remains one bed per station, even with legacy jobs.
  for (const stationId of constructing) {
    if (emitters.some(item => item.activation === "construction-working" && (item.stationId ?? item.siteId) === stationId)) continue;
    const place = constructionMapPlace(stationId);
    const site = scene.sites.find(item => item.id === (place === "house" ? "home" : place));
    const fire = place === "campfire" ? scene.campfires?.find(item => item.id === "clearing-campfire") ?? scene.campfires?.[0] : undefined;
    const bush = place === "garden" ? scene.bushes?.[0] : undefined;
    const position = site?.entry ?? fire?.position ?? bush?.entry;
    if (!position) continue;
    emitters.push({ id: `construction-${stationId}`, profileId: "construction.working", activation: "construction-working",
      stationId, siteId: site?.id, position, innerRadius: 35, outerRadius: 280, gainDb: 0 });
  }
  const gate = (source: WorldAudioEmitter): { gain: number; reason: string } => {
    if (!audibleWhen(source.when)) return { gain: 0, reason: "building-level" };
    if (source.activation !== "always" && input.showBuildings === false) return { gain: 0, reason: "buildings-hidden" };
    if (source.activation === "production-working") {
      if (source.siteId && !(input.levels[source.siteId] > 0)) return { gain: 0, reason: "building-unbuilt" };
      return working.has(source.stationId ?? source.siteId ?? "") ? { gain: 1, reason: "audible" } : { gain: 0, reason: "production-idle-or-ready" };
    }
    if (source.activation === "construction-working") return constructing.has(source.stationId ?? source.siteId ?? "")
      ? { gain: 1, reason: "audible" } : { gain: 0, reason: "construction-idle-or-ready" };
    if (source.activation === "campfire-lit") {
      const fire = input.fires.find(item => item.id === source.campfireId);
      const cooking = working.has("dryer") && (scene.campfires?.find(item => item.id === "clearing-campfire") ?? scene.campfires?.[0])?.id === source.campfireId;
      return cooking ? { gain: 1, reason: "cooking-fire" } : fire?.lit && fire.flame > .02
        ? { gain: clamp01(fire.flame), reason: "audible" } : { gain: 0, reason: "fire-unlit" };
    }
    return { gain: 1, reason: "audible" };
  };
  for (const source of emitters) {
    const condition = gate(source);
    const gain = condition.gain * dbToGain(source.gainDb) * listener.detail
      * distanceGain(Math.hypot(listener.position.x - source.position.x, listener.position.y - source.position.y), source.innerRadius, source.outerRadius);
    const group = source.activation === "production-working" || source.activation === "construction-working"
      ? `${source.activation}:${source.stationId ?? source.siteId}:${source.profileId}` : source.id;
    add(source.id, source.profileId, gain, stereoPan(source.position, listener), condition.reason, group);
    if (source.activation === "production-working" || source.activation === "construction-working") closeWork = Math.max(closeWork, gain);
  }
  for (const zone of scene.audio?.zones ?? []) {
    const enabled = audibleWhen(zone.when);
    add(zone.id, zone.profileId, enabled ? dbToGain(zone.gainDb) * zoneGain(listener.position, zone.points, zone.fadeDistance) : 0,
      0, enabled ? "audible" : "building-level", `zone:${zone.profileId}`);
  }
  return { ownerId: input.ownerId, sceneId: input.sceneId, listener, loops: [...loops.values()],
    musicDuck: 1 - clamp01(closeWork) * .32, sources };
}

export function worldAudioEventPosition(position: AudioPoint, listener: AudioListenerFrame) {
  return { gain: distanceGain(Math.hypot(position.x - listener.position.x, position.y - listener.position.y), 45, 310) * listener.detail,
    pan: stereoPan(position, listener) };
}
