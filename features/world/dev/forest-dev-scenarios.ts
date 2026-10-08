import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { ForestDirectorOptions } from "@/features/world/simulation/forest-director";
import { cancelForestDirector, requestForestDirective } from "@/features/world/simulation/forest-director";
import { createBirdReactions } from "@/features/world/environment/wildlife/forest-bird-reactions";
import type { WorldDevScenario } from "./world-dev-store";

/** Caller must suspend account persistence before applying any DEV event. */
export function applyForestDevScenario(state: ForestSessionState, kind: WorldDevScenario, options: ForestDirectorOptions) {
  // These dedicated previews are coordinated by the scene/session, not the
  // clearing director. In particular, an NPC check must not move the hero.
  if (kind === "plesk" || kind === "fishing") return;
  cancelForestDirector(state);
  state.animation = null; state.reaction = 0;
  if (kind === "birds" || kind === "ground-birds") {
    state.birdStarted = state.elapsed; state.birdSeed = kind === "ground-birds" ? 6 : 0;
    state.birdReactions = createBirdReactions(); state.lastBirdStimulus = state.director.stimulus?.id ?? 0;
    state.director.reason = kind === "ground-birds"
      ? "Птицы приземлятся на свободную землю, осмотрятся и начнут искать корм"
      : "Пара птиц прилетит на деревья у полянки; посадка примерно через 7 секунд";
  } else if (kind === "campfire") {
    for (const fire of state.life.campfires) { fire.wetness = 0; fire.drySeconds = 0; }
    requestForestDirective(state, "campfire", options);
  } else if (kind === "tired") {
    state.clearing.behavior.mind.needs.energy = .18;
    state.clearing.awakeUntil = state.clearing.elapsed;
    state.director.nextDecisionAt = state.director.elapsed;
    state.director.reason = "В DEV задана усталость — Мохлик сам выбирает отдых";
  } else state.director.reason = "Дождливый вечер — наблюдаем укрытия и затухание костра";
}
