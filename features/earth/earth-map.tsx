"use client";

import { useEffect, useRef, useState } from "react";
import { Compass, Earth, LocateFixed, Minus, Plus, RotateCw, TriangleAlert } from "lucide-react";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import type { EarthPosition } from "./location";
import { EARTH_ACCURACY_SOURCE, EARTH_CENTER, EARTH_SKY, EARTH_STYLE_URL, globeZoom, positionAccuracyData, positionZoom } from "./map-style";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./earth-map.module.css";

type MapPhase = "loading" | "ready" | "failed" | "unsupported";

type EarthMapProps = {
  position: EarthPosition | null;
  active: boolean;
  focusRequest: number;
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

export function EarthMap({ position, active, focusRequest }: EarthMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const syncPositionRef = useRef<((value: EarthPosition | null) => void) | null>(null);
  const latestPosition = useRef(position);
  const savedCamera = useRef<{ center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const handledFocus = useRef(0);
  const [phase, setPhase] = useState<MapPhase>("loading");
  const [retry, setRetry] = useState(0);
  const [partialFailure, setPartialFailure] = useState(false);

  useEffect(() => {
    latestPosition.current = position;
    syncPositionRef.current?.(position);
  }, [position]);

  useEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    let cancelled = false;
    let map: LibreMap | null = null;
    let marker: Marker | null = null;
    let loaded = false;
    let styleReady = false;
    let resourceFailed = false;
    let contextFailed = false;
    let timeout = 0;
    let resizeObserver: ResizeObserver | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let canvas: HTMLCanvasElement | null = null;

    function resize() {
      if (!cancelled && map && !document.hidden && element!.clientWidth && element!.clientHeight) map.resize();
    }
    function visibilityChanged() {
      if (document.hidden) map?.stop();
      else resize();
    }
    function contextLost() {
      if (!cancelled) {
        contextFailed = true;
        map?.stop();
        setPhase("failed");
      }
    }

    async function initialize() {
      try {
        // The SDK and worker are loaded only when the map tab is opened.
        const sdk = await import("maplibre-gl");
        if (cancelled) return;
        setPhase("loading");
        setPartialFailure(false);
        if (!canRenderGlobe()) {
          setPhase("unsupported");
          return;
        }
        sdk.setWorkerUrl(`/vendor/maplibre-gl-${sdk.getVersion()}/maplibre-gl-worker.mjs`);
        sdk.setWorkerCount(1);
        map = new sdk.Map({
          container: element!,
          style: EARTH_STYLE_URL,
          center: savedCamera.current?.center ?? EARTH_CENTER,
          zoom: savedCamera.current?.zoom ?? globeZoom(element!.clientWidth, element!.clientHeight),
          bearing: savedCamera.current?.bearing ?? 0,
          pitch: savedCamera.current?.pitch ?? 0,
          minZoom: -1.5,
          maxZoom: 18,
          maxPitch: 60,
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
        current.on("load", () => {
          if (cancelled) return;
          loaded = true;
          window.clearTimeout(timeout);
          if (!contextFailed) {
            setPhase("ready");
            setPartialFailure(resourceFailed);
          }
        });
        current.on("error", () => {
          if (cancelled) return;
          resourceFailed = true;
          setPartialFailure(true);
          if (!loaded && !styleReady) {
            window.clearTimeout(timeout);
            setPhase("failed");
          }
        });
        timeout = window.setTimeout(() => {
          if (!cancelled && !loaded) setPhase("failed");
        }, 25_000);

        resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
        resizeObserver?.observe(element!);
        if (!resizeObserver) window.addEventListener("resize", resize);
        intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) resize();
          else current.stop();
        });
        intersectionObserver?.observe(element!);
        document.addEventListener("visibilitychange", visibilityChanged);
      } catch {
        if (!cancelled) setPhase("failed");
      }
    }
    void initialize();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
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

  function retryMap() {
    setPhase("loading");
    setPartialFailure(false);
    setRetry(value => value + 1);
  }

  const ready = active && phase === "ready";
  return <div className={styles.root} data-earth-map data-map-status={phase}>
    <div ref={host} className={styles.canvas} />
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
    {phase !== "ready" && <div className={styles.statusOverlay}>
      <div className={styles.statusCard} role="status" aria-live="polite">
        {phase === "loading" ? <Earth className={styles.loadingIcon} size={34} aria-hidden="true" /> : <TriangleAlert size={30} aria-hidden="true" />}
        <strong>{phase === "loading" ? "Открываем Землю" : phase === "unsupported" ? "Для глобуса нужен WebGL 2" : "Карта пока недоступна"}</strong>
        <p>{phase === "loading" ? "Загружаем карту мира и названия мест…" : phase === "unsupported" ? "Попробуйте обновить браузер или включить аппаратное ускорение в его настройках." : "Не удалось загрузить карту. Проверьте подключение к интернету и попробуйте ещё раз."}</p>
        {phase !== "loading" && <button type="button" onClick={retryMap}><RotateCw size={16} aria-hidden="true" /> Повторить</button>}
      </div>
    </div>}
    {ready && partialFailure && <div className={styles.networkNotice} role="status">
      <span>Не все данные карты загрузились</span><button type="button" onClick={retryMap}>Повторить</button>
    </div>}
    {ready && !partialFailure && <p className={styles.gestureHint}>Вращайте Землю · приближайте города</p>}
  </div>;
}
