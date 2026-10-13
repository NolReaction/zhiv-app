import type { AudioEvent, AudioListenerFrame, AudioPoint } from "@/features/audio/domain/types";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { clearingActivityFrame } from "@/features/world/simulation/clearing-activity";
import { FOREST_MUSHROOM_CHEW } from "@/features/world/simulation/forest-life";
import { builderMindFrame, BUILDER_MIND_LIMITS } from "@/features/world/characters/builder/builder-mind";
import { pleskMindFrame } from "@/features/world/characters/plesk/plesk-mind";
import { forestJourneyFishingFrame } from "@/features/world/activities/journeys/forest-journey-travel";
import type { FishingPropFrame } from "@/features/world/activities/fishing/fishing-props";
import { forestJourneyMiningFrame, miningWorkRhythm } from "@/features/world/activities/mining/forest-mining";
import { worldAudioEventPosition } from "./world-audio-frame";

export type WorldAudioMarker = { key: string; token: string | number | null; cueId: string; position: AudioPoint; active?: boolean;
  /** A cast is audible only when this observer sees its float reach the water. */
  contact?: "air" | "water"; maxAgeMs?: number; runId?: string;
  /** Explicit dialogue replies stay audible at any camera distance or zoom. */
  listenerRelative?: boolean };
export type WorldAudioMarkerSnapshot = { epoch: object; elapsed: number; markers: WorldAudioMarker[] };
let nextMarkerSession = 0;

/** Read semantic state/phase contacts. Rendering has no playback side effects. */
export function worldAudioMarkers(scene: FixedWorldScene, state: ForestSessionState,
  options: { showHero: boolean; showBuildings: boolean; actorAway: boolean; reducedMotion: boolean; quarryWorking?: boolean }): WorldAudioMarkerSnapshot {
  const markers: WorldAudioMarker[] = [], actor = state.clearing, body = clearingActivityFrame(actor);
  const heroVisible = options.showHero && !options.actorAway;
  const add = (key: string, token: string | number | null, cueId: string, position: AudioPoint, active = true, listenerRelative = false) => {
    markers.push({ key, token, cueId, position: { ...position }, active, listenerRelative });
  };
  const speech = state.social.current;
  if (speech) {
    const speaker = speech.speaker, position = speaker === "builder" ? state.builderMind?.position
      : speaker === "plesk" ? state.pleskMind?.position : heroVisible ? actor.position : undefined;
    if (position && (speaker === "mochlik" || options.showBuildings)) {
      add("speech", speech.id, `actor.${speaker}.greeting`, position, true, speech.origin === "interaction");
    }
  } else add("speech", null, "actor.mochlik.greeting", actor.position);
  // Keep these contact tokens sampled even when motion/hero visibility is off:
  // returning to the map or to animated presentation must not replay old work.
  const actionVisible = heroVisible && !options.reducedMotion && !state.animation && state.reaction <= 0;
  const bush = actor.bushEffect, entry = bush && (bush.emitted & 1) ? bush.bursts[0] : undefined;
  const foliage = bush ? scene.bushes?.find(item => item.id === bush.id) : undefined;
  add("mochlik-bush-enter", entry ? `${bush!.id}:${entry.seed}:${entry.at}` : null,
    "action.bush.rustle", foliage?.hide ?? actor.position, actionVisible);
  const routine = state.life.routine, chew = FOREST_MUSHROOM_CHEW;
  const bite = routine?.kind === "mushroom" && routine.picked && routine.elapsed >= chew.start && routine.elapsed < chew.end
    ? Math.floor((routine.elapsed - chew.start) * chew.frameRate / chew.frameCount) : null;
  add("mochlik-mushroom-bite", bite === null ? null : `${state.life.sequence}:${routine!.mushroomId}:${bite}`,
    "action.mushroom.eat", actor.position, actionVisible && body.opacity > .3 && !state.journeyTravel?.mining && !routine?.interrupting);
  // Keep sampling these contacts while presentation is hidden or static, so
  // enabling it again cannot turn an already floating bobber into a new cast.
  const fishing = forestJourneyFishingFrame(state, scene, false);
  const plesk = pleskMindFrame(state.pleskMind, scene, false);
  const cast = (key: string, frame: FishingPropFrame | null, token: string, visible: boolean) => {
    const water = frame?.waterTarget;
    const valid = Boolean(frame && !frame.settling && water && [water.x, water.y].every(Number.isFinite)
      && (frame.action === "cast" || frame.action === "fish"));
    markers.push({ key, token: valid ? token : null, cueId: "action.fish.bobber", position: water ?? actor.position,
      // The shared tackle reaches water at cast phase 1; fish begins exactly
      // there. Waiting/check/nibble subphases never cause another impact.
      contact: valid ? frame!.action === "cast" && frame!.phase < 1 ? "air" : "water" : undefined,
      active: valid && visible && !options.reducedMotion, maxAgeMs: 250 });
  };
  cast("mochlik-cast", fishing, `${state.journeyTravel?.jobId}:${fishing?.castIndex ?? 0}`, heroVisible);
  cast("plesk-cast", plesk, `${state.pleskMind?.decisions}`, options.showBuildings);
  const mining = forestJourneyMiningFrame(state, scene, false);
  markers.push({ key: "mochlik-mine", token: mining?.working
    ? `${state.journeyTravel?.jobId}:${miningWorkRhythm(mining.elapsed).strike}` : null,
    cueId: "action.mine.strike", position: mining?.doorway ?? actor.position, maxAgeMs: 250, runId: state.journeyTravel?.jobId,
    active: Boolean(options.quarryWorking && options.showBuildings && !options.reducedMotion && mining?.working) });
  if (!options.reducedMotion) {
    const outside = heroVisible && body.opacity > .3 && !state.journeyTravel?.mining && !state.animation && state.reaction <= 0;
    add("mochlik-step", Math.floor(actor.walked / (actor.size * .15)), "action.step.grass", actor.position, outside && body.pose === "walk");
    add("mochlik-sleep", body.homeSleeping ? "sleep" : null, "actor.mochlik.sleep", actor.position, heroVisible);
    const garden = state.life.garden.routine;
    const water = garden?.phase === "water" && garden.elapsed >= .8 && garden.elapsed < 3.35;
    add("garden-water", water ? garden.bushId : null, "action.water.pour", actor.position, outside);
    // Fruit leaves the bush at .30 of each of the three one-second reaches.
    const picked = garden?.phase === "collect" ? Math.max(0, Math.min(3, Math.floor(garden.elapsed - 1.15) + 1)) : 0;
    add("garden-pick", picked > 0 ? `${garden!.bushId}:${picked}` : null, "action.berry.pick", actor.position, outside);
    add("mochlik-catch", fishing?.action === "catch" ? `${state.journeyTravel?.jobId}:${fishing.castIndex ?? 0}` : null,
      "actor.mochlik.joy", actor.position, Boolean(heroVisible && fishing && !fishing.settling));
    const builder = options.showBuildings ? builderMindFrame(state.builderMind, scene, false) : null;
    const mind = state.builderMind;
    if (mind) {
      add("builder-step", Math.floor(mind.walked / (40 * .24)), "action.step.grass", mind.position, builder?.action === "walk");
      const routine = BUILDER_MIND_LIMITS.workRoutine, cycle = BUILDER_MIND_LIMITS.workCycle;
      const age = mind.age % routine, iteration = Math.floor(mind.age / routine);
      const strike = age < cycle ? Number(age >= cycle * .4375) : age < cycle * 2
        ? 1 + Math.floor((age - cycle) / (cycle / 2)) + Number((age - cycle) % (cycle / 2) >= cycle / 2 * .4375) : 3;
      add("builder-hammer", `${mind.jobKey}:${iteration}:${strike}`, "action.hammer", mind.position,
        builder?.action === "work" && !mind.ready);
      add("builder-ready", builder?.action === "finish" ? mind.jobKey : null, "actor.builder.joy", mind.position, Boolean(builder));
    }
    const fisher = state.pleskMind;
    if (fisher) {
      add("plesk-step", `${fisher.decisions}:${Math.floor((plesk?.frame ?? 0) / 4)}`, "action.step.grass", fisher.position,
        options.showBuildings && plesk?.action === "walk" && !fisher.trafficWaiting);
      add("plesk-catch", plesk?.action === "catch" ? `${fisher.decisions}` : null, "actor.plesk.joy", fisher.position,
        options.showBuildings && Boolean(plesk));
    }
  }
  return { epoch: state.clearing, elapsed: state.elapsed, markers };
}

/** A delta observer, shared by both views of one simulation session. No queue. */
export function createWorldAudioMarkerTracker() {
  const sessionId = ++nextMarkerSession;
  let previous: WorldAudioMarkerSnapshot | null = null, sequence = 0;
  return {
    sample(snapshot: WorldAudioMarkerSnapshot, listener: AudioListenerFrame, scope: string, now: number, emit = true): AudioEvent[] {
      const before = previous; previous = snapshot;
      if (!emit || !before || before.epoch !== snapshot.epoch || snapshot.elapsed < before.elapsed
        || snapshot.elapsed - before.elapsed > .25) return [];
      const old = new Map(before.markers.map(marker => [marker.key, marker]));
      return snapshot.markers.flatMap(marker => {
        const prior = old.get(marker.key);
        if (!marker.active || marker.token === null || marker.runId !== prior?.runId) return [];
        if (marker.contact) {
          if (marker.contact !== "water" || prior?.contact !== "air" || !prior.active || prior.token !== marker.token) return [];
        } else if (marker.token === prior?.token) return [];
        // Start/resume of walking is not a new ground contact by itself.
        if ((marker.key.endsWith("-step") || marker.key === "builder-hammer" || marker.key === "mochlik-mine")
          && (!prior?.active || prior.token === null)) return [];
        // Keep the existing semantic token/dedup path: a tap must not also
        // trigger a second greeting through an independent UI audio handler.
        const spatial = marker.listenerRelative ? { gain: 1, pan: 0 } : worldAudioEventPosition(marker.position, listener);
        return spatial.gain > .001 ? [{ id: `${scope}:session-${sessionId}:${marker.key}:${marker.token}:${++sequence}`,
          cueId: marker.cueId, occurredAt: now, ...(marker.maxAgeMs ? { maxAgeMs: marker.maxAgeMs } : {}), ...spatial }] : [];
      });
    },
  };
}
