import type { Map as LibreMap, Marker } from "maplibre-gl";
import { EARTH_POSITION_TTL_MS, EARTH_SHARING_MAX_PEOPLE, type EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { positionZoom } from "./map-style";
import { EARTH_FRIEND_MARKER_MIN_ZOOM, layoutEarthFriends, type EarthFriendGroup } from "./friend-marker-layout";
import styles from "./friend-markers.module.css";

type Environment = { now: () => number; schedule: (callback: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void; reducedMotion: () => boolean };
type Entry = { marker: Marker; element: HTMLButtonElement; portrait: HTMLSpanElement;
  circleIds: string[]; removeListeners: () => void };

/** Public round-trip projection rejects the far hemisphere before creating DOM. */
export function earthFriendScreenPoint(map: Pick<LibreMap, "project" | "unproject" | "getProjection">,
  position: { longitude: number; latitude: number }): { x: number; y: number } | null {
  if (!Number.isFinite(position.longitude) || !Number.isFinite(position.latitude)
    || Math.abs(position.longitude) > 180 || Math.abs(position.latitude) > 90) return null;
  const point = map.project([position.longitude, position.latitude]);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (map.getProjection()?.type === "globe") {
    const surface = map.unproject(point);
    if (!Number.isFinite(surface.lng) || !Number.isFinite(surface.lat)) return null;
    const longitudeDelta = ((surface.lng - position.longitude + 540) % 360 + 360) % 360 - 180;
    // Near the horizon inverse projection has a little numerical uncertainty.
    // Native Marker globe occlusion remains a second check for each drawn pin.
    if (Math.hypot(longitudeDelta * Math.cos(position.latitude * Math.PI / 180), surface.lat - position.latitude) > 0.001) return null;
  }
  return point;
}

function initials(name: string): string {
  return name.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0] ?? "").join("").toLocaleUpperCase("ru-RU") || "Ж";
}

function friendLabel(person: EarthMapPerson): string {
  const precision = person.accuracyMeters < 1_000 ? `${Math.max(1, Math.round(person.accuracyMeters))} м`
    : `${(person.accuracyMeters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
  const updatedAt = new Date(person.updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${person.user.displayName} · ${person.precision === "APPROXIMATE" ? "примерное местоположение" : "точность"} ±${precision}. Последнее обновление: ${updatedAt}. Открыть друга`;
}

/** Current authorized feed only: no requests, storage, avatars or location history. */
export function createEarthFriendMarkers(map: LibreMap, MarkerConstructor: typeof Marker,
  onSelect: (circleIds: string[]) => void, environment: Environment = {
    now: () => performance.now(), schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: handle => window.clearTimeout(handle as number),
    reducedMotion: () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  }) {
  const owner = map.getContainer().ownerDocument;
  const entries = new Map<string, Entry>();
  let people = new Map<string, EarthMapPerson>();
  let selfPosition: EarthPosition | null = null;
  let visible = false;
  let disposed = false;
  let timer: unknown = null;
  let timerGeneration = 0;
  const Observer = owner.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => synchronizeAccessibility()) : null;

  function cancelExpiry() {
    timerGeneration++;
    if (timer !== null) environment.cancel(timer);
    timer = null;
  }
  function removeEntry(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.removeListeners(); entry.circleIds = []; entry.marker.remove(); entries.delete(id);
  }
  function clear() {
    cancelExpiry(); people.clear(); selfPosition = null;
    observer?.disconnect();
    for (const id of [...entries.keys()]) removeEntry(id);
  }
  function purgeExpired() {
    const now = environment.now();
    for (const [id, person] of people) if (person.expiresAtMonotonic <= now) people.delete(id);
  }
  function armExpiry() {
    cancelExpiry();
    if (!visible || !people.size) return;
    const deadline = Math.min(...[...people.values()].map(person => person.expiresAtMonotonic));
    const generation = timerGeneration;
    timer = environment.schedule(() => {
      if (disposed || !visible || generation !== timerGeneration) return;
      timer = null; purgeExpired(); reconcile(); armExpiry();
    }, Math.max(0, Math.min(EARTH_POSITION_TTL_MS, deadline - environment.now())));
  }
  function synchronizeAccessibility() {
    for (const entry of entries.values()) {
      const available = visible && !disposed && !entry.element.classList.contains("maplibregl-marker-covered")
        && entry.circleIds.some(id => (people.get(id)?.expiresAtMonotonic ?? -Infinity) > environment.now());
      entry.element.disabled = !available;
      entry.element.tabIndex = available ? 0 : -1;
      entry.element.setAttribute("aria-hidden", String(!available));
    }
  }
  function createEntry(group: EarthFriendGroup, person: EarthMapPerson): Entry {
    const element = owner.createElement("button");
    element.type = "button"; element.className = styles.marker;
    element.dataset.earthFriend = "true";
    element.disabled = true; element.tabIndex = -1;
    element.setAttribute("aria-hidden", "true");
    const portrait = owner.createElement("span");
    portrait.className = styles.portrait; portrait.setAttribute("aria-hidden", "true");
    element.append(portrait);
    const marker = new MarkerConstructor({ element, anchor: "bottom", pitchAlignment: "viewport",
      rotationAlignment: "viewport", subpixelPositioning: true, opacityWhenCovered: 0 });
    const entry: Entry = { marker, element, portrait, circleIds: [...group.circleIds], removeListeners: () => undefined };
    const stopPointer = (event: Event) => event.stopPropagation();
    const onClick = (event: Event) => {
      event.stopPropagation();
      if (disposed || !visible || element.disabled || element.classList.contains("maplibregl-marker-covered")) return;
      const ids = entry.circleIds.filter(id => (people.get(id)?.expiresAtMonotonic ?? -Infinity) > environment.now());
      if (ids.length) onSelect(ids);
      else { purgeExpired(); reconcile(); armExpiry(); }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    };
    element.addEventListener("click", onClick);
    element.addEventListener("pointerdown", stopPointer);
    element.addEventListener("mousedown", stopPointer);
    element.addEventListener("touchstart", stopPointer, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    entry.removeListeners = () => {
      element.removeEventListener("click", onClick);
      element.removeEventListener("pointerdown", stopPointer);
      element.removeEventListener("mousedown", stopPointer);
      element.removeEventListener("touchstart", stopPointer);
      element.removeEventListener("keydown", onKeyDown);
    };
    try {
      marker.setLngLat([person.longitude, person.latitude]).addTo(map);
    } catch (error) { entry.removeListeners(); marker.remove(); throw error; }
    return entry;
  }
  function reconcile() {
    if (disposed) return;
    purgeExpired();
    const container = map.getContainer();
    const points = visible && map.getZoom() > EARTH_FRIEND_MARKER_MIN_ZOOM ? [...people.values()].flatMap(person => {
      const point = earthFriendScreenPoint(map, person);
      return point ? [{ circleId: person.circleId, ...point }] : [];
    }) : [];
    const groups = layoutEarthFriends(points, { width: container.clientWidth, height: container.clientHeight },
      selfPosition ? earthFriendScreenPoint(map, selfPosition) : null);
    const keys = new Set(groups.map(group => group.anchorId));
    for (const key of [...entries.keys()]) if (!keys.has(key)) removeEntry(key);
    for (const group of groups) {
      const person = people.get(group.anchorId)!;
      let entry = entries.get(group.anchorId);
      if (!entry) {
        try { entry = createEntry(group, person); entries.set(group.anchorId, entry); }
        catch { continue; }
      }
      entry.circleIds = [...group.circleIds];
      entry.marker.setLngLat([person.longitude, person.latitude]);
      const cluster = group.circleIds.length > 1;
      entry.element.dataset.cluster = String(cluster);
      entry.portrait.textContent = cluster ? String(group.circleIds.length) : initials(person.user.displayName);
      const label = cluster ? `Близкие рядом: ${group.circleIds.length}. Открыть список` : friendLabel(person);
      entry.element.setAttribute("aria-label", label); entry.element.title = label;
    }
    // MutationObserver has no unobserve(node). Rebind only the current bounded
    // set so panning never retains detached markers from previous viewports.
    observer?.disconnect();
    for (const entry of entries.values()) observer?.observe(entry.element, { attributes: true, attributeFilter: ["class"] });
    synchronizeAccessibility();
  }
  const onCamera = () => { if (visible) reconcile(); };
  map.on("move", onCamera); map.on("resize", onCamera); map.on("idle", onCamera);
  return {
    setSnapshot(snapshot: readonly EarthMapPerson[]) {
      if (disposed || !visible) return;
      const now = environment.now();
      const next = new Map<string, EarthMapPerson>();
      for (const person of snapshot.slice(0, EARTH_SHARING_MAX_PEOPLE)) {
        if (!person || !person.circleId || next.has(person.circleId) || !person.user?.displayName
          || !Number.isFinite(person.expiresAtMonotonic) || person.expiresAtMonotonic <= now
          || person.expiresAtMonotonic > now + EARTH_POSITION_TTL_MS
          || !Number.isFinite(person.longitude) || Math.abs(person.longitude) > 180
          || !Number.isFinite(person.latitude) || Math.abs(person.latitude) > 90
          || !Number.isFinite(person.accuracyMeters) || person.accuracyMeters < 0 || person.accuracyMeters > 100_000
          || !["APPROXIMATE", "PRECISE"].includes(person.precision)
          || person.precision === "APPROXIMATE" && person.accuracyMeters < 1_500) continue;
        const previous = people.get(person.circleId);
        const expiresAtMonotonic = previous?.updatedAt === person.updatedAt && previous.expiresAt === person.expiresAt
          ? Math.min(previous.expiresAtMonotonic, person.expiresAtMonotonic) : person.expiresAtMonotonic;
        next.set(person.circleId, { ...person, user: { ...person.user }, expiresAtMonotonic });
      }
      people = next; reconcile(); armExpiry();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value;
      if (!value) clear();
      // Becoming visible never restores an old location snapshot.
    },
    setSelfPosition(value: EarthPosition | null) {
      if (disposed || !visible) return;
      selfPosition = value ? { ...value } : null; reconcile();
    },
    focusFriend(circleId: string): boolean {
      if (disposed || !visible) return false;
      const person = people.get(circleId);
      if (!person || person.expiresAtMonotonic <= environment.now()) return false;
      map.flyTo({ center: [person.longitude, person.latitude], zoom: Math.min(14, positionZoom(person.accuracyMeters)),
        duration: environment.reducedMotion() ? 0 : 900, essential: false });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; visible = false; clear();
      map.off("move", onCamera); map.off("resize", onCamera); map.off("idle", onCamera);
    },
  };
}
