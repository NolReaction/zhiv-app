"use client";

import type { ReactNode } from "react";
import { Box, HardDriveDownload, Map, Satellite } from "lucide-react";
import type { EarthLightingMode } from "./globe-lighting";
import type { EarthSatelliteState } from "./satellite";
import type { EarthCacheSnapshot } from "./resource-cache";
import { EARTH_RUNTIME_DIRECTORY } from "./runtime-loader";
import { EARTH_WEATHER_ATTRIBUTION } from "@/lib/earth-weather-contract";
import { formatEarthLoadingBytes } from "./earth-loading";
import { EarthModelCredits } from "./earth-model-credits";
import styles from "./earth-map-info.module.css";

export type EarthMapInfoProps = {
  satelliteState: EarthSatelliteState;
  satelliteAvailable: boolean;
  isOnline: boolean;
  satelliteMessage: string;
  onMapModeChange: (satellite: boolean) => void;
  lightingMode: EarthLightingMode;
  onLightingModeChange: (mode: EarthLightingMode) => void;
  buildings3d: boolean;
  onToggleBuildings: () => void;
  cache: Pick<EarthCacheSnapshot, "storage" | "persistence" | "storedBytes" | "diskLimitBytes">;
  persisting: boolean;
  onPersist: () => void;
  locationDetails?: ReactNode;
};

/** Frequent settings stay small. Help, local storage and complete credits are
 * available on demand; the map's always-visible attribution remains separate.
 */
export function EarthMapInfo({ satelliteState, satelliteAvailable, isOnline, satelliteMessage, onMapModeChange,
  lightingMode, onLightingModeChange, buildings3d, onToggleBuildings, cache, persisting, onPersist, locationDetails }: EarthMapInfoProps) {
  const showSatelliteStatus = satelliteState.enabled && satelliteState.status !== "ready" || satelliteState.error !== null;
  return <div className={styles.info}>
    <div className={styles.controls} data-earth-info-controls>
      <div className={styles.setting}>
        <span className={styles.label}>Подложка</span>
        <div className={styles.mapModes} role="group" aria-label="Подложка карты">
          <button type="button" aria-pressed={!satelliteState.enabled} onClick={() => onMapModeChange(false)}><Map size={16} aria-hidden="true" />Карта</button>
          <button type="button" aria-pressed={satelliteState.enabled} disabled={!satelliteAvailable || !isOnline && !satelliteState.enabled}
            onClick={() => onMapModeChange(true)}><Satellite size={16} aria-hidden="true" />Спутник</button>
        </div>
        {showSatelliteStatus && <p className={styles.status} role="status">{satelliteMessage}</p>}
      </div>
      <div className={styles.setting}>
        <span className={styles.label}>Освещение</span>
        <div className={styles.lightingModes} role="group" aria-label="Освещение глобуса">
          {([ ["auto", "Авто"], ["day", "День"], ["evening", "Вечер"] ] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={lightingMode === value}
              onClick={() => { if (lightingMode !== value) onLightingModeChange(value); }}>{label}</button>)}
        </div>
      </div>
      <div className={styles.buildings}>
        <span id="earth-buildings-label"><Box size={16} aria-hidden="true" />Объёмные здания</span>
        <button type="button" data-audio-cue="ui.click" className={styles.toggle} role="switch" aria-checked={buildings3d}
          aria-labelledby="earth-buildings-label" onClick={onToggleBuildings}><span aria-hidden="true" /></button>
      </div>
      {satelliteState.imageryVisible && <p className={styles.status}>3D-настройка сохранена для обычной карты.</p>}
    </div>
    <details className={styles.details} data-earth-info-details>
      <summary>Подробнее и источники</summary>
      <div className={styles.more}>
        <section><h3>Управление картой</h3>
          <p>Два пальца вверх или вниз — наклон; сведение и разведение — масштаб. Мышью наклоняйте с зажатой правой кнопкой.</p>
          <p>Объёмные здания появляются вблизи. На спутнике здания и миниатюры скрыты, чтобы не закрывать снимок.</p>
          <p>{lightingMode === "auto" ? "Светлая и тёмная стороны следуют времени суток." : lightingMode === "evening"
            ? "Вечер остаётся на выбранной стороне Земли." : "Светлый глобус, чтобы рассмотреть детали."}</p>
        </section>
        {locationDetails}
        <section><h3>На устройстве</h3>
          <strong className={styles.storage}>{cache.storage === "device"
            ? `Сохранено ${formatEarthLoadingBytes(cache.storedBytes)} из ${formatEarthLoadingBytes(cache.diskLimitBytes)}`
            : cache.storage === "checking" ? "Проверяем хранилище…" : "Доступно в этой сессии"}
            {cache.persistence === "granted" && cache.storage === "device" ? " · Закреплено" : ""}</strong>
          <p>{cache.storage === "device" ? "Кеш ограничен. Текущий район и часто открываемые места сохраняются в первую очередь; новые участки загружаются при просмотре."
            : "После закрытия страницы часть данных потребуется загрузить заново."}</p>
          {cache.storage === "device" && cache.persistence !== "granted" && <button type="button" className={styles.action}
            data-audio-cue="ui.click" onClick={onPersist} disabled={persisting}><HardDriveDownload size={16} aria-hidden="true" />{persisting ? "Сохраняем…" : "Закрепить карту"}</button>}
        </section>
        <section><h3>Источники карты</h3>
          <p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>{" · "}
            <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{" · "}
            <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">OpenMapTiles</a>{" · "}
            <a href="https://www.naturalearthdata.com" target="_blank" rel="noreferrer">Natural Earth</a></p>
          <p>Данные OpenStreetMap · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ODbL</a>, дизайн схемы OpenMapTiles · <a href="https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md" target="_blank" rel="noreferrer">CC BY 4.0</a>. Natural Earth · общественное достояние. Оформление карты изменено для «Я живой».</p>
          <p>Движок: <a href={`${EARTH_RUNTIME_DIRECTORY}/LICENSE.txt`} target="_blank" rel="noreferrer">MapLibre GL JS и лицензии компонентов</a>.</p>
          <p>Погода: <a href={EARTH_WEATHER_ATTRIBUTION.sourceUrl} target="_blank" rel="noreferrer">{EARTH_WEATHER_ATTRIBUTION.name}</a>{" · "}
            <a href={EARTH_WEATHER_ATTRIBUTION.licenseUrl} target="_blank" rel="noreferrer">{EARTH_WEATHER_ATTRIBUTION.license}</a>. Упрощённая визуализация для «Я живой».</p>
        </section>
        <section><h3>3D-модели</h3><EarthModelCredits /></section>
      </div>
    </details>
  </div>;
}
