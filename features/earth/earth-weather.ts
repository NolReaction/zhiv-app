import type { Map as LibreMap, Marker } from "maplibre-gl";
import { earthWeatherArea, EARTH_WEATHER_MIN_ZOOM, type EarthWeatherSnapshot } from "./weather";
import styles from "./earth-weather.module.css";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PARTICLE_COUNT = 12;
const FRAME_MS = 125;

function svgElement<K extends keyof SVGElementTagNameMap>(owner: Document, tag: K, attributes: Record<string, string>) {
  const element = owner.createElementNS(SVG_NAMESPACE, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

/** Original miniature forecast artwork. Its particles have no independent clock. */
export function createEarthWeather(map: LibreMap, MarkerConstructor: typeof Marker) {
  const owner = map.getContainer().ownerDocument;
  let snapshot: EarthWeatherSnapshot | null = null;
  let visible = false;
  let disposed = false;
  let drawing = false;
  let motionEnabled = true;
  let elapsedMs = 0;
  let lastFrame = -1;
  let anchor: [number, number] | null = null;
  let art: ReturnType<typeof createArt> | null = null;

  function createArt() {
    const element = owner.createElement("div");
    element.className = styles.marker;
    element.dataset.earthWeather = "true";
    element.setAttribute("aria-hidden", "true");
    element.style.pointerEvents = "none";
    element.style.display = "none";
    const visual = svgElement(owner, "svg", { viewBox: "0 0 120 100", focusable: "false" });
    visual.setAttribute("class", styles.visual);
    const sun = svgElement(owner, "g", {});
    sun.append(
      svgElement(owner, "path", { d: "M37 5v6m0 40v6M11 31h6m40 0h6M19 13l5 5m27 27 5 5M19 49l5-5m27-27 5-5",
        fill: "none", stroke: "#e9bd67", "stroke-width": "3", "stroke-linecap": "round" }),
      svgElement(owner, "circle", { cx: "37", cy: "31", r: "15", fill: "#f5d483" }),
      svgElement(owner, "path", { d: "M27 27a11 11 0 0 1 11-7", fill: "none", stroke: "#fff0b9", "stroke-width": "3", "stroke-linecap": "round" }),
    );
    const moon = svgElement(owner, "path", { d: "M42 13a18 18 0 1 0 13 28A19 19 0 0 1 42 13Z", fill: "#f3e5b4", stroke: "#fff4cd", "stroke-width": "1" });
    const cloud = svgElement(owner, "g", {});
    cloud.append(
      svgElement(owner, "ellipse", { cx: "65", cy: "86", rx: "39", ry: "7", fill: "#244f58", opacity: ".055" }),
      svgElement(owner, "path", { d: "M26 58C12 58 9 41 22 36C22 23 40 18 49 29C57 16 79 20 81 35C96 29 107 38 106 47C106 55 100 60 90 60Z", fill: "#e8f0e9" }),
      svgElement(owner, "path", { d: "M18 49C33 55 46 50 60 54C76 59 92 53 105 47C106 55 100 60 90 60H28C22 60 18 55 18 49Z", fill: "#b8d0cf", opacity: ".75" }),
      svgElement(owner, "path", { d: "M55 31c5-7 15-6 19 1", fill: "none", stroke: "#fff9e8", "stroke-width": "4", "stroke-linecap": "round", opacity: ".8" }),
    );
    const fog = svgElement(owner, "path", { d: "M26 66h65M18 75h45m10 0h29M31 84h59", fill: "none", stroke: "#c2d5d0", "stroke-width": "3.5", "stroke-linecap": "round" });
    const lightning = svgElement(owner, "path", { d: "m50 57-8 17h10l-4 15 19-23H56l5-9Z", fill: "#edd07c", stroke: "#fff1b5", "stroke-width": "1" });
    const particles = Array.from({ length: PARTICLE_COUNT }, () => svgElement(owner, "path", {
      d: "M0 0l-2 6", fill: "none", stroke: "#78bfd2", "stroke-width": "2.3", "stroke-linecap": "round",
    }));
    visual.append(sun, moon, cloud, fog, lightning, ...particles);
    element.append(visual);
    const marker = new MarkerConstructor({ element, anchor: "center", pitchAlignment: "viewport",
      rotationAlignment: "viewport", opacityWhenCovered: 0, subpixelPositioning: true });
    try {
      const center = map.getCenter();
      marker.setLngLat([center.lng, center.lat]).addTo(map);
      anchor = [center.lng, center.lat];
    } catch (error) {
      marker.remove();
      throw error;
    }
    return { element, visual, marker, sun, moon, cloud, fog, lightning, particles };
  }

  function paintFrame() {
    if (!drawing || !art || !snapshot || disposed) return;
    const frame = motionEnabled ? Math.floor(elapsedMs / FRAME_MS) : 0;
    if (frame === lastFrame) return;
    lastFrame = frame;
    const time = frame * FRAME_MS;
    const precipitation = ["rain", "snow", "sleet", "thunderstorm"].includes(snapshot.condition);
    if (precipitation) {
      for (const [index, particle] of art.particles.entries()) {
        const snow = snapshot.condition === "snow" || (snapshot.condition === "sleet" && index % 3 === 0);
        const progress = (time / (snow ? 2_800 : 1_200) + index * 0.173) % 1;
        const x = 28 + index % 6 * 12 + (snow ? Math.sin(progress * Math.PI * 2 + index) * 2 : -progress * 5);
        const y = 61 + progress * 31;
        particle.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        particle.style.opacity = String(Math.sin(progress * Math.PI) * (snow ? 0.9 : 0.7));
      }
    }
    art.cloud.style.transform = `translateY(${(Math.sin(time / 4_000) * 1.2).toFixed(2)}px)`;
  }

  function paintCondition() {
    if (!snapshot || !art) return;
    const clear = snapshot.condition === "clear";
    const partlyCloudy = snapshot.condition === "partly-cloudy";
    const night = snapshot.isDay === false;
    art.sun.style.display = (clear || partlyCloudy) && !night ? "" : "none";
    art.moon.style.display = (clear || partlyCloudy) && night ? "" : "none";
    art.cloud.style.display = clear ? "none" : "";
    art.cloud.style.opacity = partlyCloudy ? ".85" : "1";
    art.fog.style.display = snapshot.condition === "fog" ? "" : "none";
    // Lightning is a still drawing; there are no flashes or strobe effects.
    art.lightning.style.display = snapshot.condition === "thunderstorm" ? "" : "none";
    const precipitation = ["rain", "snow", "sleet", "thunderstorm"].includes(snapshot.condition);
    for (const [index, particle] of art.particles.entries()) {
      const snow = snapshot.condition === "snow" || (snapshot.condition === "sleet" && index % 3 === 0);
      particle.style.display = precipitation ? "" : "none";
      particle.setAttribute("d", snow ? "M-2 0h4M0-2v4" : "M0 0l-2 6");
      particle.setAttribute("stroke", snow ? "#f2f5e8" : "#78bfd2");
      particle.setAttribute("stroke-width", snow ? "1.8" : "2.3");
    }
    lastFrame = -1;
  }

  function reconcile() {
    if (disposed) return;
    const center = map.getCenter();
    const currentArea = earthWeatherArea(center.lng, center.lat);
    // A previous region's forecast never follows the camera into another cell.
    drawing = visible && !!snapshot && snapshot.condition !== "unknown"
      && map.getZoom() >= EARTH_WEATHER_MIN_ZOOM && currentArea?.key === snapshot.area.key;
    if (!art && drawing) { art = createArt(); paintCondition(); }
    if (!art) return;
    art.element.style.display = drawing ? "" : "none";
    if (!drawing) return;
    if (!anchor || anchor[0] !== center.lng || anchor[1] !== center.lat) {
      art.marker.setLngLat([center.lng, center.lat]);
      anchor = [center.lng, center.lat];
    }
    paintFrame();
  }

  map.on("move", reconcile);
  return {
    hasMotion() { return !disposed && motionEnabled && drawing && snapshot?.condition !== "clear"; },
    setMotionEnabled(value: boolean) {
      if (disposed || motionEnabled === value) return;
      motionEnabled = value;
      lastFrame = -1;
      paintFrame();
    },
    setWeather(value: EarthWeatherSnapshot | null) {
      if (disposed || snapshot === value) return;
      snapshot = value;
      if (snapshot) paintCondition();
      reconcile();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value;
      reconcile();
    },
    update(value: number) {
      if (disposed || !motionEnabled || !Number.isFinite(value) || value < 0) return;
      elapsedMs = value;
      paintFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      drawing = false;
      map.off("move", reconcile);
      art?.marker.remove();
      art = null;
      snapshot = null;
    },
  };
}
