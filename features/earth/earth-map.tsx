"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Compass, Earth, HardDriveDownload, LocateFixed, Minus, Plus } from "lucide-react";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import type { EarthPosition } from "./location";
import { EARTH_ACCURACY_SOURCE, EARTH_CENTER, EARTH_SKY, EARTH_STYLE_URL, globeZoom, positionAccuracyData, positionZoom, prepareEarthStyle } from "./map-style";
import { EarthLoading, formatEarthLoadingBytes, type EarthLoadingStage } from "./earth-loading";
import { EARTH_CACHE_PROTOCOL, earthResourceCache } from "./resource-cache";
import { loadEarthRuntime } from "./runtime-loader";
import { getEarthErrorResourceUrls } from "./resource-recovery";
import { refreshEarthTileSource } from "./source-recovery";
import { createEarthTileRecovery, type EarthTileRecoveryStatus } from "./tile-recovery";
import { appendEarthTileBase, isEarthTileIndexUrl, isEarthVectorTileUrl, prepareEarthTileIndex } from "./tile-base";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./earth-map.module.css";

type MapPhase = "loading" | "ready" | "failed" | "unsupported";

type EarthMapProps = {
  position: EarthPosition | null;
  active: boolean;
  focusRequest: number;
  isOnline: boolean;
};

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canRenderGlobe(): boolean {
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function flyToPosition(map: LibreMap, position: EarthPosition) {
  map.flyTo({
    center: [position.longitude, position.latitude],
    zoom: positionZoom(position.accuracy),
    pitch: 0,
    bearing: 0,
    duration: reducedMotion() ? 0 : 1600,
    essential: false,
  });
}

export function EarthMap({ position, active, focusRequest, isOnline }: EarthMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const syncPositionRef = useRef<((value: EarthPosition | null) => void) | null>(null);
  const latestPosition = useRef(position);
  const savedCamera = useRef<{ center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const handledFocus = useRef(0);
  const repairs = useRef<Promise<unknown>>(Promise.resolve());
  const retrying = useRef(false);
  const tileRecoveryRef = useRef<ReturnType<typeof createEarthTileRecovery> | null>(null);
  const [phase, setPhase] = useState<MapPhase>("loading");
  const [stage, setStage] = useState<EarthLoadingStage>("engine");
  const [failure, setFailure] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [tileStatus, setTileStatus] = useState<EarthTileRecoveryStatus>("idle");
  const cache = useSyncExternalStore(earthResourceCache.subscribe, earthResourceCache.getSnapshot, earthResourceCache.getSnapshot);
  const phaseRef = useRef(phase);
  const activeRef = useRef(active);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const persistMap = useCallback(async () => {
    setPersisting(true);
    try { await earthResourceCache.requestPersistence(); }
    finally { setPersisting(false); }
  }, []);

  const retryMap = useCallback(async () => {
    if (retrying.current) return;
    retrying.current = true;
    setPhase("loading");
    setFailure(null);
    setStage("engine");
    setTileStatus("idle");
    try { await repairs.current; }
    finally { retrying.current = false; setRetry(value => value + 1); }
  }, []);

  useEffect(() => {
    const reconnect = () => {
      if (phaseRef.current === "failed") void retryMap();
      else tileRecoveryRef.current?.retry();
    };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [retryMap]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) mapRef.current?.stop();
    else mapRef.current?.resize();
  }, [active]);

  useEffect(() => {
    latestPosition.current = position;
    syncPositionRef.current?.(position);
  }, [position]);

  useEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    let cancelled = false;
    const controller = new AbortController();
    let map: LibreMap | null = null;
    let marker: Marker | null = null;
    let initialReady = false;
    let attemptFailed = false;
    let styleReady = false;
    let idle = false;
    let timeout = 0;
    let unsubscribe: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let tileRecovery: ReturnType<typeof createEarthTileRecovery> | null = null;

    function resize() {
      if (!cancelled && map && activeRef.current && !document.hidden && element!.clientWidth && element!.clientHeight) map.resize();
    }
    function visibilityChanged() {
      if (document.hidden) { window.clearTimeout(timeout); map?.stop(); }
      else { armDeadline(); resize(); }
      tileRecovery?.check();
    }
    function fail(message: string) {
      if (cancelled || attemptFailed) return;
      attemptFailed = true;
      controller.abort();
      window.clearTimeout(timeout);
      map?.stop();
      setFailure(message);
      setPhase("failed");
    }
    function contextLost() {
      fail("Браузер приостановил графику карты. Попробуйте открыть её снова; доступные сохранённые файлы будут использованы повторно.");
    }
    function armDeadline() {
      window.clearTimeout(timeout);
      if (!document.hidden && !initialReady && !attemptFailed) timeout = window.setTimeout(() =>
        fail("Подготовка занимает слишком много времени. Продолжите загрузку: доступные сохранённые файлы будут использованы повторно."), 180_000);
    }
    function checkReady() {
      if (cancelled || attemptFailed || initialReady || !map || !styleReady) return;
      const progress = earthResourceCache.getSnapshot();
      if (progress.failed > 0) {
        fail("Не удалось получить часть карты. Продолжите загрузку, когда появится связь; доступные сохранённые файлы будут использованы повторно.");
        return;
      }
      if (progress.pending === 0) setStage("render");
      // MapLibre treats errored tiles as settled; its load/idle events alone are insufficient.
      if (idle && progress.pending === 0 && map.loaded() && map.areTilesLoaded()) {
        initialReady = true;
        window.clearTimeout(timeout);
        setPhase("ready");
      }
    }

    async function initialize() {
      try {
        earthResourceCache.resetProgress();
        await earthResourceCache.initialize();
        if (cancelled || attemptFailed) return;
        // Ask the browser to protect this explicitly requested map installation from automatic eviction.
        if (earthResourceCache.getSnapshot().persistence === "unknown") void earthResourceCache.requestPersistence();
        setRestoring(earthResourceCache.getSnapshot().storedEntries > 0);
        setPhase("loading");
        setFailure(null);
        setStage("engine");
        setTileStatus("idle");
        if (!canRenderGlobe()) {
          window.clearTimeout(timeout);
          attemptFailed = true;
          setPhase("unsupported");
          return;
        }
        const sdk = await loadEarthRuntime({ signal: controller.signal });
        if (cancelled || attemptFailed) return;
        sdk.addProtocol(EARTH_CACHE_PROTOCOL, async (parameters, requestController) => {
          const response = await earthResourceCache.protocol(parameters, requestController);
          if (isEarthTileIndexUrl(parameters.url)) return { ...response, data: prepareEarthTileIndex(response.data) };
          if (response.data instanceof ArrayBuffer && isEarthVectorTileUrl(parameters.url)) {
            // A successful detail tile covers its own area; missing neighbors retain the local world silhouette.
            return { ...response, data: appendEarthTileBase(response.data) };
          }
          return response;
        });
        sdk.setMaxParallelImageRequests(4);
        setStage("resources");
        // Style data and every subsequent source/sprite/tile request use the same durable cache.
        let style;
        try { style = prepareEarthStyle((await earthResourceCache.readResource(EARTH_STYLE_URL, "json", controller.signal)).data); }
        catch (error) {
          if (!controller.signal.aborted) await earthResourceCache.invalidate(EARTH_STYLE_URL);
          throw error;
        }
        if (cancelled || attemptFailed) return;
        map = new sdk.Map({
          container: element!,
          style,
          transformRequest: earthResourceCache.transformRequest,
          center: savedCamera.current?.center ?? EARTH_CENTER,
          zoom: savedCamera.current?.zoom ?? globeZoom(element!.clientWidth, element!.clientHeight),
          bearing: savedCamera.current?.bearing ?? 0,
          pitch: savedCamera.current?.pitch ?? 0,
          minZoom: -1.5,
          maxZoom: 18,
          maxPitch: 60,
          // Keep useful parent detail while zooming; the persistent cache handles revisits.
          cancelPendingTileRequestsWhileZooming: false,
          maxTileCacheSize: 96,
          attributionControl: false,
          renderWorldCopies: false,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          fadeDuration: reducedMotion() ? 0 : 200,
          locale: {
            "AttributionControl.ToggleAttribution": "Источники карты",
            "Map.Title": "Карта Земли",
            "Map.MapInstructions": "Перетаскивайте глобус. Стрелки перемещают карту; плюс и минус меняют масштаб.",
          },
        });
        const current = map;
        mapRef.current = current;
        tileRecovery = createEarthTileRecovery({
          readState: () => {
            const progress = earthResourceCache.getSnapshot();
            return { enabled: initialReady && !attemptFailed && !cancelled, visible: !document.hidden && activeRef.current,
              online: navigator.onLine, moving: current.isMoving(), ready: current.loaded() && current.areTilesLoaded(),
              pending: progress.pending, progress: progress.completed };
          },
          sources: () => Object.entries(current.getStyle()?.sources ?? {})
            .filter(([, source]) => source.type === "vector" || source.type === "raster").map(([id]) => id),
          refresh: async (targets, signal) => {
            await repairs.current;
            if (signal.aborted || cancelled) return;
            for (const target of targets) {
              if (refreshEarthTileSource(current, target) && !target.tiles) current.setSourceTileLodParams(4, 2, target.sourceId);
            }
          },
          onChange: status => { if (!cancelled) setTileStatus(status); },
        });
        tileRecoveryRef.current = tileRecovery;
        unsubscribe = earthResourceCache.subscribe(() => { checkReady(); tileRecovery?.check(); });
        current.on("remove", () => {
          // Release the GPU while playing; a return starts from cached data and the saved camera.
          if (!activeRef.current) { setPhase("loading"); setStage("engine"); }
        });
        current.addControl(new sdk.AttributionControl({ compact: false }), "bottom-left");
        current.addControl(new sdk.ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-right");
        canvas = current.getCanvas();
        canvas.setAttribute("aria-label", "Карта Земли. Перетаскивайте глобус, приближайте двумя пальцами или колёсиком. Стрелки перемещают карту; плюс и минус меняют масштаб.");
        canvas.addEventListener("webglcontextlost", contextLost);

        const syncPosition = (value: EarthPosition | null) => {
          if (cancelled) return;
          const source = current.getSource<GeoJSONSource>(EARTH_ACCURACY_SOURCE);
          source?.setData(positionAccuracyData(value));
          if (!value) {
            marker?.remove();
            marker = null;
            return;
          }
          if (!source) return;
          if (!marker) {
            const pin = document.createElement("div");
            pin.className = styles.positionMarker;
            pin.setAttribute("role", "img");
            pin.setAttribute("aria-label", "Ваше местоположение");
            const dot = document.createElement("span");
            dot.className = styles.positionDot;
            const label = document.createElement("span");
            label.className = styles.positionLabel;
            label.textContent = "Вы здесь";
            pin.append(dot, label);
            marker = new sdk.Marker({ element: pin, anchor: "center", subpixelPositioning: true, opacityWhenCovered: 0 })
              .setLngLat([value.longitude, value.latitude]).addTo(current);
          }
          marker.setLngLat([value.longitude, value.latitude]);
        };
        syncPositionRef.current = syncPosition;

        current.on("style.load", () => {
          if (cancelled) return;
          styleReady = true;
          // Style replacement discards projection, atmosphere and our own layers.
          current.setProjection({ type: "globe" });
          current.setSky(EARTH_SKY);
          // Reduce distant high-pitch detail before asking the device to decode more tiles.
          current.setSourceTileLodParams(4, 2);
          current.addSource(EARTH_ACCURACY_SOURCE, { type: "geojson", data: positionAccuracyData(latestPosition.current) });
          current.addLayer({
            id: "earth-accuracy-fill", type: "fill", source: EARTH_ACCURACY_SOURCE,
            paint: { "fill-color": "#197d79", "fill-opacity": 0.16 },
          });
          current.addLayer({
            id: "earth-accuracy-line", type: "line", source: EARTH_ACCURACY_SOURCE,
            paint: { "line-color": "#166f70", "line-opacity": 0.75, "line-width": 1.5 },
          });
          syncPosition(latestPosition.current);
        });
        current.on("dataloading", () => { idle = false; });
        current.on("movestart", () => { idle = false; tileRecovery?.check(); });
        current.on("moveend", () => tileRecovery?.check());
        current.on("load", checkReady);
        current.on("idle", () => { idle = true; checkReady(); tileRecovery?.check(true); });
        current.on("error", event => {
          if (cancelled) return;
          const resources = getEarthErrorResourceUrls(event, current);
          if (resources.length) repairs.current = repairs.current.then(() =>
            Promise.all(resources.map(url => earthResourceCache.invalidate(url)))).catch(() => undefined);
          if (initialReady) tileRecovery?.reportFailure({
            sourceId: "sourceId" in event ? event.sourceId : undefined,
            tile: "tile" in event ? event.tile : undefined,
          });
          else fail("Не удалось подготовить карту целиком. Продолжите загрузку: доступные сохранённые файлы будут использованы повторно.");
        });

        resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
        resizeObserver?.observe(element!);
        if (!resizeObserver) window.addEventListener("resize", resize);
        intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) resize();
          else current.stop();
        });
        intersectionObserver?.observe(element!);
      } catch {
        if (!cancelled) fail("Загрузка прервалась. Проверьте подключение и продолжите: сохранённые файлы будут использованы повторно.");
      }
    }
    // This deadline includes engine installation and body writes, rather than revealing a half-loaded canvas.
    document.addEventListener("visibilitychange", visibilityChanged);
    armDeadline();
    void initialize();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      unsubscribe?.();
      tileRecovery?.dispose();
      if (tileRecoveryRef.current === tileRecovery) tileRecoveryRef.current = null;
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibilityChanged);
      canvas?.removeEventListener("webglcontextlost", contextLost);
      syncPositionRef.current = null;
      marker?.remove();
      map?.stop();
      if (map) {
        const center = map.getCenter();
        savedCamera.current = { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      }
      map?.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [active, retry]);

  useEffect(() => {
    if (!active || phase !== "ready" || !position || !mapRef.current || focusRequest <= handledFocus.current) return;
    handledFocus.current = focusRequest;
    flyToPosition(mapRef.current, position);
  }, [active, phase, position, focusRequest]);

  const ready = active && phase === "ready";
  return <div className={styles.root} data-earth-map data-map-status={phase}>
    <div ref={host} className={styles.canvas} data-visible={phase === "ready"} aria-hidden={phase !== "ready"} inert={phase !== "ready" || undefined} />
    <div className={styles.controls} role="group" aria-label="Управление картой">
      <button type="button" disabled={!ready} title="Показать всю Землю" aria-label="Показать всю Землю" onClick={() => {
        const current = mapRef.current;
        const element = host.current;
        if (current && element) current.flyTo({ center: EARTH_CENTER, zoom: globeZoom(element.clientWidth, element.clientHeight), bearing: 0, pitch: 0, duration: reducedMotion() ? 0 : 1200, essential: false });
      }}><Earth size={21} aria-hidden="true" /></button>
      <button type="button" disabled={!ready} title="Приблизить" aria-label="Приблизить карту" onClick={() => mapRef.current?.zoomIn({ duration: reducedMotion() ? 0 : 250 })}><Plus size={21} aria-hidden="true" /></button>
      <button type="button" disabled={!ready} title="Отдалить" aria-label="Отдалить карту" onClick={() => mapRef.current?.zoomOut({ duration: reducedMotion() ? 0 : 250 })}><Minus size={21} aria-hidden="true" /></button>
      <button type="button" disabled={!ready} title="Север сверху" aria-label="Повернуть карту севером вверх" onClick={() => mapRef.current?.resetNorthPitch({ duration: reducedMotion() ? 0 : 400 })}><Compass size={21} aria-hidden="true" /></button>
      <button type="button" disabled={!ready || !position} title={position ? "К моему местоположению" : "Сначала определите местоположение"} aria-label="Показать моё местоположение" onClick={() => {
        if (mapRef.current && position) flyToPosition(mapRef.current, position);
      }}><LocateFixed size={21} aria-hidden="true" /></button>
    </div>
    {phase !== "ready" && <EarthLoading stage={stage} restoring={restoring} isOnline={isOnline}
      progress={{ completed: cache.completed, pending: cache.pending, failed: cache.failed, bytes: cache.networkBytes, cacheHits: cache.cacheHits }}
      error={phase === "unsupported" ? "Для глобуса нужен WebGL 2. Обновите браузер или включите аппаратное ускорение." : failure}
      storageStatus={cache.storage} persistentGranted={cache.persistence === "granted"} persisting={persisting}
      onPersist={persistMap} onRetry={phase === "unsupported" ? undefined : retryMap} />}
    {ready && tileStatus !== "idle" && <div className={styles.networkNotice} role="status">
      <span>{!isOnline || tileStatus === "failed" ? "Часть деталей пока недоступна" : "Восстанавливаем детали карты…"}</span>
      <button type="button" disabled={!isOnline || tileStatus === "retrying"} onClick={() => tileRecoveryRef.current?.retry()}>Повторить</button>
    </div>}
    {ready && tileStatus === "idle" && <p className={styles.gestureHint}>{cache.pending > 0 ? "Загружаем новый участок…" : "Вращайте Землю · приближайте города"}</p>}
    {ready && tileStatus === "idle" && <div className={styles.storageNotice} title={cache.storage === "device" ? "Сохранённые участки используются при повторном открытии. Очистка данных браузера удалит карту." : "Браузер не разрешил сохранить карту. После закрытия страницы загрузка может понадобиться снова."}>
      <span>{cache.storage === "device" ? `На устройстве: ${formatEarthLoadingBytes(cache.storedBytes)}` : "Карта доступна в этой сессии"}</span>
      {cache.storage === "device" && cache.persistence !== "granted" && <button type="button" onClick={persistMap} disabled={persisting} aria-label="Закрепить карту на устройстве"><HardDriveDownload size={14} aria-hidden="true" />{persisting ? "Сохраняем…" : "Закрепить"}</button>}
      {cache.persistence === "granted" && cache.storage === "device" && <span>Закреплена</span>}
    </div>}
  </div>;
}
