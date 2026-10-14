import { useSyncExternalStore } from "react";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { worldLightingEditorStore, type WorldLightingElementKind } from "./world-lighting-editor-store";
import styles from "./world-lighting-editor.module.css";

export function WorldStudioElementControls({ kind, id }: { kind: WorldLightingElementKind; id: string }) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const flags = snapshot.editorFlags[`${kind}:${id}`] ?? {};
  return <div className={styles.elementControls} aria-label="Видимость и блокировка разметки">
    <button type="button" aria-pressed={Boolean(flags.hidden)} onClick={() => worldLightingEditorStore.setElementFlags(kind, id, { hidden: !flags.hidden })}>
      {flags.hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}{flags.hidden ? "Показать разметку" : "Скрыть разметку"}
    </button>
    <button type="button" aria-pressed={Boolean(flags.locked)} onClick={() => worldLightingEditorStore.setElementFlags(kind, id, { locked: !flags.locked })}>
      {flags.locked ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />}{flags.locked ? "Разблокировать" : "Заблокировать"}
    </button>
    {flags.locked && <p className={styles.hint}>Правки этого элемента заблокированы. Разблокируйте его, чтобы изменить разметку.</p>}
  </div>;
}
