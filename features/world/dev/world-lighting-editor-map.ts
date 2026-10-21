import type { WorldLight, WorldPoint, WorldShadowCaster, WorldShadowReceiver } from "@/features/world/tiled/types";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import { validateForestReceiverHoles } from "@/features/world/environment/lighting/forest-receiver-geometry";
import { WORLD_LIGHTING_LIGHT_PRESETS, worldLightingEditorStore, type WorldLightingEditorTool, type WorldLightingElementSelection } from "./world-lighting-editor-store";
import type { WorldStudioKeyboardInput } from "./world-studio-keyboard";

export const WORLD_LIGHTING_EDITOR_FOCUS_EVENT = "world-lighting-editor:focus";
export type WorldLightingEditorFocus = { point: WorldPoint; bounds?: { x: number; y: number; width: number; height: number } };
let pendingFocus: WorldLightingEditorFocus | "selection" | null = null;
/** A request from the circle survives the full map's asynchronous mounting. */
export function requestWorldLightingEditorFocus(request?: WorldLightingEditorFocus) {
  pendingFocus = request ?? "selection";
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") window.dispatchEvent?.(new CustomEvent(WORLD_LIGHTING_EDITOR_FOCUS_EVENT, { detail: pendingFocus }));
}
export function takeWorldLightingEditorFocus() { const request = pendingFocus; pendingFocus = null; return request; }
export const WORLD_STUDIO_CREATE_EVENT = "world-studio:create";
export type WorldStudioCreateKind = "caster" | "receiver" | "receiver-hole";
let pendingCreation: WorldStudioCreateKind | null = null;
/** The active map resolves its visible centre when the request is handled. */
export function requestWorldStudioCreate(kind: WorldStudioCreateKind) {
  if (kind !== "caster" && kind !== "receiver" && kind !== "receiver-hole") return;
  pendingCreation = kind;
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") window.dispatchEvent?.(new CustomEvent(WORLD_STUDIO_CREATE_EVENT, { detail: kind }));
}
export function takeWorldStudioCreate() { const kind = pendingCreation; pendingCreation = null; return kind; }
function closestEdge(point: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const position = { x: a.x + t * dx, y: a.y + t * dy };
  return { distance: Math.hypot(point.x - position.x, point.y - position.y), position };
}
function hits(point: WorldPoint, polygon: readonly WorldPoint[], radius: number) {
  return previewPointInPolygon(point, polygon) || polygon.some((a, i) => closestEdge(point, a, polygon[(i + 1) % polygon.length]).distance <= radius);
}
const center = (points: readonly WorldPoint[]) => ({ x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const topPoints = (caster: WorldShadowCaster) => caster.points.map(p => ({ x: p.x, y: p.y - caster.baseHeight - caster.height }));
type EditorOptions = { getLights?: () => readonly WorldLight[]; getReceivers?: () => readonly WorldShadowReceiver[]; onFocus?: (request: WorldLightingEditorFocus) => void };
export type WorldLightingEditorPointerModifiers = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
type Drag = { id: string; kind: "caster" | "receiver" | "light"; start: WorldPoint } & (
  | { type: "vertex"; vertex: number; hole: number | null } | { type: "move"; origin: WorldPoint; elements: readonly WorldLightingElementSelection[]; delta: WorldPoint }
  | { type: "height"; handle: "base" | "top"; base: number; top: number }
  | { type: "receiverHeight"; height: number }
  | { type: "radius"; origin: WorldPoint } | { type: "lightHeight"; origin: WorldPoint; height: number }
);

/** Only independent lighting data is editable; generated sources need an authored Lights ID. */
export function createWorldLightingEditorMap(getCasters: () => readonly WorldShadowCaster[], store = worldLightingEditorStore, options?: EditorOptions) {
  let dragging: (Drag & { moved: boolean }) | null = null, placement: WorldPoint | null = null, ghost: WorldPoint | null = null, spaceHeld = false;
  let dragThreshold = .1;
  const snap = (value: number) => { const step = store.getSnapshot().snap || .1; return Math.round(Math.round(value / step) * step * 1000) / 1000; };
  const pointSnap = (point: WorldPoint) => ({ x: snap(point.x), y: snap(point.y) });
  // Preserve vertex gestures in the original two-argument API.
  const tool = () => !store.getSnapshot().previewDraft ? "select" : options ? store.getSnapshot().tool : "vertex";
  const casters = () => {
    const effective = getCasters();
    if (store.getSnapshot().previewDraft) return effective;
    const ids = new Set(store.getSceneBaseline().shadowCasters?.map(caster => caster.id));
    return effective.filter(caster => ids.has(caster.id));
  };
  const lights = () => {
    const authored = store.getSnapshot().previewDraft ? store.getSnapshot().lights : store.getSceneBaseline().lights ?? [];
    const ids = new Set(authored.map(light => light.id));
    return (options?.getLights?.() ?? authored).filter(light => ids.has(light.id));
  };
  const receivers = () => {
    const authored = store.getSnapshot().previewDraft ? store.getSnapshot().receivers : store.getSceneBaseline().shadowReceivers ?? [];
    const effective = options?.getReceivers?.() ?? authored;
    if (store.getSnapshot().previewDraft) return effective;
    const ids = new Set(authored.map(receiver => receiver.id));
    return effective.filter(receiver => ids.has(receiver.id));
  };
  const selectedReceiver = () => receivers().find(receiver => receiver.id === store.getSnapshot().selectedId);
  const selectedCaster = () => casters().find(caster => caster.id === store.getSnapshot().selectedId);
  const selectedLight = () => lights().find(light => light.id === store.getSnapshot().selectedId);
  const selectedKind = () => store.getSnapshot().selectedKind ?? "caster";
  const selectedPolygon = () => selectedKind() === "receiver" ? selectedReceiver() : selectedKind() === "caster" ? selectedCaster() : undefined;
  const selectedContour = () => {
    const polygon = selectedPolygon(), hole = store.getSnapshot().selectedHole;
    return selectedKind() === "receiver" && hole !== null ? (polygon as WorldShadowReceiver | undefined)?.holes?.[hole] : polygon?.points;
  };
  const isSelected = (kind: WorldLightingElementSelection["kind"], id: string) => store.getSnapshot().selectedElements.some(element => element.kind === kind && element.id === id);
  const selectPolygon = (kind: "caster" | "receiver", id: string, vertex: number | null = null) => kind === "receiver" ? store.selectReceiver(id, vertex) : store.select(id, vertex);
  const polygonCandidates = () => {
    const state = store.getSnapshot();
    return [
      ...casters().filter(caster => !store.isElementHidden("caster", caster.id) && (state.showCasters || isSelected("caster", caster.id))).map(item => ({ kind: "caster" as const, item })),
      ...receivers().filter(receiver => !store.isElementHidden("receiver", receiver.id) && (state.showReceivers || isSelected("receiver", receiver.id))).map(item => ({ kind: "receiver" as const, item })),
    ].sort((a, b) => Number(a.kind !== selectedKind() || a.item.id !== state.selectedId) - Number(b.kind !== selectedKind() || b.item.id !== state.selectedId));
  };
  const cancel = () => {
    const active = dragging; dragging = null; placement = null;
    if (active && store.getSnapshot().selectedId === active.id && selectedKind() === active.kind) store.cancelGesture();
  };
  const start = (drag: Drag) => { store.beginGesture(); dragging = { ...drag, moved: false }; return true; };
  const selectAt = (kind: WorldLightingElementSelection["kind"], id: string, modifiers?: WorldLightingEditorPointerModifiers) => {
    if (modifiers?.ctrlKey || modifiers?.metaKey) { store.selectElement(kind, id, { toggle: true }); return false; }
    // Keep the whole selection when dragging one of its members, while making
    // the clicked member the primary anchor for snapping and its inspector.
    if (tool() === "move" && isSelected(kind, id)) store.selectElements(store.getSnapshot().selectedElements, { kind, id });
    else store.selectElement(kind, id);
    return true;
  };
  const startMove = (kind: WorldLightingElementSelection["kind"], id: string, point: WorldPoint, origin: WorldPoint) => {
    const elements = store.getSnapshot().selectedElements;
    if (elements.some(element => store.isElementLocked(element.kind, element.id))) return true;
    if (store.getSnapshot().previewDraft) store.setLightProjections(lights().map(light => ({ id: light.id, position: light.position, height: light.height ?? 24 })));
    return start({ id, kind, type: "move", start: point, origin, elements: [...elements], delta: { x: 0, y: 0 } });
  };
  const receiverHit = (point: WorldPoint, receiver: WorldShadowReceiver, radius: number) => {
    const edges = [receiver.points, ...(receiver.holes ?? [])];
    const nearEdge = edges.some(points => points.some((a, i) => closestEdge(point, a, points[(i + 1) % points.length]).distance <= radius));
    return nearEdge || previewPointInPolygon(point, receiver.points) && !(receiver.holes ?? []).some(hole => previewPointInPolygon(point, hole));
  };
  const focus = (): WorldLightingEditorFocus | null => {
    const points: WorldPoint[] = [];
    for (const element of store.getSnapshot().selectedElements) {
      if (element.kind === "light") {
        const light = lights().find(value => value.id === element.id); if (!light) continue;
        points.push({ x: light.position.x - light.radius, y: light.position.y - light.radius },
          { x: light.position.x + light.radius, y: light.position.y + light.radius + (light.height ?? 24) });
      } else {
        const polygon = element.kind === "caster" ? casters().find(value => value.id === element.id) : receivers().find(value => value.id === element.id);
        if (polygon) points.push(...polygon.points, ...(element.kind === "caster" ? topPoints(polygon as WorldShadowCaster) : []));
      }
    }
    if (!points.length) return null;
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) - x, height = Math.max(...points.map(p => p.y)) - y;
    return { point: { x: x + width / 2, y: y + height / 2 }, bounds: { x, y, width, height } };
  };
  const createReceiverHole = (preferred: WorldPoint) => {
    const receiver = selectedReceiver();
    if (!receiver || selectedKind() !== "receiver" || !store.getSnapshot().previewDraft || store.isElementLocked("receiver", receiver.id)) return false;
    const left = Math.min(...receiver.points.map(point => point.x)), right = Math.max(...receiver.points.map(point => point.x));
    const top = Math.min(...receiver.points.map(point => point.y)), bottom = Math.max(...receiver.points.map(point => point.y));
    const candidates = [preferred, center(receiver.points)];
    for (let y = 1; y < 10; y++) for (let x = 1; x < 10; x++) candidates.push({ x: left + (right - left) * x / 10, y: top + (bottom - top) * y / 10 });
    candidates.sort((a, b) => distance(a, preferred) - distance(b, preferred));
    const size = Math.min(32, (right - left) / 5, (bottom - top) / 5);
    for (const scale of [1, .5, .25, .125, .0625]) {
      const half = size * scale;
      if (half < .2) continue;
      for (const candidate of candidates) {
        const polygon = [pointSnap({ x: candidate.x - half, y: candidate.y - half }), pointSnap({ x: candidate.x + half, y: candidate.y - half }),
          pointSnap({ x: candidate.x + half, y: candidate.y + half }), pointSnap({ x: candidate.x - half, y: candidate.y + half })];
        if (validateForestReceiverHoles(receiver.points, [...(receiver.holes ?? []), polygon])) continue;
        if (!store.addReceiverHole(polygon)) return false;
        store.setTool("vertex"); return true;
      }
    }
    store.reportError("Не удалось разместить исключение внутри поверхности. Уменьшите шаг привязки или выберите более просторную поверхность.");
    return false;
  };
  return {
    cancel, focus, createReceiverHole,
    isPanning: () => spaceHeld || tool() === "pan",
    down(point: WorldPoint, radius: number, modifiers?: WorldLightingEditorPointerModifiers) {
      if (!store.getSnapshot().enabled || spaceHeld || tool() === "pan") return false;
      dragThreshold = radius * .2;
      ghost = pointSnap(point);
      if (tool() === "light") { placement = ghost; return true; }
      const selected = store.getSnapshot().selectedId;
      const additive = Boolean(modifiers?.ctrlKey || modifiers?.metaKey);
      const selectedSource = selectedKind() === "light" && selected && !store.isElementHidden("light", selected) ? selectedLight() : undefined;
      if (selectedSource && !additive && !store.isElementLocked("light", selectedSource.id)) {
        const bulb = selectedSource.position, height = selectedSource.height ?? 24;
        if (tool() === "height" && distance(point, bulb) <= radius) return start({ id: selectedSource.id, kind: "light", type: "lightHeight", start: point, origin: bulb, height });
        if (tool() !== "vertex" && distance(point, { x: bulb.x + selectedSource.radius, y: bulb.y }) <= radius) return start({ id: selectedSource.id, kind: "light", type: "radius", start: point, origin: bulb });
      }
      const selectedVolume = selectedKind() === "caster" && selected && !store.isElementHidden("caster", selected) && !store.isElementLocked("caster", selected) && !additive ? selectedCaster() : undefined;
      const selectedSurface = selectedKind() === "receiver" && selected && !store.isElementHidden("receiver", selected) && !store.isElementLocked("receiver", selected) && !additive ? selectedReceiver() : undefined;
      if (selectedSurface && tool() === "height" && distance(point, center(selectedSurface.points)) <= radius) {
        return start({ id: selectedSurface.id, kind: "receiver", type: "receiverHeight", start: point, height: selectedSurface.height });
      }
      if (selectedVolume && tool() === "height") {
        const anchor = center(selectedVolume.points);
        for (const handle of ["top", "base"] as const) {
          const height = handle === "top" ? selectedVolume.baseHeight + selectedVolume.height : selectedVolume.baseHeight;
          if (distance(point, { x: anchor.x, y: anchor.y - height }) <= radius) return start({ id: selectedVolume.id, kind: "caster", type: "height", handle, start: point, base: selectedVolume.baseHeight, top: selectedVolume.baseHeight + selectedVolume.height });
        }
      }
      const sources = [...lights()].filter(light => !store.isElementHidden("light", light.id)).sort((a, b) => Number(a.id !== selected) - Number(b.id !== selected));
      for (const light of sources) {
        if (distance(point, light.position) > radius) continue;
        if (!selectAt("light", light.id, modifiers) || store.isElementLocked("light", light.id)) return true;
        if (tool() === "height") return start({ id: light.id, kind: "light", type: "lightHeight", start: point, origin: light.position, height: light.height ?? 24 });
        if (tool() === "move") return startMove("light", light.id, point, light.position);
        return true;
      }
      const visible = polygonCandidates();
      if (tool() === "vertex" && !additive) {
        for (const { kind, item } of visible) {
          const contours = [{ hole: null, points: item.points }, ...(kind === "receiver" ? ((item as WorldShadowReceiver).holes ?? []).map((points, hole) => ({ hole, points })) : [])];
          for (const contour of contours) {
            const vertex = contour.points.findIndex(p => distance(p, point) <= radius);
            if (vertex < 0) continue;
            selectPolygon(kind, item.id, vertex);
            if (kind === "receiver") store.selectHole(contour.hole, vertex);
            if (store.isElementLocked(kind, item.id)) return true;
            return start({ id: item.id, kind, type: "vertex", hole: contour.hole, vertex, start: point });
          }
        }
        const selectedOutline = selectedPolygon(), contour = selectedContour();
        if (selectedOutline && contour && contour.length < 64 && selected && !store.isElementHidden(selectedKind(), selected) && !store.isElementLocked(selectedKind(), selected)) {
          const edge = contour.map((a, i) => ({ i, ...closestEdge(point, a, contour[(i + 1) % contour.length]) })).sort((a, b) => a.distance - b.distance)[0];
          if (edge.distance <= radius * .7) {
            const hole = store.getSnapshot().selectedHole;
            store.beginGesture(); store.addVertex(edge.i, pointSnap(edge.position));
            if (store.getSnapshot().error) { store.commitGesture(); return true; }
            const kind = selectedKind() === "receiver" ? "receiver" : "caster";
            if (kind === "receiver") store.selectHole(hole, edge.i + 1); else selectPolygon(kind, selectedOutline.id, edge.i + 1);
            dragging = { id: selectedOutline.id, kind, type: "vertex", hole, vertex: edge.i + 1, start: point, moved: false }; return true;
          }
        }
      }
      for (const { kind, item } of visible) {
        if (kind === "receiver" ? !receiverHit(point, item as WorldShadowReceiver, radius) : !hits(point, item.points, radius) && !hits(point, topPoints(item as WorldShadowCaster), radius)) continue;
        if (!selectAt(kind, item.id, modifiers) || store.isElementLocked(kind, item.id)) return true;
        if (tool() === "move") return startMove(kind, item.id, point, item.points[0]);
        return true;
      }
      return false;
    },
    hover(point: WorldPoint | null) { ghost = point && pointSnap(point); },
    move(point: WorldPoint) {
      ghost = pointSnap(point);
      if (placement) { placement = ghost; return; }
      if (!dragging) return;
      if (!store.getSnapshot().enabled || store.getSnapshot().selectedId !== dragging.id || selectedKind() !== dragging.kind) { cancel(); return; }
      const drag = dragging;
      if (drag.type === "vertex" && store.getSnapshot().selectedHole !== drag.hole) { cancel(); return; }
      if (drag.type === "move" && (store.getSnapshot().selectedElements.length !== drag.elements.length
        || drag.elements.some(element => !isSelected(element.kind, element.id)))) { cancel(); return; }
      if (!drag.moved && distance(point, drag.start) <= dragThreshold) return;
      drag.moved = true;
      if (drag.type === "vertex") store.moveVertex(drag.vertex, pointSnap(point));
      else if (drag.type === "move") {
        const destination = pointSnap({ x: drag.origin.x + point.x - drag.start.x, y: drag.origin.y + point.y - drag.start.y });
        const delta = { x: destination.x - drag.origin.x, y: destination.y - drag.origin.y };
        if (store.moveElementsBy(delta.x - drag.delta.x, delta.y - drag.delta.y, drag.elements)) drag.delta = delta;
      } else if (drag.type === "height") {
        const change = drag.start.y - point.y;
        if (drag.handle === "top") store.patchSelected({ height: clamp(snap(drag.top + change), drag.base + .1, Math.min(400, drag.base + 300)) - drag.base });
        else { const base = clamp(snap(drag.base + change), Math.max(0, drag.top - 300), drag.top - .1); store.patchSelected({ baseHeight: base, height: drag.top - base }); }
      } else if (drag.type === "receiverHeight") store.patchReceiver({ height: clamp(snap(drag.height + drag.start.y - point.y), 0, 300) });
      else if (drag.type === "radius") store.patchLight({ radius: clamp(snap(distance(point, drag.origin)), 1, 500) });
      else {
        const height = clamp(snap(drag.height + drag.start.y - point.y), 1, 200);
        store.patchLight({ height, position: { x: drag.origin.x, y: drag.origin.y + drag.height - height } });
      }
    },
    end(cancelled: boolean) {
      if (placement) {
        const point = placement; placement = null;
        if (!cancelled && store.getSnapshot().enabled && tool() === "light") { if (store.addLight(point, store.getSnapshot().lightKind)) store.setTool("select"); }
        return;
      }
      if (!dragging) return;
      const active = dragging; dragging = null;
      if (store.getSnapshot().selectedId !== active.id || selectedKind() !== active.kind) return;
      if (cancelled) store.cancelGesture(); else store.commitGesture();
    },
    key(event: WorldStudioKeyboardInput) {
      const state = store.getSnapshot();
      const target = event.target as HTMLElement | null;
      if (!state.enabled || event.isComposing || target?.isContentEditable || target?.closest?.("input,textarea,select,[contenteditable=true]")) return false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        cancel(); if (state.previewDraft) { if (event.shiftKey) store.redo(); else store.undo(); } return true;
      }
      if (event.key === "Escape") {
        cancel(); spaceHeld = false;
        if (tool() === "light") store.setTool("select");
        else if (state.selectedKind === "light") store.selectLight(state.selectedId);
        else if (state.selectedKind === "receiver") store.selectReceiver(state.selectedId, null);
        else store.select(state.selectedId, null);
        return true;
      }
      if (event.code === "Space" || event.key === " ") { cancel(); spaceHeld = true; return true; }
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      const shortcuts: Readonly<Record<string, WorldLightingEditorTool>> = { v: "select", g: "move", p: "vertex", h: "height", l: "light" };
      const shortcut = shortcuts[event.key.toLowerCase()];
      if (shortcut) { cancel(); store.setTool(shortcut); return true; }
      if (event.key.toLowerCase() === "f") { const request = focus(); if (request) (options?.onFocus ?? requestWorldLightingEditorFocus)(request); return true; }
      if (!state.previewDraft) return event.key === "Delete" || event.key === "Backspace";
      if ((event.key === "Delete" || event.key === "Backspace") && state.selectedId) {
        cancel();
        if (selectedKind() !== "light" && state.selectedVertex !== null && tool() === "vertex") store.deleteVertex(state.selectedVertex);
        else if (selectedKind() === "receiver" && state.selectedHole !== null && tool() === "vertex") store.removeReceiverHole(state.selectedHole);
        else store.removeElements();
        return true;
      }
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (!delta || !state.selectedId) return false;
      const step = event.shiftKey ? 10 : state.snap || 1;
      if (tool() === "move") {
        store.setLightProjections(lights().map(light => ({ id: light.id, position: light.position, height: light.height ?? 24 })));
        store.moveElementsBy(delta[0] * step, delta[1] * step); return true;
      }
      if (selectedKind() === "light") {
        const light = selectedLight(); if (!light) return false;
        store.setLightProjections(lights().map(value => ({ id: value.id, position: value.position, height: value.height ?? 24 })));
        store.moveElementsBy(delta[0] * step, delta[1] * step); return true;
      }
      const vertex = state.selectedVertex !== null ? selectedContour()?.[state.selectedVertex] : undefined;
      if (tool() === "vertex" && vertex && state.selectedVertex !== null) { store.moveVertex(state.selectedVertex, { x: vertex.x + delta[0] * step, y: vertex.y + delta[1] * step }); return true; }
      return false;
    },
    keyUp(event: WorldStudioKeyboardInput) {
      if (event.code !== "Space" && event.key !== " ") return false;
      const held = spaceHeld; spaceHeld = false; return held;
    },
    blur() { spaceHeld = false; ghost = null; cancel(); },
    draw(ctx: CanvasRenderingContext2D, project: (point: WorldPoint) => WorldPoint) {
      const state = store.getSnapshot(); if (!state.enabled) return;
      const frameLights = lights(); // Refresh view metadata even when the guides are hidden.
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.lineWidth = 1.5; ctx.font = "12px sans-serif";
      const contour = (points: readonly WorldPoint[], begin = true) => { if (begin) ctx.beginPath(); points.forEach((p, i) => { const s = project(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }); ctx.closePath(); };
      let guideColor = "#dfb5ff";
      const handle = (point: WorldPoint, label?: string, active = false) => {
        const p = project(point); ctx.beginPath(); ctx.arc(p.x, p.y, active ? 6 : 5, 0, Math.PI * 2); ctx.fillStyle = active ? "#fff5ac" : guideColor; ctx.fill(); ctx.strokeStyle = "#152a25"; ctx.stroke();
        if (label) { ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3; ctx.strokeText(label, p.x + 8, p.y - 6); ctx.fillText(label, p.x + 8, p.y - 6); ctx.lineWidth = 1.5; }
      };
      const circle = (point: WorldPoint, radius: number) => { const p = project(point), edge = project({ x: point.x + radius, y: point.y }); ctx.beginPath(); ctx.arc(p.x, p.y, distance(p, edge), 0, Math.PI * 2); ctx.stroke(); };
      if (state.overlay !== "off") {
        for (const caster of casters()) {
          const selected = isSelected("caster", caster.id), primary = selectedKind() === "caster" && caster.id === state.selectedId;
          if (store.isElementHidden("caster", caster.id)) continue;
          if (state.overlay === "selected" && !selected || !state.showCasters && !selected) continue;
          guideColor = "#dfb5ff"; ctx.strokeStyle = selected ? "#dfb5ff" : "#a786c1"; ctx.fillStyle = selected ? "rgba(201,140,255,.12)" : "rgba(201,140,255,.04)";
          ctx.setLineDash(store.isElementLocked("caster", caster.id) ? [3, 3] : []); contour(caster.points); ctx.fill(); ctx.stroke();
          if (!selected) continue;
          const top = topPoints(caster);
          if (state.showWireframe) {
            const bottom = caster.points.map(p => ({ x: p.x, y: p.y - caster.baseHeight }));
            if (caster.baseHeight > 0) {
              // The footprint is projected to the ground; the blocking prism
              // begins above it, leaving a real gap below a raised canopy.
              ctx.globalAlpha = .45; ctx.setLineDash([2, 5]);
              ctx.beginPath(); caster.points.forEach((p, i) => { const a = project(p), b = project(bottom[i]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke();
              ctx.globalAlpha = 1; ctx.setLineDash([]); contour(bottom); ctx.stroke();
            }
            ctx.setLineDash([4, 4]); contour(top); ctx.stroke();
            ctx.beginPath(); bottom.forEach((p, i) => { const a = project(p), b = project(top[i]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke(); ctx.setLineDash([]);
          }
          if (primary && !store.isElementLocked("caster", caster.id)) {
            if (tool() === "vertex") caster.points.forEach((p, i) => handle(p, String(i + 1), state.selectedVertex === i));
            if (tool() === "height") { const anchor = center(caster.points); handle({ x: anchor.x, y: anchor.y - caster.baseHeight }, "Низ " + caster.baseHeight); handle({ x: anchor.x, y: anchor.y - caster.baseHeight - caster.height }, "Верх " + (caster.baseHeight + caster.height)); }
            if (tool() === "move") handle(center(caster.points), state.selectedElements.length > 1 ? "Переместить выбранные" : "Переместить объём");
          }
          const label = project(top[0]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3;
          const text = "Объём · " + (caster.studioName ?? caster.id) + " · " + caster.baseHeight + "–" + (caster.baseHeight + caster.height);
          ctx.strokeText(text, label.x + 5, label.y - 9); ctx.fillText(text, label.x + 5, label.y - 9); ctx.lineWidth = 1.5;
        }
        for (const receiver of receivers()) {
          const selected = isSelected("receiver", receiver.id), primary = selectedKind() === "receiver" && receiver.id === state.selectedId;
          if (store.isElementHidden("receiver", receiver.id)) continue;
          if (state.overlay === "selected" && !selected || !state.showReceivers && !selected) continue;
          guideColor = "#7dcfff"; ctx.strokeStyle = selected ? "#7dcfff" : "#5897c5"; ctx.fillStyle = selected ? "rgba(95,189,255,.12)" : "rgba(95,189,255,.025)";
          ctx.setLineDash(store.isElementLocked("receiver", receiver.id) ? [3, 3] : []); contour(receiver.points);
          for (const hole of receiver.holes ?? []) contour(hole, false);
          ctx.fill("evenodd"); ctx.stroke();
          for (const [index, hole] of (receiver.holes ?? []).entries()) {
            ctx.setLineDash([5, 4]); ctx.strokeStyle = primary && state.selectedHole === index ? "#fff5ac" : "#ffae8a";
            contour(hole); ctx.stroke();
          }
          ctx.setLineDash([]); ctx.strokeStyle = selected ? "#7dcfff" : "#5897c5";
          if (!selected) continue;
          if (state.showWireframe && receiver.height > 0) {
            const ground = receiver.points.map(p => ({ x: p.x, y: p.y + receiver.height }));
            ctx.setLineDash([4, 4]); contour(ground); ctx.stroke();
            ctx.beginPath(); receiver.points.forEach((p, i) => { const a = project(p), b = project(ground[i]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke(); ctx.setLineDash([]);
          }
          if (primary && !store.isElementLocked("receiver", receiver.id)) {
            if (tool() === "vertex") (selectedContour() ?? receiver.points).forEach((p, i) => handle(p, String(i + 1), state.selectedVertex === i));
            if (tool() === "height") handle(center(receiver.points), "Высота поверхности " + receiver.height);
            if (tool() === "move") handle(center(receiver.points), state.selectedElements.length > 1 ? "Переместить выбранные" : "Переместить поверхность");
          }
          const label = project(receiver.points[0]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3;
          const text = "Поверхность · " + (receiver.studioName ?? receiver.id) + " · принимает тени";
          ctx.strokeText(text, label.x + 5, label.y - 9); ctx.fillText(text, label.x + 5, label.y - 9); ctx.lineWidth = 1.5;
        }
        for (const light of frameLights) {
          const selected = isSelected("light", light.id), primary = selectedKind() === "light" && light.id === state.selectedId;
          if (store.isElementHidden("light", light.id)) continue;
          if (state.overlay === "selected" && !selected) continue;
          guideColor = "#ffdf78"; ctx.setLineDash(light.enabled === false || light.intensity === 0 ? [3, 3] : []); ctx.strokeStyle = selected ? "#ffdf78" : "#e2b977";
          if (selected) circle(light.position, light.radius);
          ctx.setLineDash([]); handle(light.position, selected ? light.studioName ?? light.id : undefined, selected);
          if (!primary || store.isElementLocked("light", light.id)) continue;
          handle({ x: light.position.x + light.radius, y: light.position.y }, "Радиус " + light.radius);
          if (tool() === "height") {
            const ground = project({ x: light.position.x, y: light.position.y + (light.height ?? 24) }), bulb = project(light.position);
            ctx.strokeStyle = "#ffdf78"; ctx.beginPath(); ctx.moveTo(ground.x, ground.y); ctx.lineTo(bulb.x, bulb.y); ctx.stroke();
            handle({ x: light.position.x, y: light.position.y + (light.height ?? 24) }, "Земля"); handle(light.position, "Высота " + (light.height ?? 24), true);
          }
        }
      }
      if (tool() === "light" && ghost) {
        guideColor = "#ffdf78"; ctx.strokeStyle = "#ffdf78"; ctx.setLineDash([5, 5]); circle(ghost, WORLD_LIGHTING_LIGHT_PRESETS[state.lightKind].radius);
        ctx.setLineDash([]); handle(ghost, "Щёлкните, чтобы поставить источник", true);
      }
      ctx.restore();
    },
  };
}
