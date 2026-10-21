"use client";

import { ArrowLeft, ArrowRight, Bookmark, Check, Compass, X } from "lucide-react";
import type { EarthAtlasEntry } from "./earth-atlas";
import type { EarthAtlasJourneyAction, earthAtlasJourneyStop } from "./earth-atlas-journeys";
import type { EarthAtlasPreview } from "./earth-atlas-preview";
import styles from "./earth-atlas-explorer.module.css";

type Props = {
  entry: EarthAtlasEntry;
  journey: ReturnType<typeof earthAtlasJourneyStop>;
  opened: boolean;
  loaded: boolean;
  persistent?: boolean;
  preview: EarthAtlasPreview | null;
  onDiscover: () => void;
  onFocus: () => void;
  onClose: () => void;
  onNavigate: (action: EarthAtlasJourneyAction) => void;
  onBrowseStops: () => void;
};
const previewLabels: Record<EarthAtlasPreview["status"], string> = {
  moving: "Приближаем место…", loading: "Подготавливаем вид…", ready: "Можно сохранить в атлас",
  away: "Нажми на название, чтобы вернуться", unavailable: "Вид недоступен. Попробуй вернуться",
};

/** Nonmodal controls stay below the model; the camera measures this small card. */
export function EarthAtlasExplorer({ entry, journey, opened, loaded, persistent = true, preview, onDiscover, onFocus, onClose, onNavigate, onBrowseStops }: Props) {
  const currentPreview = preview?.entryId === entry.id ? preview : null;
  const ready = currentPreview?.status === "ready";
  const canSave = loaded && !opened && ready;
  const stopIndex = journey?.stopIndex ?? -1;
  const last = Boolean(journey && stopIndex === journey.journey.stops.length - 1);
  const temporary = opened && !persistent;
  const status = !loaded ? "Загружаем атлас…" : temporary ? "До закрытия карты · хранилище недоступно" : opened ? "Сохранено в атласе" : currentPreview ? previewLabels[currentPreview.status] : "Подготавливаем вид…";

  return <section className={styles.explorer} data-earth-atlas-explorer data-earth-camera-panel="bottom" data-entry-id={entry.id}
    data-preview-state={currentPreview?.status ?? "loading"} aria-label={journey ? "Текущая остановка маршрута" : "Место в атласе"}>
    <div className={styles.header}>
      <button type="button" className={styles.title} data-audio-cue="ui.click" onClick={onFocus} aria-label={`Показать на карте: ${entry.title}`}>
        <span className={styles.meta} data-temporary={temporary && journey ? true : undefined} title={temporary ? status : undefined}>{journey ? temporary || !ready && !opened ? status : journey.journey.title : entry.subtitle}</span>
        <strong><Compass size={15} aria-hidden="true" /><span>{entry.title}</span></strong>
      </button>
      <button type="button" className={styles.close} data-audio-cue="ui.close" onClick={onClose} aria-label={journey ? "Закрыть маршрут" : "Закрыть место"}><X size={18} aria-hidden="true" /></button>
    </div>
    <div className={styles.controls} data-journey={journey ? true : undefined}>
      {journey ? <>
        <button type="button" className={styles.navigation} data-audio-cue="ui.click" disabled={stopIndex <= 0}
          onClick={() => onNavigate({ type: "previous" })} aria-label="Предыдущая остановка" title="Предыдущая остановка"><ArrowLeft size={18} aria-hidden="true" /></button>
        <button type="button" className={styles.stops} data-audio-cue="ui.open" onClick={onBrowseStops}
          aria-label={`Все остановки маршрута: ${stopIndex + 1} из ${journey.journey.stops.length}`} title="Выбрать остановку">{stopIndex + 1}<span>/ {journey.journey.stops.length}</span></button>
        <button type="button" className={styles.navigation} data-audio-cue="ui.click" onClick={() => onNavigate(last ? { type: "stop" } : { type: "next" })}
          aria-label={last ? "Завершить маршрут" : "Следующая остановка"} title={last ? "Завершить маршрут" : "Следующая остановка"}>
          {last ? <Check size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
        </button>
      </> : <span className={styles.status} role="status">{status}</span>}
      <button type="button" className={styles.save} data-audio-cue="ui.click" disabled={!canSave}
        aria-label={opened ? `${entry.title}: сохранено в атласе` : `Сохранить в атлас: ${entry.title}`}
        title={opened ? "Уже сохранено" : !ready ? status : "Сохранить открытие на этом устройстве"}
        onClick={() => { if (canSave) onDiscover(); }}>
        {opened ? <Check size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}<span>{opened ? "Сохранено" : "Сохранить"}</span>
      </button>
    </div>
    {journey && <span className={styles.srOnly} role="status">Остановка {stopIndex + 1} из {journey.journey.stops.length}. {status}</span>}
  </section>;
}
