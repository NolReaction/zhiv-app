import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { worldLightingEditorStore, type WorldLightingElementKind } from "./world-lighting-editor-store";
import { buildWorldStudioOutliner, studioFolderOptions } from "./world-studio-outliner";
import { WORLD_STUDIO_UI_EVENT } from "./world-studio-keyboard";
import styles from "./world-lighting-editor.module.css";

type StudioMetadataElement = { id: string; studioName?: string; studioFolder?: string };

/** Editor names and folders are metadata; IDs, positions and level conditions remain unchanged. */
export function WorldStudioMetadata({ kind, element, automaticName, levels = {} }: {
  kind: WorldLightingElementKind; element: StudioMetadataElement; automaticName: string; levels?: Readonly<Record<string, number>>;
}) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const nameId = useId(), pathId = useId();
  const nameInput = useRef<HTMLInputElement>(null), pathInput = useRef<HTMLInputElement>(null), pendingName = useRef<string | null>(null), initialName = useRef("");
  const [nameEntry, setNameEntry] = useState<string | null>(null), [customPath, setCustomPath] = useState(""), [folderError, setFolderError] = useState("");
  const options = useMemo(() => studioFolderOptions(buildWorldStudioOutliner(snapshot, levels)), [snapshot, levels]);
  const locked = snapshot.editorFlags[`${kind}:${element.id}`]?.locked;
  const cancelName = () => { pendingName.current = null; setNameEntry(null); nameInput.current?.blur(); };
  const cancelPath = () => { setCustomPath(""); setFolderError(""); pathInput.current?.blur(); };
  useEffect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent).detail, target = detail?.target;
      if (detail?.action === "rename" && !nameInput.current?.disabled && !nameInput.current?.closest("fieldset:disabled")) {
        requestAnimationFrame(() => { nameInput.current?.focus(); nameInput.current?.select(); }); return;
      }
      if (detail?.action !== "cancel-input") return;
      if (target === nameInput.current) { pendingName.current = null; setNameEntry(null); nameInput.current?.blur(); }
      if (target === pathInput.current) { setCustomPath(""); setFolderError(""); pathInput.current?.blur(); }
    };
    window.addEventListener(WORLD_STUDIO_UI_EVENT, command);
    return () => {
      window.removeEventListener(WORLD_STUDIO_UI_EVENT, command);
      // Selecting on the canvas can unmount the inspector before the browser's blur event.
      const entry = pendingName.current; pendingName.current = null;
      if (entry !== null && entry.trim() !== initialName.current) worldLightingEditorStore.setElementMetadata(kind, element.id, { studioName: entry.trim() || null });
    };
  }, [kind, element.id]);
  const commitName = () => {
    const entry = pendingName.current; pendingName.current = null; setNameEntry(null);
    if (entry !== null && entry.trim() !== initialName.current) worldLightingEditorStore.setElementMetadata(kind, element.id, { studioName: entry.trim() || null });
  };
  const createFolder = () => {
    const segments = customPath.split("/").map(segment => segment.trim()), folder = `custom:${segments.join("/")}`;
    if (!customPath.trim() || folder.length > 256 || segments.length > 8 || segments.some(segment => !segment || segment.length > 64 || segment === "." || segment === "..") || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(customPath)) {
      setFolderError("Укажите путь из 1–8 папок через /. Название каждой — до 64 символов; пустые части, . и .. не подходят."); return;
    }
    if (!worldLightingEditorStore.setElementMetadata(kind, element.id, { studioFolder: folder })) {
      setFolderError(worldLightingEditorStore.getSnapshot().error ?? "Не удалось перенести элемент. Повторите действие в черновике."); return;
    }
    setFolderError(""); setCustomPath("");
  };
  return <fieldset className={styles.metadata} disabled={!snapshot.enabled || !snapshot.previewDraft || locked} aria-label="Имя и папка элемента">
    <legend className={styles.srOnly}>Имя и папка</legend>
    <label className={styles.field} htmlFor={nameId}><span>Имя элемента</span><input ref={nameInput} id={nameId} type="text" data-studio-text-field="name" maxLength={128}
      value={nameEntry ?? element.studioName ?? automaticName} onFocus={event => { initialName.current = event.target.value; pendingName.current = event.target.value; setNameEntry(event.target.value); }}
      onChange={event => { pendingName.current = event.target.value; setNameEntry(event.target.value); }} onBlur={commitName}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelName(); }
      }} /></label>
    <label className={styles.field}><span>Папка в списке</span><select value={element.studioFolder ?? ""} onChange={event => worldLightingEditorStore.setElementMetadata(kind, element.id, { studioFolder: event.target.value || null })}>
      <option value="">Автоматическая папка</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      {element.studioFolder && !options.some(option => option.id === element.studioFolder) && <option value={element.studioFolder}>{element.studioFolder.replace(/^custom:/, "")}</option>}
    </select></label>
    <details className={styles.details}><summary>Имя, папки и ID</summary><div className={styles.detailsBody}>
      <p className={styles.hint}>Enter или выход из поля сохраняет имя; Escape отменяет ввод. F2 выбирает имя целиком. Пустое имя возвращает автоматическое.</p>
      <p className={styles.elementId}>ID: <code>{element.id}</code></p>
      <details className={styles.details}><summary>Новая папка</summary><div className={styles.detailsBody}>
      <label className={styles.field} htmlFor={pathId}><span>Путь новой папки</span><input ref={pathInput} id={pathId} type="text" data-studio-text-field="folder" placeholder="Поляна/Дом" maxLength={249} value={customPath} aria-invalid={Boolean(folderError) || undefined} aria-describedby={folderError ? `${pathId}-error` : undefined}
        onChange={event => { setCustomPath(event.target.value); setFolderError(""); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); createFolder(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelPath(); }
        }} /></label>
      <button type="button" disabled={!customPath.trim()} onClick={createFolder}>Создать и перенести</button>
      {folderError && <p id={`${pathId}-error`} className={styles.fieldError} role="status">{folderError}</p>}
      <p className={styles.hint}>Разделяйте вложенные папки через /. Папка существует, пока в ней есть элементы.</p>
      </div></details>
      <p className={styles.hint}>Папки меняют только порядок в списке. Положение на карте и условия уровня здания сохраняются. Выключенные источники остаются в папке удалённых до включения.</p>
    </div></details>
  </fieldset>;
}
