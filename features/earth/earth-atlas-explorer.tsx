"use client";

import { Bookmark, Check, Compass, X } from "lucide-react";
import type { EarthAtlasEntry } from "./earth-atlas";
import type { EarthAtlasPreview } from "./earth-atlas-preview";
import styles from "./earth-atlas-explorer.module.css";

type Props = {
  entry: EarthAtlasEntry;
  opened: boolean;
  loaded: boolean;
  persistent?: boolean;
  preview: EarthAtlasPreview | null;
  onDiscover: () => void;
  onFocus: () => void;
  onClose: () => void;
};
const previewLabels: Record<EarthAtlasPreview["status"], string> = {
  moving: "Приближаем место…", loading: "Подготавливаем вид…", ready: "Можно сохранить в атлас",
  away: "Нажми на название, чтобы вернуться", unavailable: "Вид недоступен. Попробуй вернуться",
};

/** A single nonmodal place card stays below its model. */
export function EarthAtlasExplorer({ entry, opened, loaded, persistent = true, preview, onDiscover, onFocus, onClose }: Props) {
  if (entry.kind !== "landmark") return null;
  const currentPreview = preview?.entryId === entry.id ? preview : null;
  const ready = currentPreview?.status === "ready";
  const canSave = loaded && !opened && ready;
  const temporary = opened && !persistent;
  const status = !loaded ? "Загружаем атлас…" : temporary ? "До закрытия карты · хранилище недоступно" : opened ? "Сохранено в атласе" : currentPreview ? previewLabels[currentPreview.status] : "Подготавливаем вид…";

  return <section className={styles.explorer} data-earth-atlas-explorer data-earth-camera-panel="bottom" data-entry-id={entry.id}
    data-preview-state={currentPreview?.status ?? "loading"} aria-label="Место в атласе">
    <div className={styles.header}>
      <button type="button" className={styles.title} data-audio-cue="ui.click" onClick={onFocus} aria-label={`Показать на карте: ${entry.title}`}>
        <strong><Compass size={15} aria-hidden="true" /><span>{entry.title}</span></strong>
      </button>
      <button type="button" className={styles.close} data-audio-cue="ui.close" onClick={onClose} aria-label="Закрыть место"><X size={18} aria-hidden="true" /></button>
    </div>
    <div className={styles.controls}>
      <span className={styles.status} role="status">{status}</span>
      <button type="button" className={styles.save} data-audio-cue="ui.click" disabled={!canSave}
        aria-label={opened ? `${entry.title}: сохранено в атласе` : `Сохранить в атлас: ${entry.title}`}
        title={opened ? "Уже сохранено" : !ready ? status : "Сохранить открытие на этом устройстве"}
        onClick={() => { if (canSave) onDiscover(); }}>
        {opened ? <Check size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}<span>{opened ? "Сохранено" : "Сохранить"}</span>
      </button>
    </div>
  </section>;
}
