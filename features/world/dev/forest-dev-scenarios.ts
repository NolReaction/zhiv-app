import type { ForestSessionState } from "../forest-session";
import type { ForestDirectorOptions } from "../forest-director";
import { cancelForestDirector, requestForestDirective } from "../forest-director";
import { createBirdReactions } from "../forest-bird-reactions";
import type { WorldDevScenario } from "./world-dev-store";

/** Caller must suspend account persistence before applying any DEV event. */
export function applyForestDevScenario(state: ForestSessionState, kind: WorldDevScenario, options: ForestDirectorOptions) {
  cancelForestDirector(state);
  state.animation = null; state.reaction = 0;
  if (kind === "birds") {
    state.birdStarted = state.elapsed; state.birdSeed = 0;
    state.birdReactions = createBirdReactions(); state.lastBirdStimulus = state.director.stimulus?.id ?? 0;
    state.director.reason = "Пара птиц прилетит на деревья у полянки; посадка примерно через 7 секунд";
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
