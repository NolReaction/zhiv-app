"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WORLD_DEV_SCENE_ACTORS, type WorldDevSceneActor } from "./forest-scene-preview";
import { residentDiagnosticsStore } from "./forest-resident-diagnostics";
import { downloadResidentIncidentReport } from "./resident-incident-download";
import { WorldDevResidentJournal } from "./world-dev-resident-journal";
import { WorldDevPerformance } from "./world-dev-performance";
import styles from "./world-dev-scene.module.css";

const label = (id: string) => WORLD_DEV_SCENE_ACTORS.find(actor => actor.id === id)?.label ?? id;
export function WorldDevResidentDiagnostics() {
  const [actor, setActor] = useState<WorldDevSceneActor>("lopukh");
  const [transfer, setTransfer] = useState<{ capture: number; notice: string; json: string | null } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const view = useSyncExternalStore(residentDiagnosticsStore.subscribe, residentDiagnosticsStore.getViewSnapshot, residentDiagnosticsStore.getServerViewSnapshot);
  const snapshot = view.diagnostics;
  const current = snapshot?.actors.find(item => item.id === actor);
  const visibleTransfer = snapshot && transfer?.capture === view.journal.capture ? transfer : null;
  async function exportReport(copy: boolean) {
    const report = residentDiagnosticsStore.exportReport(), capture = view.journal.capture;
    if (!report) return;
    let success = false;
    if (copy) { try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(report.json); success = true; } } catch { /* Manual selection remains available. */ } }
    else success = downloadResidentIncidentReport(report);
    const now = residentDiagnosticsStore.getViewSnapshot();
    if (!mounted.current || now.journal.capture !== capture || !now.diagnostics) return;
    setTransfer({ capture, json: success ? null : report.json, notice: success ? copy ? "JSON скопирован." : "Загрузка JSON начата."
      : "Автоматическая передача недоступна. Выделите JSON ниже и скопируйте вручную." });
  }
  return <><section className={styles.scene} aria-label="Диагностика решений жителя">
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
    <WorldDevResidentJournal journal={view.journal} actor={actor} available={Boolean(snapshot)}
      notice={visibleTransfer?.notice ?? ""} manualJSON={visibleTransfer?.json ?? null}
      onRecord={recording => { setTransfer(null); residentDiagnosticsStore.setRecording(recording); }}
      onClear={() => { setTransfer(null); residentDiagnosticsStore.clearJournal(); }}
      onDownload={() => { void exportReport(false); }} onCopy={() => { void exportReport(true); }} />
  </section><WorldDevPerformance /></>;
}
