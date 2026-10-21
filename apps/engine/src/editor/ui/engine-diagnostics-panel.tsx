"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { createEngineController } from "@/apps/engine/src/editor/input/controller";
import { ENGINE_TIMINGS, type EngineProfiler } from "@/apps/engine/src/editor/diagnostics/engine-profiler";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof createEngineController>;
const timingNames = { paint: "Рисование", commit: "Изменение", undo: "Отмена/повтор", save: "Сохранение", export: "Экспорт" };
const number = (value: number | null) => value === null ? "—" : value.toFixed(2);
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} МиБ`;

export function EngineDiagnosticsPanel({ controller, profiler, close }: { controller: Controller | null; profiler: EngineProfiler; close: () => void }) {
  const [snapshot, setSnapshot] = useState(() => controller?.getDiagnostics() ?? null);
  useEffect(() => {
    const refresh = () => {
      const next = controller?.getDiagnostics() ?? null;
      setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const timer = window.setInterval(refresh, 500); return () => window.clearInterval(timer);
  }, [controller]);
  const profile = snapshot?.profile ?? profiler.snapshot(), memory = snapshot?.rendering.memory;
  const counters = snapshot ? Object.entries(snapshot.rendering).filter(([, value]) => typeof value === "number") : [];
  return <section className={styles.diagnosticsPanel} aria-label="Диагностика Engine" data-workspace-popover>
    <div className={styles.popoverHeading}><strong>Диагностика</strong><EditorButton type="button" aria-label="Закрыть диагностику" onClick={close}><X size={18} /></EditorButton></div>
    <p className={styles.small}>Измерения включены, пока панель открыта. Значения времени — миллисекунды, окно до {profile.capacity} завершённых операций; сохранение включает ожидание IndexedDB.</p>
    <table className={styles.diagnosticsTable}><thead><tr><th>Операция</th><th>Последняя</th><th>Медиана</th><th>P95</th><th>N</th></tr></thead><tbody>{ENGINE_TIMINGS.map(name => {
      const timing = profile.timings[name];
      return <tr key={name}><th>{timingNames[name]}</th><td>{number(timing.latestMs)}</td><td>{number(timing.medianMs)}</td><td>{number(timing.p95Ms)}</td><td>{timing.count}</td></tr>;
    })}</tbody></table>
    <p className={styles.small}>Это длительность операций, а не FPS. P95 показывает границу, в которую уложились 95% последних измерений.</p>
    {memory && <><h3>Оценка кэшей · {mib(memory.totalBytesEstimate)}</h3><dl className={styles.diagnosticsMemory}><div><dt>Canvas RGBA8</dt><dd>{mib(memory.canvasBytesEstimate)}</dd></div><div><dt>Декодированные PNG</dt><dd>{mib(memory.decodedImageBytesEstimate)}</dd></div><div><dt>Буферы</dt><dd>{mib(memory.retainedBufferBytes)}</dd></div></dl><details><summary>Кэши по группам</summary><dl className={styles.diagnosticsMemory}>{Object.entries(memory.groups).map(([name, value]) => <div key={name}><dt>{name} · {value.count}</dt><dd>{mib(value.bytesEstimate)}</dd></div>)}</dl></details><p className={styles.small}>Оценка удерживаемых RGBA8-кэшей и буферов. Дополнительные копии браузера/GPU, объекты сцены, история, JSON/base64 и сжатые Blob сюда не входят; фактическая память браузера не измеряется.</p></>}
    {counters.length > 0 && <details><summary>Счётчики рендера</summary><dl className={styles.diagnosticsMemory}>{counters.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl></details>}
    <EditorButton type="button" className={styles.diagnosticsReset} onClick={() => { profiler.reset(); setSnapshot(controller?.getDiagnostics() ?? null); }}><RefreshCw size={14} />Сбросить измерения</EditorButton>
  </section>;
}
