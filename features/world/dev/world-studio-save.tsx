import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Download, Save, Upload } from "lucide-react";
import { worldLightingEditorStore } from "./world-lighting-editor-store";
import { useWorldStudioProjectSave } from "./world-studio-project-save";
import { WORLD_STUDIO_UI_EVENT } from "./world-studio-keyboard";
import styles from "./world-lighting-studio.module.css";

function saveTime(value: number | null) { return value === null ? "" : new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
export function downloadStudioJson(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function WorldStudioSave() {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const project = useWorldStudioProjectSave();
  const fileInput = useRef<HTMLInputElement>(null), saveNow = useRef(project.saveNow);
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [confirmReset, setConfirmReset] = useState(false), [confirmProject, setConfirmProject] = useState(false), [loadingProject, setLoadingProject] = useState(false);
  useEffect(() => { saveNow.current = project.saveNow; }, [project.saveNow]);
  useEffect(() => {
    const save = (event: Event) => {
      if ((event as CustomEvent).detail?.action === "save") void saveNow.current();
    };
    window.addEventListener(WORLD_STUDIO_UI_EVENT, save); return () => window.removeEventListener(WORLD_STUDIO_UI_EVENT, save);
  }, []);
  const localLabel = snapshot.localSaveStatus === "error" ? "Черновик в браузере: ошибка сохранения" : snapshot.localSaveStatus === "pending" ? "Черновик в браузере: сохраняется…" : snapshot.localSavedAt ? `Черновик в браузере: сохранён в ${saveTime(snapshot.localSavedAt)}` : "Черновик в браузере: сохранён";
  const projectLabel = project.paused ? "Файлы проекта: автосохранение на паузе" : project.status === "probing" ? "Файлы проекта: проверяем доступность…" : project.status === "unavailable" ? "Файлы проекта: доступны только в локальном DEV" : project.status === "conflict" ? "В проекте есть другие правки" : project.status === "error" ? "Файлы проекта: ошибка сохранения" : project.status === "saving" ? "Файлы проекта: сохраняются…" : project.pending ? "Файлы проекта: есть несохранённые правки" : project.savedAt ? `Проект сохранён · ${saveTime(project.savedAt)}` : "Файлы проекта: готовы к автосохранению";
  const unread = worldLightingEditorStore.hasHydrationConflict();
  const dirty = snapshot.dirtyIds.length + snapshot.dirtyLightIds.length + snapshot.dirtyReceiverIds.length;
  return <section className={styles.savePanel} data-world-lighting-studio-panel aria-label="Сохранение студии">
    <div className={styles.saveSummary}>{snapshot.localSaveStatus === "saved" ? <Check size={16} aria-hidden /> : <Save size={16} aria-hidden />}<div className={styles.saveStatus} aria-live="polite"><strong>{localLabel}</strong><small>{projectLabel}</small></div><button type="button" disabled={project.status === "saving"} title="Сохранить · Ctrl/Cmd+S" onClick={() => { worldLightingEditorStore.commitGesture(); worldLightingEditorStore.saveDraft(); void project.saveNow(); }}><Save size={14} aria-hidden />Сохранить сейчас</button></div>
    <details className={styles.save}><summary>Сохранение и резервная копия</summary><div className={styles.saveBody}>
      <p>Черновик сохраняется автоматически в этом браузере после правок. Он остаётся при закрытии студии и обновлении страницы.</p>
      {snapshot.localSaveError && <p className={styles.error} role="alert">{snapshot.localSaveError}</p>}
      {snapshot.localSaveStatus === "error" && !unread && <button type="button" onClick={() => worldLightingEditorStore.retryLocalSave()}>Повторить сохранение черновика</button>}
      {unread && <div className={styles.backupActions}><button type="button" onClick={() => { const raw = worldLightingEditorStore.exportConflictedDraft(); if (raw) downloadStudioJson(raw, "world-studio-unread-draft.json"); }}>Скачать непрочитанный черновик</button><button type="button" onClick={() => setConfirmReset(true)}>Сбросить непрочитанный черновик</button></div>}
      {confirmReset && <div className={styles.confirmReset}><p>Сначала скачайте непрочитанный черновик. Сброс удалит его из этого браузера; файлы проекта не меняются.</p><button type="button" onClick={() => { worldLightingEditorStore.resetAll(); setConfirmReset(false); }}>Сбросить черновик</button><button type="button" onClick={() => setConfirmReset(false)}>Оставить черновик</button></div>}
      <p>{project.available ? "Локальный DEV автоматически записывает источники, объёмы и поверхности в карту Tiled и сгенерированный мир. Эти файлы затем можно сохранить в Git." : "Автосохранение в файлы доступно при запуске локального DEV проекта. Здесь сохраняется браузерный черновик; для переноса используйте резервную копию."}</p>
      {project.available && <label className={styles.toggle}><input type="checkbox" checked={!project.paused} onChange={event => project.setPaused(!event.target.checked)} />Автоматически сохранять в проект</label>}
      {project.error && (project.status === "error" || project.status === "conflict") && <p className={styles.error} role="alert">{project.error}</p>}
      {(project.status === "error" || project.status === "conflict") && <button type="button" onClick={() => void project.retry()}>Проверить и повторить</button>}
      {(project.status === "conflict" || unread) && !confirmProject && <button type="button" onClick={() => setConfirmProject(true)}>Загрузить версию проекта</button>}
      {confirmProject && <div className={styles.confirmReset}><p>Текущий черновик будет заменён версией из файлов проекта. Сначала скачаем его копию. Файлы проекта не изменятся.</p><button type="button" disabled={loadingProject} onClick={async () => {
        setLoadingProject(true); setError("");
        try {
          worldLightingEditorStore.commitGesture(); const raw = worldLightingEditorStore.exportConflictedDraft();
          downloadStudioJson(raw ?? worldLightingEditorStore.exportSceneBackup(), raw ? "world-studio-unread-draft.json" : "world-studio-backup.json");
          if (await project.loadProjectVersion()) { setConfirmProject(false); setNotice("Копия скачана. Загружена версия из файлов проекта."); }
          else setError("Версия проекта не загружена. Ваш черновик сохранён; проверьте сообщение и попробуйте ещё раз.");
        } catch { setError("Не удалось загрузить версию проекта. Ваш черновик сохранён."); }
        finally { setLoadingProject(false); }
      }}>Скачать копию и загрузить проект</button><button type="button" disabled={loadingProject} onClick={() => setConfirmProject(false)}>Оставить черновик</button></div>}
      <p>Если карта открыта в Tiled, сохраните и закройте её перед записью из студии. При внешних изменениях автосохранение остановится и предложит выбрать версию.</p>
      <h3>Резервная копия</h3><p>JSON содержит все источники света, объёмы и поверхности, включая уже сохранённые изменения. Скачивание копии не заменяет автосохранение.</p>
      <div className={styles.backupActions}><button type="button" onClick={() => { try { worldLightingEditorStore.commitGesture(); downloadStudioJson(worldLightingEditorStore.exportSceneBackup(), "world-studio-backup.json"); setError(""); setNotice("Резервная копия скачана."); } catch { setError("Не удалось скачать резервную копию."); } }}><Download size={14} aria-hidden />Скачать JSON</button><button type="button" onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden />Загрузить JSON</button></div>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setNotice(""); setError("");
        if (file.size > 1024 * 1024) { setError("Выберите файл размером до 1 МБ."); return; }
        try { if (worldLightingEditorStore.importPatch(await file.text())) setNotice("Копия загружена. Проверьте результат на карте."); else setError(worldLightingEditorStore.getSnapshot().error ?? "Копия не подходит к этой карте. Текущий черновик сохранён."); }
        catch { setError("Не удалось прочитать резервную копию."); }
      }} />
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
      <details><summary>Перенести несохранённые правки в Tiled вручную</summary><div className={styles.saveBody}><p>Патч содержит только правки относительно последней сохранённой версии проекта. Полную резервную копию загружайте обратно в студию.</p><button type="button" disabled={!dirty} onClick={() => { worldLightingEditorStore.commitGesture(); downloadStudioJson(worldLightingEditorStore.exportPatch(), "studio-patch.json"); setNotice("Патч для Tiled скачан."); }}>Скачать патч для Tiled</button><p>Сохраните и закройте карту в Tiled. Подставьте путь к скачанному патчу:</p><code>npm run world:lighting:apply -- ./studio-patch.json</code><code>npm run world:export</code><code>npm run world:check</code></div></details>
    </div></details>
  </section>;
}
