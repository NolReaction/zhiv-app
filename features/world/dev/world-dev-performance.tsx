"use client";

import { useEffect, useSyncExternalStore } from "react";
import { forestPerformanceProfiler, type ForestPerformanceStage } from "./forest-performance-profiler";
import styles from "./world-dev-performance.module.css";

const labels: Record<ForestPerformanceStage, string> = {
  ai: "AI / шаг сцены", navigation: "Поиск пути", water: "Симуляция воды", render: "Рисование", occupancy: "Занятые места",
};
const duration = (value: number) => value < .001 ? "<0,001" : value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const mib = (bytes: number) => (bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

export function WorldDevPerformance() {
  const snapshot = useSyncExternalStore(forestPerformanceProfiler.subscribe, forestPerformanceProfiler.getSnapshot,
    forestPerformanceProfiler.getServerSnapshot);
  useEffect(() => () => { forestPerformanceProfiler.setEnabled(false); }, []);
  if (process.env.NODE_ENV !== "development") return null;
  return <section className={styles.panel} aria-label="Измерения производительности сцены">
    <h4>Время работы сцены</h4>
    <p>Включается вручную. До 240 последних вызовов каждого участка. Значения в миллисекундах, без оценки FPS.</p>
    <div className={styles.actions}>
      <button type="button" aria-pressed={snapshot.enabled} onClick={() => forestPerformanceProfiler.setEnabled(!snapshot.enabled)}>
        {snapshot.enabled ? "Остановить замер" : "Начать замер"}
      </button>
      <button type="button" onClick={() => forestPerformanceProfiler.reset()}>Сбросить замеры</button>
      <button type="button" disabled={!snapshot.enabled} onClick={() => forestPerformanceProfiler.refreshMemory()}>Измерить JS-память</button>
    </div>
    {snapshot.summaries.length ? <div className={styles.scroll}><table>
      <caption>Последние измерения: среднее, 95-й процентиль и максимум</caption>
      <thead><tr><th scope="col">Участок</th><th scope="col">Вызовов</th><th scope="col">Среднее</th><th scope="col">P95</th><th scope="col">Макс.</th></tr></thead>
      <tbody>{snapshot.summaries.map(row => <tr key={`${row.source}:${row.stage}`}>
        <th scope="row">{labels[row.stage]}<small>{row.source === "rehearsal" ? "Копия мира" : "Текущий мир"}</small></th>
        <td>{row.count}</td><td>{duration(row.averageMs)}</td><td>{duration(row.p95Ms)}</td><td>{duration(row.maxMs)}</td>
      </tr>)}</tbody>
    </table></div> : <p>{snapshot.enabled ? "Ожидает вызовов сцены. Пауза сохраняет последние измерения." : "Замер выключен."}</p>}
    <p>Поиск пути и подготовка занятых мест могут входить в AI. Участки вызываются с разной частотой, их время не суммируется.</p>
    <p className={styles.memory}>{snapshot.memoryStatus === "measured" && snapshot.memory
      ? <>Используемая JS-куча этой страницы: {mib(snapshot.memory.usedBytes)} МиБ.
        {snapshot.memory.allocatedBytes !== undefined && <> Выделено браузером: {mib(snapshot.memory.allocatedBytes)} МиБ.</>}
        {snapshot.memory.limitBytes !== undefined && <> Лимит JS-кучи: {mib(snapshot.memory.limitBytes)} МиБ.</>}
        <br />Последний ручной замер; это не вся память игры, изображений или GPU.</>
      : snapshot.memoryStatus === "unavailable" ? "Этот браузер не предоставляет поддерживаемый показатель JS-памяти."
        : "JS-память ещё не измерялась. Доступна только при поддержке браузером."}</p>
  </section>;
}
