import type { Map as LibreMap, Marker } from "maplibre-gl";
import { earthWeatherArea, EARTH_WEATHER_MIN_ZOOM, type EarthWeatherArea, type EarthWeatherSnapshot } from "./weather";
import styles from "./earth-weather.module.css";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PARTICLE_COUNT = 12;
const MAX_PATCHES = 9;
const COVERAGE_MIN_ZOOM = 6;
const FRAME_MS = 125;

function svgElement<K extends keyof SVGElementTagNameMap>(owner: Document, tag: K, attributes: Record<string, string>) {
  const element = owner.createElementNS(SVG_NAMESPACE, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function precipitation(snapshot: EarthWeatherSnapshot) {
  return ["rain", "snow", "sleet", "thunderstorm"].includes(snapshot.condition);
}

/** The grid is fixed to the Earth at each integer zoom, rather than to the viewport. */
function coverageAnchors(map: LibreMap, area: EarthWeatherArea, count: number): [number, number][] {
  if (map.getZoom() < COVERAGE_MIN_ZOOM) return [[area.longitude, area.latitude]];
  const container = map.getContainer();
  const width = container.clientWidth, height = container.clientHeight;
  if (!width || !height) return [[area.longitude, area.latitude]];
  const step = 180 / (512 * 2 ** Math.floor(map.getZoom()));
  const positions = new Map<string, [number, number]>();
  for (const [column, row] of [[1, 1], [0, 0], [2, 2], [2, 0], [0, 2], [0, 1], [2, 1], [1, 0], [1, 2]]) {
    const point = map.unproject([(column + .5) * width / 3, (row + .5) * height / 3]);
    if (!Number.isFinite(point.lng) || !Number.isFinite(point.lat) || Math.abs(point.lat) >= 90) continue;
    const x = Math.round((point.lng + 180) / 360 / step) * step;
    const y = Math.round((1 - Math.asinh(Math.tan(point.lat * Math.PI / 180)) / Math.PI) / 2 / step) * step;
    const longitude = ((x * 360) % 360 + 360) % 360 - 180;
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    if (earthWeatherArea(longitude, latitude)?.key !== area.key) continue;
    positions.set(`${x}:${y}`, [longitude, latitude]);
  }
  // A thin visible edge of the sampled cell can contain no grid point. Never
  // invent coverage in the neighbour: its fixed geographic summary remains.
  return positions.size ? [...positions.values()].slice(0, count) : [[area.longitude, area.latitude]];
}

/** Forecast-linked cloud patches and precipitation share the scene's bounded clock. */
export function createEarthWeather(map: LibreMap, MarkerConstructor: typeof Marker) {
  const owner = map.getContainer().ownerDocument;
  let snapshot: EarthWeatherSnapshot | null = null;
  let visible = false;
  let disposed = false;
  let drawing = false;
  let motionEnabled = true;
  let elapsedMs = 0;
  let lastFrame = -1;
  const art: ReturnType<typeof createArt>[] = [];

  function createArt(position: [number, number]) {
    const element = owner.createElement("div");
    element.className = styles.marker;
    element.dataset.earthWeather = "true";
    element.setAttribute("aria-hidden", "true");
    element.style.pointerEvents = "none";
    element.style.display = "none";
    const visual = svgElement(owner, "svg", { viewBox: "0 0 120 140", focusable: "false" });
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
      svgElement(owner, "ellipse", { cx: "65", cy: "79", rx: "39", ry: "7", fill: "#244f58", opacity: ".06" }),
      svgElement(owner, "path", { d: "M26 58C12 58 9 41 22 36C22 23 40 18 49 29C57 16 79 20 81 35C96 29 107 38 106 47C106 55 100 60 90 60Z", fill: "#e8f0e9" }),
      svgElement(owner, "path", { d: "M18 49C33 55 46 50 60 54C76 59 92 53 105 47C106 55 100 60 90 60H28C22 60 18 55 18 49Z", fill: "#b8d0cf", opacity: ".75" }),
      svgElement(owner, "path", { d: "M55 31c5-7 15-6 19 1", fill: "none", stroke: "#fff9e8", "stroke-width": "4", "stroke-linecap": "round", opacity: ".8" }),
    );
    const fog = svgElement(owner, "path", { d: "M14 68h87M8 81h52m10 0h43M19 96h82M28 111h61", fill: "none", stroke: "#c2d5d0", "stroke-width": "4", "stroke-linecap": "round" });
    const lightning = svgElement(owner, "path", { d: "m50 57-8 17h10l-4 15 19-23H56l5-9Z", fill: "#edd07c", stroke: "#fff1b5", "stroke-width": "1" });
    const particles = Array.from({ length: PARTICLE_COUNT }, () => svgElement(owner, "path", {
      d: "M0 0l-3 10", fill: "none", stroke: "#669fb5", "stroke-width": "2.3", "stroke-linecap": "round",
    }));
    visual.append(sun, moon, cloud, fog, lightning, ...particles);
    element.append(visual);
    const marker = new MarkerConstructor({ element, anchor: "center", pitchAlignment: "viewport",
      rotationAlignment: "viewport", opacityWhenCovered: 0, subpixelPositioning: true });
    try { marker.setLngLat(position).addTo(map); }
    catch (error) { marker.remove(); throw error; }
    return { element, visual, marker, sun, moon, cloud, fog, lightning, particles, active: false, position };
  }

  function paintFrame() {
    if (!drawing || !snapshot || disposed) return;
    const frame = motionEnabled ? Math.floor(elapsedMs / FRAME_MS) : 0;
    if (frame === lastFrame) return;
    lastFrame = frame;
    const time = frame * FRAME_MS;
    for (const [patch, drawing] of art.entries()) {
      if (!drawing.active) continue;
      if (precipitation(snapshot)) for (const [index, particle] of drawing.particles.entries()) {
        const snow = snapshot.condition === "snow" || (snapshot.condition === "sleet" && index % 3 === 0);
        const progress = (time / (snow ? 3_200 : 1_400) + index * .173 + patch * .19) % 1;
        const x = 22 + index % 6 * 15 + (snow ? Math.sin(progress * Math.PI * 2 + index) * 4 : -progress * 10);
        const y = 59 + progress * 70;
        particle.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        particle.style.opacity = String(.2 + Math.sin(progress * Math.PI) * (snow ? .75 : .65));
      }
      drawing.cloud.style.transform = `translate(${(Math.sin(time / 5_000 + patch) * 2).toFixed(2)}px ${(Math.sin(time / 4_000 + patch) * 1.2).toFixed(2)}px)`;
    }
  }

  function paintCondition(drawing: ReturnType<typeof createArt>) {
    if (!snapshot) return;
    const clear = snapshot.condition === "clear", partlyCloudy = snapshot.condition === "partly-cloudy";
    const night = snapshot.isDay === false;
    drawing.element.dataset.weatherCondition = snapshot.condition;
    drawing.element.dataset.weatherCell = snapshot.area.key;
    drawing.sun.style.display = (clear || partlyCloudy) && !night ? "" : "none";
    drawing.moon.style.display = (clear || partlyCloudy) && night ? "" : "none";
    drawing.cloud.style.display = clear ? "none" : "";
    drawing.cloud.style.opacity = partlyCloudy ? ".7" : "1";
    drawing.fog.style.display = snapshot.condition === "fog" ? "" : "none";
    // Storms use a still bolt: there are no flashes or strobe effects.
    drawing.lightning.style.display = snapshot.condition === "thunderstorm" ? "" : "none";
    for (const [index, particle] of drawing.particles.entries()) {
      const snow = snapshot.condition === "snow" || (snapshot.condition === "sleet" && index % 3 === 0);
      particle.style.display = precipitation(snapshot) ? "" : "none";
      particle.setAttribute("d", snow ? "M-2.5 0h5M0-2.5v5" : "M0 0l-3 10");
      particle.setAttribute("stroke", snow ? "#f2f5e8" : "#669fb5");
      particle.setAttribute("stroke-width", snow ? "2" : "2.3");
    }
    lastFrame = -1;
  }

  function reconcile() {
    if (disposed) return;
    const center = map.getCenter();
    drawing = visible && !!snapshot && snapshot.condition !== "unknown"
      && map.getZoom() >= EARTH_WEATHER_MIN_ZOOM && earthWeatherArea(center.lng, center.lat)?.key === snapshot.area.key;
    const coverage = !!snapshot && snapshot.condition !== "clear" && map.getZoom() >= COVERAGE_MIN_ZOOM;
    const count = snapshot?.condition === "clear" ? 1 : snapshot && precipitation(snapshot) ? MAX_PATCHES
      : Math.max(1, Math.min(MAX_PATCHES, Math.ceil((snapshot?.cloudCoverPercent ?? (snapshot?.condition === "partly-cloudy" ? 40 : 90)) / 100 * MAX_PATCHES)));
    const anchors: [number, number][] = drawing && snapshot ? coverage ? coverageAnchors(map, snapshot.area, count)
      : [[snapshot.area.longitude, snapshot.area.latitude]] : [];
    for (let index = 0; index < Math.max(anchors.length, art.length); index++) {
      const anchor = anchors[index];
      if (!art[index] && anchor) { art[index] = createArt(anchor); paintCondition(art[index]); }
      const patch = art[index];
      patch.active = !!anchor;
      patch.element.style.display = anchor ? "" : "none";
      if (!anchor) continue;
      patch.element.dataset.weatherScale = coverage ? "coverage" : "summary";
      if (patch.position[0] !== anchor[0] || patch.position[1] !== anchor[1]) {
        patch.marker.setLngLat(anchor); patch.position = anchor;
      }
    }
    paintFrame();
  }

  map.on("move", reconcile);
  map.on("resize", reconcile);
  return {
    hasMotion() { return !disposed && motionEnabled && drawing && snapshot?.condition !== "clear"; },
    setMotionEnabled(value: boolean) {
      if (disposed || motionEnabled === value) return;
      motionEnabled = value; lastFrame = -1; paintFrame();
    },
    setWeather(value: EarthWeatherSnapshot | null) {
      if (disposed || snapshot === value) return;
      snapshot = value;
      for (const patch of art) paintCondition(patch);
      reconcile();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value; reconcile();
    },
    update(value: number) {
      if (disposed || !motionEnabled || !Number.isFinite(value) || value < 0) return;
      elapsedMs = value; paintFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true; drawing = false;
      map.off("move", reconcile); map.off("resize", reconcile);
      for (const patch of art) patch.marker.remove();
      art.length = 0; snapshot = null;
    },
  };
}
