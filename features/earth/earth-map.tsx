"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Compass, Earth, HardDriveDownload, Info, LocateFixed, Minus, Plus, X } from "lucide-react";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import type { EarthPosition } from "./location";
import { EARTH_ACCURACY_SOURCE, EARTH_CENTER, EARTH_SKY, EARTH_STYLE_URL, globeZoom, positionAccuracyData, positionZoom, prepareEarthStyle } from "./map-style";
import { EarthLoading, formatEarthLoadingBytes, type EarthLoadingStage } from "./earth-loading";
import { EARTH_CACHE_PROTOCOL, earthResourceCache } from "./resource-cache";
import { EARTH_RUNTIME_DIRECTORY, loadEarthRuntime } from "./runtime-loader";
import { getEarthErrorResourceUrls } from "./resource-recovery";
import { createEarthRequestScope, createEarthResourceProtocol } from "./resource-protocol";
import { refreshEarthTileSource } from "./source-recovery";
import { createEarthTileRecovery, type EarthTileRecoveryStatus } from "./tile-recovery";
import { EARTH_BUILDINGS_3D_LAYER } from "./building-style";
import { createEarthPositionMarker, updateEarthPositionMarkerLabel } from "./position-marker";
import { installEarthMaterialImages, registerEarthMaterialImage } from "./land-material";
import { EarthAttribution } from "./earth-attribution";
import { installEarthGlobeCamera } from "./globe-camera";
import { EARTH_OCEAN_MATERIAL_IMAGE, registerEarthOceanMaterialImage } from "./globe-ocean";
import { bindEarthPositionMarkerMotion } from "./marker-motion";
import { createEarthGlobeScene } from "./globe-scene";
import type { EarthLightingMode } from "./globe-lighting";
import { createEarthTileLoadingOverlay } from "./tile-loading-overlay";
import { createEarthStars } from "./earth-stars";
import { createEarthWeatherController, createEarthWeatherProvider, type EarthWeatherSnapshot, type EarthWeatherState } from "./weather";
import { EARTH_WEATHER_ATTRIBUTION } from "@/lib/earth-weather-contract";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./earth-map.module.css";

type MapPhase = "loading" | "ready" | "failed" | "unsupported";

type EarthMapProps = {
  position: EarthPosition | null;
  active: boolean;
  visible: boolean;
  onReadyChange?: (ready: boolean) => void;
  focusRequest: number;
  isOnline: boolean;
  onLocate: () => void;
  locating: boolean;
  locationActive: boolean;
  locationDetails: ReactNode;
  infoOpen: boolean;
  onInfoOpenChange: (open: boolean) => void;
};

function weatherConditionLabel(condition: string): string {
  return ({ clear: "Ясно", "partly-cloudy": "Переменная облачность", cloudy: "Облачно", fog: "Туман", rain: "Дождь", snow: "Снег", sleet: "Мокрый снег", thunderstorm: "Гроза" } as Record<string, string>)[condition] ?? "Погода в центре карты";
}

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

export function EarthMap({ position, active, visible, onReadyChange, focusRequest, isOnline, onLocate, locating, locationActive,
  locationDetails, infoOpen, onInfoOpenChange }: EarthMapProps) {
  const visibleRef = useRef(visible);
  const foregroundRef = useRef<(() => void) | null>(null);
  const starsRef = useRef<ReturnType<typeof createEarthStars> | null>(null);
  const [weatherEnabled, setWeatherEnabled] = useState(false);
  const weatherEnabledRef = useRef(weatherEnabled);
  const weatherControllerRef = useRef<ReturnType<typeof createEarthWeatherController> | null>(null);
  const [weatherState, setWeatherState] = useState<EarthWeatherState>({ status: "disabled", area: null, snapshot: null, nextRequestAt: null, error: null });
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
  const [buildings3d, setBuildings3d] = useState(true);
  const buildings3dRef = useRef(buildings3d);
  const [lightingMode, setLightingMode] = useState<EarthLightingMode>("auto");
  const lightingModeRef = useRef(lightingMode);
  const sceneRef = useRef<ReturnType<typeof createEarthGlobeScene> | null>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const infoHeading = useRef<HTMLHeadingElement>(null);
  const cache = useSyncExternalStore(earthResourceCache.subscribe, earthResourceCache.getSnapshot, earthResourceCache.getSnapshot);
  const phaseRef = useRef(phase);
  const activeRef = useRef(active);
  useEffect(() => { phaseRef.current = phase; onReadyChange?.(phase === "ready"); }, [phase, onReadyChange]);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    foregroundRef.current?.();
  }, [visible]);
  useEffect(() => {
    weatherEnabledRef.current = weatherEnabled;
    weatherControllerRef.current?.setEnabled(weatherEnabled);
  }, [weatherEnabled]);
  useEffect(() => {
    lightingModeRef.current = lightingMode;
    sceneRef.current?.setLighting(lightingMode);
    starsRef.current?.setMode(lightingMode);
  }, [lightingMode]);
  useEffect(() => { if (infoOpen && visible) infoHeading.current?.focus({ preventScroll: true }); }, [infoOpen, visible]);
  useEffect(() => {
    buildings3dRef.current = buildings3d;
    const current = mapRef.current;
    if (current?.getLayer(EARTH_BUILDINGS_3D_LAYER)) current.setLayoutProperty(EARTH_BUILDINGS_3D_LAYER, "visibility", buildings3d ? "visible" : "none");
  }, [buildings3d]);

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
    const requests = createEarthRequestScope(controller.signal);
    let interruptedDownloads = false;
    let foreground = false;
    let tileOverlay: ReturnType<typeof createEarthTileLoadingOverlay> | null = null;
    let stars: ReturnType<typeof createEarthStars> | null = null;
    let weather: ReturnType<typeof createEarthWeatherController> | null = null;
    let weatherSnapshot: EarthWeatherSnapshot | null = null;
    let map: LibreMap | null = null;
    let marker: Marker | null = null;
    let disposeMarkerMotion: (() => void) | null = null;
    let scene: ReturnType<typeof createEarthGlobeScene> | null = null;
    let initialReady = false;
    let attemptFailed = false;
    let styleReady = false;
    let rendered = false;
    let readyCheckQueued = false;
    let recoveryStatus: EarthTileRecoveryStatus = "idle";
    let previousPending = 0;
    let timeout = 0;
    let unsubscribe: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let tileRecovery: ReturnType<typeof createEarthTileRecovery> | null = null;
    let restoreGlobeCamera: (() => void) | null = null;

    function resize() {
      if (!cancelled && map && activeRef.current && visibleRef.current && !document.hidden && element!.clientWidth && element!.clientHeight) map.resize();
    }
    function updateForeground() {
      if (cancelled) return;
      const next = activeRef.current && visibleRef.current && !document.hidden;
      const returning = next && !foreground;
      if (!next) {
        window.clearTimeout(timeout);
        map?.stop();
        // Cold installation can finish during a brief background pause. Ready
        // maps release downloads immediately; a return renews the request scope.
        if (initialReady) {
          interruptedDownloads ||= earthResourceCache.getSnapshot().pending > 0;
          requests.setVisible(false);
        }
      } else {
        requests.setVisible(true);
        armDeadline();
        if (returning && interruptedDownloads && map && styleReady) {
          interruptedDownloads = false;
          // Fresh vector actors recover requests aborted while the section was
          // hidden. Keep this Map, the camera, terrain and decorative sources.
          if (refreshEarthTileSource(map, { sourceId: "earth-streets" })) map.setSourceTileLodParams(4, 2, "earth-streets");
        }
        resize();
      }
      foreground = next;
      scene?.setVisible(next);
      stars?.setVisible(next && initialReady);
      tileOverlay?.setVisible(next && initialReady);
      tileOverlay?.setStatus(recoveryStatus, navigator.onLine);
      tileOverlay?.refresh();
      weather?.setVisible(next && initialReady);
      tileRecovery?.check();
    }
    foregroundRef.current = updateForeground;
    function visibilityChanged() { updateForeground(); }
    function fail(message: string) {
      if (cancelled || attemptFailed) return;
      attemptFailed = true;
      controller.abort();
      window.clearTimeout(timeout);
      map?.stop();
      scene?.setReady(false);
      stars?.setVisible(false);
      tileOverlay?.setVisible(false);
      weather?.setVisible(false);
      setFailure(message);
      setPhase("failed");
    }
    function contextLost() {
      fail("Браузер приостановил графику карты. Попробуйте открыть её снова; доступные сохранённые файлы будут использованы повторно.");
    }
    function armDeadline() {
      window.clearTimeout(timeout);
      if (visibleRef.current && !document.hidden && !initialReady && !attemptFailed) timeout = window.setTimeout(() =>
        fail("Подготовка занимает слишком много времени. Продолжите загрузку: доступные сохранённые файлы будут использованы повторно."), 180_000);
    }
    function checkReady() {
      if (cancelled || attemptFailed || initialReady || !map || !styleReady) return;
      const progress = earthResourceCache.getSnapshot();
      if (progress.failed > 0) {
        fail("Не удалось получить часть карты. Продолжите загрузку, когда появится связь; доступные сохранённые файлы будут использованы повторно.");
        return;
      }
      setStage(progress.pending === 0 ? "render" : "resources");
      // A canceled source request may settle without another idle event. Check
      // the actual painted map; an old idle flag must not hold a warm start shut.
      // Errored tiles count as loaded in MapLibre, so failures/recovery still gate it.
      if (rendered && recoveryStatus === "idle" && progress.pending === 0
        && !map.isMoving() && map.loaded() && map.areTilesLoaded()) {
        initialReady = true;
        window.clearTimeout(timeout);
        setPhase("ready");
        scene?.setReady(true);
        updateForeground();
      }
    }
    function scheduleReadyCheck() {
      if (readyCheckQueued || cancelled || initialReady || attemptFailed) return;
      readyCheckQueued = true;
      // Source events can fire before the SDK has updated its own loaded flags.
      queueMicrotask(() => { readyCheckQueued = false; checkReady(); });
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
        sdk.addProtocol(EARTH_CACHE_PROTOCOL, createEarthResourceProtocol(earthResourceCache.protocol, requests.signal));
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
        restoreGlobeCamera = installEarthGlobeCamera(current);
        installEarthMaterialImages(current, id => {
          if (id === EARTH_OCEAN_MATERIAL_IMAGE) registerEarthOceanMaterialImage(current);
        });
        mapRef.current = current;
        tileOverlay = createEarthTileLoadingOverlay(current);
        stars = createEarthStars(current, element!, lightingModeRef.current);
        starsRef.current = stars;
        weather = createEarthWeatherController({ provider: createEarthWeatherProvider(), onState: state => {
          if (cancelled || attemptFailed) return;
          setWeatherState(state);
          weatherSnapshot = state.status === "ready" || state.status === "stale" ? state.snapshot : null;
          scene?.setWeather(weatherSnapshot);
        } });
        weatherControllerRef.current = weather;
        weather.setEnabled(weatherEnabledRef.current);
        const updateWeatherView = () => {
          if (cancelled || attemptFailed) return;
          const center = current.getCenter();
          weather?.setView({ longitude: center.lng, latitude: center.lat, zoom: current.getZoom() });
        };
        updateWeatherView();
        current.on("moveend", updateWeatherView);
        tileRecovery = createEarthTileRecovery({
          readState: () => {
            const progress = earthResourceCache.getSnapshot();
            return { enabled: styleReady && !attemptFailed && !cancelled, visible: !document.hidden && activeRef.current && visibleRef.current,
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
          onChange: status => {
            if (cancelled) return;
            recoveryStatus = status;
            setTileStatus(status);
            tileOverlay?.setStatus(status, navigator.onLine);
            tileOverlay?.refresh();
            if (!initialReady && status === "failed") fail("Не удалось завершить отрисовку карты. Попробуйте открыть её снова: сохранённые данные будут использованы повторно.");
            else scheduleReadyCheck();
          },
        });
        tileRecoveryRef.current = tileRecovery;
        previousPending = earthResourceCache.getSnapshot().pending;
        unsubscribe = earthResourceCache.subscribe(() => {
          const pending = earthResourceCache.getSnapshot().pending;
          // The protocol settles before MapLibre consumes the response. Schedule
          // one frame for that boundary, rather than depending on an idle callback.
          if (foreground && !initialReady && pending === 0 && previousPending > 0) current.triggerRepaint();
          previousPending = pending;
          scheduleReadyCheck();
          tileRecovery?.check();
          if (foreground) tileOverlay?.refresh();
        });
        current.on("remove", () => {
          // Cleanup runs before the active-ref effect. The actual removal event,
          // rather than that old ref, determines whether a new map must load.
          setPhase("loading");
          setStage("engine");
        });
        canvas = current.getCanvas();
        canvas.setAttribute("aria-label", "Карта Земли. Перетаскивайте глобус, приближайте двумя пальцами или колёсиком. Стрелки перемещают карту; плюс и минус меняют масштаб.");
        canvas.addEventListener("webglcontextlost", contextLost);

        const syncPosition = (value: EarthPosition | null) => {
          if (cancelled) return;
          const source = current.getSource<GeoJSONSource>(EARTH_ACCURACY_SOURCE);
          source?.setData(positionAccuracyData(value));
          if (!value) {
            disposeMarkerMotion?.();
            disposeMarkerMotion = null;
            marker?.remove();
            marker = null;
            return;
          }
          if (!source) return;
          if (!marker) {
            marker = new sdk.Marker({ element: createEarthPositionMarker(), anchor: "bottom",
              pitchAlignment: "viewport", rotationAlignment: "viewport", subpixelPositioning: true, opacityWhenCovered: 0 })
              .setLngLat([value.longitude, value.latitude]).addTo(current);
            disposeMarkerMotion = bindEarthPositionMarkerMotion(current, marker.getElement());
          }
          marker.setLngLat([value.longitude, value.latitude]);
          updateEarthPositionMarkerLabel(marker.getElement(), value.accuracy);
        };
        syncPositionRef.current = syncPosition;

        current.on("style.load", () => {
          if (cancelled) return;
          registerEarthMaterialImage(current);
          registerEarthOceanMaterialImage(current);
          styleReady = true;
          // Style replacement discards projection, atmosphere and our own layers.
          current.setProjection({ type: "globe" });
          current.setSky(EARTH_SKY);
          current.setLayoutProperty(EARTH_BUILDINGS_3D_LAYER, "visibility", buildings3dRef.current ? "visible" : "none");
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
          scene?.dispose();
          scene = createEarthGlobeScene(current, sdk.Marker, lightingModeRef.current);
          sceneRef.current = scene;
          scene.setWeather(weatherSnapshot);
          scene.setReady(initialReady);
          scene.setVisible(foreground);
        });
        for (const eventName of ["sourcedataloading", "sourcedata", "sourcedataabort"] as const) current.on(eventName, event => {
          if (cancelled || attemptFailed) return;
          // A worker can ask for a tile after the visibility handler has already
          // aborted the request scope, without ever increasing cache.pending.
          if (eventName === "sourcedataloading" && event.sourceId === "earth-streets" && initialReady
            && (!activeRef.current || !visibleRef.current || document.hidden)) interruptedDownloads = true;
          tileOverlay?.observe(event);
          if (foreground) tileOverlay?.refresh();
        });
        current.on("dataloading", scheduleReadyCheck);
        current.on("dataabort", () => {
          if (cancelled) return;
          // MapLibre forwards dataabort without invalidating a frame. An aborted
          // offscreen tile must not leave initial readiness or recovery asleep.
          if (foreground) current.triggerRepaint();
          scheduleReadyCheck();
          tileRecovery?.check();
        });
        current.on("movestart", () => tileRecovery?.check());
        current.on("moveend", () => { scheduleReadyCheck(); tileRecovery?.check(); });
        current.on("render", () => { rendered = true; scheduleReadyCheck(); if (foreground) tileOverlay?.refresh(); });
        current.on("load", scheduleReadyCheck);
        current.on("idle", () => { scheduleReadyCheck(); tileRecovery?.check(true); });
        current.on("error", event => {
          if (cancelled || attemptFailed || !foreground && initialReady) return;
          tileOverlay?.observe(event);
          tileOverlay?.refresh();
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
        updateForeground();
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
      requests.dispose();
      if (foregroundRef.current === updateForeground) foregroundRef.current = null;
      weather?.dispose();
      if (weatherControllerRef.current === weather) weatherControllerRef.current = null;
      stars?.dispose();
      if (starsRef.current === stars) starsRef.current = null;
      tileOverlay?.dispose();
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
      disposeMarkerMotion?.();
      marker?.remove();
      scene?.dispose();
      if (sceneRef.current === scene) sceneRef.current = null;
      map?.stop();
      restoreGlobeCamera?.();
      if (map) {
        const center = map.getCenter();
        savedCamera.current = { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      }
      map?.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [active, retry]);

  useEffect(() => {
    if (!active || !visible || phase !== "ready" || !position || !mapRef.current || focusRequest <= handledFocus.current) return;
    handledFocus.current = focusRequest;
    flyToPosition(mapRef.current, position);
  }, [active, visible, phase, position, focusRequest]);

  const ready = active && visible && phase === "ready";
  return <div className={styles.root} data-earth-map data-map-status={phase} data-lighting={lightingMode}>
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
      <button type="button" disabled={!ready || locating} data-active={locationActive} aria-busy={locating}
        title={locating ? "Определяем местоположение…" : position ? "К моему местоположению" : "Найти себя на карте"}
        aria-label="Показать моё местоположение" aria-describedby="earth-location-privacy" onClick={onLocate}><LocateFixed size={21} aria-hidden="true" /></button>
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
    {ready && tileStatus === "idle" && cache.pending > 0 && <p className={styles.tileProgress} role="status">Загружаем окрестности…</p>}
    {ready && weatherEnabled && <p className={styles.weatherBadge} data-earth-weather-status={weatherState.status} role="status">
      <span aria-hidden="true">{weatherState.snapshot?.condition === "clear" ? "☀" : "☁"}</span>
      {weatherState.snapshot ? `${weatherConditionLabel(weatherState.snapshot.condition)}${weatherState.snapshot.temperatureC === null ? "" : ` · ${Math.round(weatherState.snapshot.temperatureC) > 0 ? "+" : ""}${Math.round(weatherState.snapshot.temperatureC)}°`}${weatherState.status === "stale" ? " · старый прогноз" : ""}`
        : weatherState.status === "zoom-in" ? "Приблизьте карту для погоды" : weatherState.status === "error" ? "Прогноз пока недоступен" : weatherState.status === "waiting" ? "Прогноз обновится чуть позже" : "Узнаём погоду…"}
    </p>}
    {ready && <EarthAttribution />}
    {ready && <button ref={infoButton} type="button" className={styles.infoButton} aria-label="О карте и её настройках"
      aria-expanded={infoOpen} aria-controls="earth-info-panel" onClick={() => onInfoOpenChange(!infoOpen)}><Info size={21} aria-hidden="true" /></button>}
    {ready && infoOpen && <section id="earth-info-panel" className={styles.infoPanel} role="dialog" aria-labelledby="earth-info-title" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onInfoOpenChange(false); infoButton.current?.focus({ preventScroll: true }); }
    }}>
      <header className={styles.infoHeader}><h2 ref={infoHeading} tabIndex={-1} id="earth-info-title">О карте</h2>
        <button type="button" className={styles.infoClose} aria-label="Закрыть настройки карты" onClick={() => { onInfoOpenChange(false); infoButton.current?.focus({ preventScroll: true }); }}><X size={18} aria-hidden="true" /></button></header>
      <section className={styles.infoSection}><h3>Вид карты</h3>
        <div className={styles.lightingModes} role="group" aria-label="Освещение глобуса">
          {([ ["auto", "Авто"], ["day", "День"], ["evening", "Вечер"] ] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={lightingMode === value} onClick={() => setLightingMode(value)}>{label}</button>)}
        </div>
        <p>{lightingMode === "auto" ? "Светлая и тёмная стороны следуют времени суток. Облачка и волны оживляют Землю при отдалении." : lightingMode === "evening" ? "Тёплый закат и огоньки городов. Вечер остаётся на выбранной стороне Земли." : "Светлый глобус, чтобы рассмотреть все детали."}</p>
        <p>Миниатюры достопримечательностей стоят на своих географических местах. Нажмите на любую, чтобы узнать название. Близкие объекты появляются по мере приближения, перед улицами миниатюры исчезают.</p>
        <div className={styles.infoRow}><span id="earth-buildings-label">Объёмные здания</span>
          <button type="button" className={styles.infoToggle} role="switch" aria-checked={buildings3d} aria-labelledby="earth-buildings-label" onClick={() => setBuildings3d(value => !value)}><span aria-hidden="true" /></button></div>
        <p>Появляются при приближении к улицам. Наклоните карту двумя пальцами или перетаскивайте её с зажатой правой кнопкой мыши.</p>
      </section>
      <section className={styles.infoSection}><div className={styles.infoRow}><h3 id="earth-weather-label">Погода</h3>
        <button type="button" className={styles.infoToggle} role="switch" aria-checked={weatherEnabled} aria-labelledby="earth-weather-label" onClick={() => setWeatherEnabled(value => !value)}><span aria-hidden="true" /></button></div>
        <p>Прогноз для центра карты. При приближении показываем облачка, дождь или снег. Данные обновляются с паузой; при перемещении в другой район нужно немного подождать.</p>
        <p>При включении передаём только центр просмотра, округлённый до целых градусов. Доступ к геопозиции для этого не нужен.</p>
        {weatherEnabled && weatherState.snapshot && <p>Прогноз на {new Date(weatherState.snapshot.forecastAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. {weatherState.status === "stale" ? "Данные сохранены ранее; свежий прогноз пока недоступен." : "Это прогноз для района, а не точное измерение на вашей улице."}</p>}
        <p className={styles.attribution}>На основе прогноза <a href={EARTH_WEATHER_ATTRIBUTION.sourceUrl} target="_blank" rel="noreferrer">{EARTH_WEATHER_ATTRIBUTION.name}</a>{" · "}
          <a href={EARTH_WEATHER_ATTRIBUTION.licenseUrl} target="_blank" rel="noreferrer">{EARTH_WEATHER_ATTRIBUTION.license}</a>. Упрощённая визуализация для «Я живой».</p>
      </section>
      {locationDetails}
      <section className={styles.infoSection}><h3>На устройстве</h3><div className={styles.storageDetails}>
        <strong>{cache.storage === "device" ? `Сохранено ${formatEarthLoadingBytes(cache.storedBytes)}` : "Доступно в этой сессии"}
          {cache.persistence === "granted" && cache.storage === "device" ? " · Закреплено" : ""}</strong>
        <p>{cache.storage === "device" ? "Изученные участки открываются из сохранённых данных. Новые места и масштабы загружаются по мере приближения. Очистка данных браузера удалит карту." : "Браузер не разрешил сохранить карту на устройстве. После закрытия страницы потребуется повторная загрузка."}</p>
        {cache.storage === "device" && cache.persistence !== "granted" && <button type="button" onClick={persistMap} disabled={persisting}><HardDriveDownload size={16} aria-hidden="true" />{persisting ? "Сохраняем…" : "Закрепить карту"}</button>}
      </div></section>
      <section className={styles.infoSection}><h3>Источники карты</h3><p className={styles.attribution}>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>{" · "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{" · "}
        <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">OpenMapTiles</a>{" · "}
        <a href="https://www.naturalearthdata.com" target="_blank" rel="noreferrer">Natural Earth</a>
      </p><p>Данные OpenStreetMap распространяются по <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ODbL</a>, дизайн схемы OpenMapTiles · <a href="https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md" target="_blank" rel="noreferrer">CC BY 4.0</a>. Natural Earth · общественное достояние. Оформление карты изменено для «Я живой».</p>
        <p>Движок: <a href={`${EARTH_RUNTIME_DIRECTORY}/LICENSE.txt`} target="_blank" rel="noreferrer">MapLibre GL JS и лицензии компонентов</a>.</p>
      </section>
    </section>}
  </div>;
}
