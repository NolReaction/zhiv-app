"use client";

import { useState, useSyncExternalStore } from "react";
import { WORLD_DEV_SCENE_ACTORS, WORLD_DEV_SCENES, normalizeWorldDevSceneRequest, worldDevScenesFor,
  type WorldDevSceneActor, type WorldDevSceneFeedback, type WorldDevSceneScenario } from "./forest-scene-preview";
import { worldDevStore, type WorldDevState } from "./world-dev-store";
import styles from "./world-dev-scene.module.css";

export type WorldDevSceneChoice = { actor: WorldDevSceneActor; scenario: WorldDevSceneScenario; target: WorldDevSceneActor; seed?: number };
const actorLabel = (id: WorldDevSceneActor) => WORLD_DEV_SCENE_ACTORS.find(actor => actor.id === id)!.label;
const phaseLabels = { queued: "Подготовка", running: "Идёт репетиция", complete: "Завершена", blocked: "Не началась", stopped: "Остановлена" };

export function worldDevSceneUnavailable(state: WorldDevState, choice: WorldDevSceneChoice, prefersReducedMotion: boolean): string | null {
  if (!normalizeWorldDevSceneRequest({ id: 1, ...choice })) return "Выберите подходящую сцену и другого собеседника.";
  if (state.paused) return "Сцена на паузе. Нажмите «Продолжить» вверху DEV.";
  if (state.reducedMotion === "on" || state.reducedMotion === "auto" && prefersReducedMotion)
    return "Для проверки анимации выключите «Меньше движения» в настройках мира.";
  if (choice.scenario === "butterfly" && state.butterflies === "off") return "Бабочки выключены. Включите их во вкладке «Погода».";
  if (choice.scenario === "watch-birds" && state.birds === "off") return "Птицы выключены. Включите их во вкладке «Погода».";
  if ((choice.scenario === "butterfly" || choice.scenario === "watch-birds") && state.timeOfDay === "night")
    return "Для этой встречи выберите дневной свет вверху DEV.";
  return null;
}

export function WorldDevScene({ state, prefersReducedMotion, onStart, onStop }: {
  state: WorldDevState; prefersReducedMotion: boolean;
  onStart: (choice: WorldDevSceneChoice) => void; onStop: () => void;
}) {
  const [choice, setChoice] = useState<WorldDevSceneChoice>({ actor: "lopukh", scenario: "walk", target: "leaftail", seed: 17 });
  const feedback = useSyncExternalStore(worldDevStore.subscribeSceneFeedback, worldDevStore.getSceneFeedback, worldDevStore.getServerSceneFeedback);
  return <WorldDevSceneControls state={state} choice={choice} feedback={feedback} prefersReducedMotion={prefersReducedMotion}
    onChange={patch => setChoice(current => {
      const next = { ...current, ...patch };
      if (!worldDevScenesFor(next.actor).some(scene => scene.id === next.scenario)) next.scenario = "walk";
      if (next.target === next.actor) next.target = WORLD_DEV_SCENE_ACTORS.find(actor => actor.id !== next.actor)!.id;
      return next;
    })} onStart={() => onStart(choice)} onStop={onStop} />;
}

/** Inspecting controls and switching actors never issues a request. Only the
 * explicit run button can start the finite isolated scene. */
export function WorldDevSceneControls({ state, choice, feedback, prefersReducedMotion, onChange, onStart, onStop }: {
  state: WorldDevState; choice: WorldDevSceneChoice; feedback: WorldDevSceneFeedback | null; prefersReducedMotion: boolean;
  onChange: (patch: Partial<WorldDevSceneChoice>) => void; onStart: () => void; onStop: () => void;
}) {
  const scenarios = worldDevScenesFor(choice.actor), selected = WORLD_DEV_SCENES.find(scene => scene.id === choice.scenario)!;
  const reason = worldDevSceneUnavailable(state, choice, prefersReducedMotion);
  const active = Boolean(state.scenePreview);
  const finished = feedback && ["complete", "blocked", "stopped"].includes(feedback.phase);
  return <div className={styles.scene}>
    <p className={styles.hint}>Проверка на копии мира: прогулки, работа, встречи и входы в дома. Прогресс игрока сохраняется.</p>
    <div className={styles.fields}>
      <label><span>Кого проверить</span><select value={choice.actor} onChange={event => onChange({ actor: event.target.value as WorldDevSceneActor })}>
        {WORLD_DEV_SCENE_ACTORS.map(actor => <option key={actor.id} value={actor.id}>{actor.label}</option>)}
      </select></label>
      <label><span>Что проверить</span><select value={choice.scenario} onChange={event => onChange({ scenario: event.target.value as WorldDevSceneScenario })}>
        {scenarios.map(scene => <option key={scene.id} value={scene.id}>{scene.label}</option>)}
      </select></label>
      {choice.scenario === "conversation" && <label className={styles.partner}><span>С кем поговорить</span>
        <select value={choice.target} onChange={event => onChange({ target: event.target.value as WorldDevSceneActor })}>
          {WORLD_DEV_SCENE_ACTORS.filter(actor => actor.id !== choice.actor).map(actor => <option key={actor.id} value={actor.id}>{actor.label}</option>)}
        </select>
      </label>}
    </div>
    <p className={styles.description}>{selected.description}</p>
    <label className={styles.seed}>Повторяемый вариант
      <input aria-label="Номер варианта сцены" type="number" min={1} max={4294967295} step={1} value={choice.seed ?? 17}
        onChange={event => onChange({ seed: Number(event.target.value) })} />
      <span>Одинаковый номер повторяет начальный выбор AI. «Запустить» создаёт новую копию мира.</span>
    </label>
    <div className={styles.actions}>
      <button type="button" data-scene-run disabled={Boolean(reason)} title={reason ?? undefined} onClick={onStart}>Запустить</button>
      <button type="button" data-scene-stop disabled={!active} onClick={onStop}>{finished ? "Вернуться в мир" : "Остановить"}</button>
    </div>
    <div className={styles.feedback} role="status" aria-live="polite" data-phase={feedback?.phase ?? "idle"}>
      {state.scenePreview && <strong>{actorLabel(state.scenePreview.actor)} · {WORLD_DEV_SCENES.find(scene => scene.id === state.scenePreview!.scenario)!.label}</strong>}
      {feedback && <span className={styles.phase}>{phaseLabels[feedback.phase]}</span>}
      <p>{reason ?? feedback?.message ?? "Выберите жителя и сцену, затем нажмите «Запустить»."}</p>
    </div>
    <p className={styles.hint}>Одна репетиция за раз. Её можно остановить; без подходящего пути или животного появится причина.</p>
  </div>;
}
