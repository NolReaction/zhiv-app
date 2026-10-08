"use client";

import { useState, useSyncExternalStore } from "react";
import { AUDIO_CATALOG } from "@/features/audio/catalog/catalog";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { AudioSettingsButton, AUDIO_BUS_LABELS } from "@/features/audio/ui/audio-settings";
import { useAudioDiagnostics } from "@/features/audio/ui/use-audio-diagnostics";
import { audioDevStore } from "./audio-dev-store";
import styles from "./audio-diagnostics.module.css";

const STATE_LABELS = { locked: "Ожидает нажатия", running: "Работает", suspended: "На паузе", unavailable: "Не поддерживается", disposed: "Завершён" };

export function AudioDiagnosticsPanel() {
  return process.env.NODE_ENV === "development" ? <DevelopmentAudioDiagnostics /> : null;
}

function DevelopmentAudioDiagnostics() {
  const diagnostics = useAudioDiagnostics();
  const debug = useSyncExternalStore(audioDevStore.subscribe, audioDevStore.getSnapshot, audioDevStore.getServerSnapshot);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const readyAssets = AUDIO_CATALOG.assets.filter(asset => asset.status === "ready" && asset.src);
  const assetsById = new Map(AUDIO_CATALOG.assets.map(asset => [asset.id, asset]));
  const cues = AUDIO_CATALOG.cues.filter(cue => `${cue.id} ${AUDIO_BUS_LABELS[cue.bus]}`.toLocaleLowerCase("ru").includes(filter.toLocaleLowerCase("ru")));

  async function preview(cueId?: string) {
    setBusy(true);
    const runtime = getAudioRuntime();
    runtime.setSettings({ enabled: true });
    try {
      if (!await runtime.unlock()) { setFeedback("Браузер не разрешил звук. Повторите нажатие."); return; }
      if (cueId) runtime.preview(cueId); else runtime.previewTone("ui");
      setFeedback(cueId ? `Прослушивание: ${cueId}` : "Тестовый тон интерфейса. Учитываются общая громкость и канал «Интерфейс».");
    } catch { setFeedback("Не удалось воспроизвести проверку."); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-label="Диагностика звука">
    <h3>Звуковой движок</h3>
    <dl className={styles.metrics}>
      <div><dt>Контекст</dt><dd>{STATE_LABELS[diagnostics.state]}</dd></div>
      <div><dt>Звук</dt><dd>{diagnostics.settings.enabled ? "Включён" : "Выключен"}</dd></div>
      <div><dt>Активных голосов</dt><dd>{diagnostics.activeVoices}</dd></div>
      <div><dt>Файлов в памяти</dt><dd>{diagnostics.loadedAssets}</dd></div>
      <div><dt>Ожидают файлов / загрузки</dt><dd>{diagnostics.pendingAssets}</dd></div>
      <div><dt>Отклонено событий</dt><dd>{diagnostics.droppedEvents}</dd></div>
    </dl>
    <div className={styles.actions}>
      <AudioSettingsButton label />
      <button type="button" disabled={busy || diagnostics.state === "unavailable"} onClick={() => void preview()}>Включить и проверить тон</button>
      <button type="button" disabled={!diagnostics.settings.enabled} onClick={() => { getAudioRuntime().setSettings({ enabled: false }); setFeedback("Все каналы выключены"); }}>Выключить звук</button>
    </div>
    <p className={styles.hint}>Тестовый тон создаётся только этой кнопкой. Прослушивание включает звук; уровень каждого канала остаётся выбранным в настройках. Музыка и петли проверяются коротким фрагментом до 4 секунд.</p>
    <label className={styles.toggle}><input type="checkbox" checked={debug.showSources} onChange={event => audioDevStore.setShowSources(event.currentTarget.checked)} />Показать источники и зоны на карте</label>
    <p className={styles.feedback} role="status">{feedback}</p>
    {diagnostics.failedAssets.length > 0 && <p className={styles.error}>Не удалось загрузить: {diagnostics.failedAssets.join(", ")}</p>}
    <details open><summary>Каталог · готово {readyAssets.length} / {AUDIO_CATALOG.assets.length} файлов</summary>
      {readyAssets.length === 0 && <p className={styles.hint}>Аудиозаписи ещё не добавлены. Профили и события подготовлены; отсутствующие файлы не запрашиваются.</p>}
      <label className={styles.filter}>Найти звук<input type="search" value={filter} onChange={event => setFilter(event.currentTarget.value)} placeholder="Река, music, ui…" /></label>
      <ul className={styles.catalog}>{cues.map(cue => {
        const count = cue.assets.filter(id => { const asset = assetsById.get(id); return asset?.status === "ready" && Boolean(asset.src); }).length;
        return <li key={cue.id}><div><code>{cue.id}</code><small>{AUDIO_BUS_LABELS[cue.bus]} · вариантов {count}/{cue.assets.length}</small></div>
          <button type="button" aria-label={`Прослушать ${cue.id}`} disabled={!count || busy || diagnostics.state === "unavailable"} onClick={() => void preview(cue.id)}>Слушать</button></li>;
      })}</ul>
    </details>
    <details open><summary>Источники сцены · {diagnostics.sources.length}</summary>
      {diagnostics.sources.length === 0 ? <p className={styles.hint}>Сцена ещё не передаёт источники или сейчас не видна.</p> : <div className={styles.tableWrap}><table>
        <thead><tr><th scope="col">Источник / звук</th><th scope="col">Уровень</th><th scope="col">Панорама</th><th scope="col">Состояние</th></tr></thead>
        <tbody>{diagnostics.sources.map(source => <tr key={`${source.id}:${source.cueId}`}><th scope="row"><code>{source.id}</code><small>{source.cueId}</small></th>
          <td>{Math.round(source.gain * 100)}%</td><td>{source.pan.toFixed(2)}</td><td>{source.reason}</td></tr>)}</tbody>
      </table></div>}
    </details>
    <p className={styles.hint}>Последнее событие: <code>{diagnostics.lastEvent ?? "—"}</code></p>
  </section>;
}
