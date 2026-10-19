"use client";

import { Check, CloudOff, Download, Globe2, HardDriveDownload, RefreshCw, TriangleAlert } from "lucide-react";
import styles from "./earth-loading.module.css";

export type EarthLoadingStage = "engine" | "resources" | "render";

export type EarthLoadingProgress = {
  completed: number;
  pending: number;
  failed?: number;
  bytes: number;
  cacheHits: number;
};

export type EarthLoadingProps = {
  stage: EarthLoadingStage;
  progress?: EarthLoadingProgress;
  restoring?: boolean;
  isOnline: boolean;
  error?: string | null;
  storageStatus?: "device" | "session" | "checking";
  persistentGranted?: boolean;
  persisting?: boolean;
  onRetry?: () => void;
  onPersist?: () => void;
};

const stages: { key: EarthLoadingStage; label: string; description: string }[] = [
  { key: "engine", label: "Подготовка", description: "Подготавливаем карту к запуску" },
  { key: "resources", label: "Загрузка", description: "Загружаем нужные участки и подписи" },
  { key: "render", label: "Отрисовка", description: "Собираем готовое изображение" },
];

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function formatEarthLoadingBytes(value: number): string {
  const bytes = count(value);
  if (bytes < 1_024) return `${bytes.toLocaleString("ru-RU")} Б`;
  const unit = bytes < 1_048_576 ? "КБ" : "МБ";
  const divisor = unit === "КБ" ? 1_024 : 1_048_576;
  return `${(bytes / divisor).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${unit}`;
}

/** Covers the map until its actual startup work has finished; it does not estimate a percentage. */
export function EarthLoading({ stage, progress, restoring = false, isOnline, error,
  storageStatus = "checking", persistentGranted = false, persisting = false, onRetry, onPersist }: EarthLoadingProps) {
  const stageIndex = stages.findIndex(item => item.key === stage);
  const currentStage = stages[stageIndex];
  const interrupted = Boolean(error);
  const title = error ? "Карта пока не готова" : restoring ? "Открываем сохранённую карту" : "Готовим карту";
  const message = error || (!isOnline
    ? restoring ? "Читаем сохранённые данные. Для недостающих участков понадобится интернет." : "Подключитесь к интернету, чтобы получить недостающие данные."
    : currentStage.description);
  const hasProgress = progress && (count(progress.completed) > 0 || count(progress.pending) > 0 || count(progress.bytes) > 0 || count(progress.cacheHits) > 0);
  const canPersist = storageStatus === "device" && !persistentGranted && Boolean(onPersist);
  const StatusIcon = error ? TriangleAlert : !isOnline ? CloudOff : Globe2;

  return <section className={styles.overlay} aria-label={title} aria-busy={!interrupted}>
    <div className={styles.content} data-interrupted={interrupted || undefined}>
      <div className={styles.emblem} aria-hidden="true"><StatusIcon size={36} strokeWidth={1.35} /></div>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>ПЛАНЕТА ЖИВОЙ</span>
        <h2>{title}</h2>
      </div>
      <p className={styles.message} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">{message}</p>

      <ol className={styles.steps} aria-label="Подготовка карты">
        {stages.map((item, index) => <li key={item.key} data-state={index < stageIndex ? "complete" : index === stageIndex ? "current" : "pending"}
          aria-current={index === stageIndex ? "step" : undefined}>
          <span className={styles.stepIcon} aria-hidden="true">{index < stageIndex ? <Check size={12} /> : index + 1}</span>
          <span>{item.label}</span>
        </li>)}
      </ol>

      {hasProgress && <div className={styles.progress} aria-label="Загруженные данные">
        <p className={styles.counts}>
          <span>Готово <strong>{count(progress.completed).toLocaleString("ru-RU")}</strong></span>
          {count(progress.pending) > 0 && <span>В работе <strong>{count(progress.pending).toLocaleString("ru-RU")}</strong></span>}
          {count(progress.failed ?? 0) > 0 && <span className={styles.failed}>Не загружено <strong>{count(progress.failed ?? 0).toLocaleString("ru-RU")}</strong></span>}
        </p>
        <p className={styles.transfer}><Download size={12} aria-hidden="true" /><span>Получено {formatEarthLoadingBytes(progress.bytes)}</span>
          {count(progress.cacheHits) > 0 && <span>Из сохранённого: {count(progress.cacheHits).toLocaleString("ru-RU")}</span>}
        </p>
      </div>}

      <div className={styles.storage}>
        {storageStatus === "checking" ? <p>Проверяем сохранённые данные…</p>
          : storageStatus === "session" ? <p>Память устройства недоступна. После закрытия страницы загрузка может понадобиться снова.</p>
            : <><p>Загруженные участки сохраняются на устройстве.</p>
              <p className={styles.storageDetail}>{persistentGranted ? "Карта закреплена. Очистка данных браузера удалит её." : "Браузер может освободить это место при нехватке памяти."}</p></>}
      </div>

      {(onRetry && interrupted || canPersist) && <div className={styles.actions}>
        {onRetry && interrupted && <button type="button" className={styles.retry} onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />{isOnline ? "Продолжить загрузку" : "Открыть сохранённое"}
        </button>}
        {canPersist && <button type="button" className={styles.persist} onClick={onPersist} disabled={persisting}>
          <HardDriveDownload size={15} aria-hidden="true" />{persisting ? "Запрашиваем сохранение…" : "Закрепить на устройстве"}
        </button>}
      </div>}
    </div>
  </section>;
}
