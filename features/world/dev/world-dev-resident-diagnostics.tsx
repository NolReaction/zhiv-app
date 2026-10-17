"use client";

import { useState, useSyncExternalStore } from "react";
import { WORLD_DEV_SCENE_ACTORS, type WorldDevSceneActor } from "./forest-scene-preview";
import { residentDiagnosticsStore } from "./forest-resident-diagnostics";
import styles from "./world-dev-scene.module.css";

const label = (id: string) => WORLD_DEV_SCENE_ACTORS.find(actor => actor.id === id)?.label ?? id;
export function WorldDevResidentDiagnostics() {
  const [actor, setActor] = useState<WorldDevSceneActor>("lopukh");
  const snapshot = useSyncExternalStore(residentDiagnosticsStore.subscribe, residentDiagnosticsStore.getSnapshot, residentDiagnosticsStore.getServerSnapshot);
  const current = snapshot?.actors.find(item => item.id === actor);
  return <section className={styles.scene} aria-label="Диагностика решений жителя">
    <h4>Куда идёт и почему</h4>
    <label className={styles.diagnosticChoice}>Житель<select value={actor} onChange={event => setActor(event.target.value as WorldDevSceneActor)}>
      {WORLD_DEV_SCENE_ACTORS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {current ? <div className={styles.feedback}>
      <strong>{current.goal} · {current.phase}</strong>
      <p>{current.reason}</p>
      <p>Цель: {current.target}<br />Путь: {current.routePoints} точек, осталось {current.remaining} ед.<br />
        Ноги: {current.position.x}, {current.position.y}<br />
        Преграждает путь: {current.blockingNeighbour ? label(current.blockingNeighbour) : "сосед не определён"}</p>
      {!current.available && <p>Житель ещё недоступен в этом мире.</p>}
      <span className={styles.phase}>{snapshot!.source.startsWith("dev:") ? "Копия мира" : "Текущий мир"} · {snapshot!.elapsed} с</span>
    </div> : <p className={styles.hint}>Снимок появится при следующем шаге сцены. Пауза сохраняет последний снимок.</p>}
  </section>;
}
