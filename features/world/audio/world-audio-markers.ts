import type { AudioEvent, AudioListenerFrame, AudioPoint } from "@/features/audio/domain/types";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { clearingActivityFrame } from "@/features/world/simulation/clearing-activity";
import { builderMindFrame, BUILDER_MIND_LIMITS } from "@/features/world/characters/builder/builder-mind";
import { pleskMindFrame } from "@/features/world/characters/plesk/plesk-mind";
import { forestJourneyFishingFrame } from "@/features/world/activities/journeys/forest-journey-travel";
import { worldAudioEventPosition } from "./world-audio-frame";

export type WorldAudioMarker = { key: string; token: string | number | null; cueId: string; position: AudioPoint; active?: boolean };
export type WorldAudioMarkerSnapshot = { epoch: object; elapsed: number; markers: WorldAudioMarker[] };
let nextMarkerSession = 0;

/** Read semantic state/phase contacts. Rendering has no playback side effects. */
export function worldAudioMarkers(scene: FixedWorldScene, state: ForestSessionState,
  options: { showHero: boolean; showBuildings: boolean; actorAway: boolean; reducedMotion: boolean }): WorldAudioMarkerSnapshot {
  const markers: WorldAudioMarker[] = [], actor = state.clearing, body = clearingActivityFrame(actor);
  const heroVisible = options.showHero && !options.actorAway;
  const add = (key: string, token: string | number | null, cueId: string, position: AudioPoint, active = true) => {
    markers.push({ key, token, cueId, position: { ...position }, active });
  };
  const speech = state.social.current;
  if (speech) {
    const speaker = speech.speaker, position = speaker === "builder" ? state.builderMind?.position
      : speaker === "plesk" ? state.pleskMind?.position : heroVisible ? actor.position : undefined;
    if (position && (speaker === "mochlik" || options.showBuildings)) add("speech", speech.id, `actor.${speaker}.greeting`, position);
  } else add("speech", null, "actor.mochlik.greeting", actor.position);
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
    const fishing = heroVisible ? forestJourneyFishingFrame(state, scene, false) : null;
    add("mochlik-cast", fishing?.action === "fish" ? `${state.journeyTravel?.jobId}:${fishing.castIndex ?? 0}` : null,
      "action.fish.splash", fishing?.waterTarget ?? actor.position, Boolean(fishing && !fishing.settling));
    add("mochlik-catch", fishing?.action === "catch" ? `${state.journeyTravel?.jobId}:${fishing.castIndex ?? 0}` : null,
      "actor.mochlik.joy", actor.position, Boolean(fishing && !fishing.settling));
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
    const plesk = options.showBuildings ? pleskMindFrame(state.pleskMind, scene, false) : null;
    const fisher = state.pleskMind;
    if (fisher) {
      add("plesk-step", `${fisher.decisions}:${Math.floor((plesk?.frame ?? 0) / 4)}`, "action.step.grass", fisher.position,
        plesk?.action === "walk" && !fisher.trafficWaiting);
      add("plesk-cast", plesk?.action === "fish" ? `${fisher.decisions}` : null, "action.fish.splash",
        plesk?.waterTarget ?? fisher.position, Boolean(plesk));
      add("plesk-catch", plesk?.action === "catch" ? `${fisher.decisions}` : null, "actor.plesk.joy", fisher.position, Boolean(plesk));
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
        if (!marker.active || marker.token === null || marker.token === prior?.token) return [];
        // Start/resume of walking is not a new ground contact by itself.
        if ((marker.key.endsWith("-step") || marker.key === "builder-hammer") && (!prior?.active || prior.token === null)) return [];
        const spatial = worldAudioEventPosition(marker.position, listener);
        return spatial.gain > .001 ? [{ id: `${scope}:session-${sessionId}:${marker.key}:${marker.token}:${++sequence}`,
          cueId: marker.cueId, occurredAt: now, ...spatial }] : [];
      });
    },
  };
}
