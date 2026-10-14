import type { WorldLight, WorldPoint, WorldShadowCaster, WorldShadowReceiver } from "@/features/world/tiled/types";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import { WORLD_LIGHTING_LIGHT_PRESETS, worldLightingEditorStore, type WorldLightingEditorTool } from "./world-lighting-editor-store";

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
export type WorldStudioCreateKind = "caster" | "receiver";
let pendingCreation: WorldStudioCreateKind | null = null;
/** The active map resolves its visible centre when the request is handled. */
export function requestWorldStudioCreate(kind: WorldStudioCreateKind) {
  if (kind !== "caster" && kind !== "receiver") return;
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
type Drag = { id: string; kind: "caster" | "receiver" | "light"; start: WorldPoint } & (
  | { type: "vertex"; vertex: number } | { type: "move"; origin: WorldPoint }
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
  const selectPolygon = (kind: "caster" | "receiver", id: string, vertex: number | null = null) => kind === "receiver" ? store.selectReceiver(id, vertex) : store.select(id, vertex);
  const polygonCandidates = () => {
    const state = store.getSnapshot();
    return [
      ...casters().filter(caster => state.showCasters || selectedKind() === "caster" && caster.id === state.selectedId).map(item => ({ kind: "caster" as const, item })),
      ...receivers().filter(receiver => state.showReceivers || selectedKind() === "receiver" && receiver.id === state.selectedId).map(item => ({ kind: "receiver" as const, item })),
    ].sort((a, b) => Number(a.kind !== selectedKind() || a.item.id !== state.selectedId) - Number(b.kind !== selectedKind() || b.item.id !== state.selectedId));
  };
  const cancel = () => {
    const active = dragging; dragging = null; placement = null;
    if (active && store.getSnapshot().selectedId === active.id && selectedKind() === active.kind) store.cancelGesture();
  };
  const start = (drag: Drag) => { store.beginGesture(); dragging = { ...drag, moved: false }; return true; };
  const focus = (): WorldLightingEditorFocus | null => {
    if (selectedKind() === "light") {
      const light = selectedLight(); if (!light) return null;
      return { point: light.position, bounds: { x: light.position.x - light.radius, y: light.position.y - light.radius,
        width: light.radius * 2, height: light.radius * 2 + (light.height ?? 24) } };
    }
    const polygon = selectedPolygon(); if (!polygon) return null;
    const points = selectedKind() === "caster" ? polygon.points.concat(topPoints(polygon as WorldShadowCaster)) : polygon.points;
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) - x, height = Math.max(...points.map(p => p.y)) - y;
    return { point: { x: x + width / 2, y: y + height / 2 }, bounds: { x, y, width, height } };
  };
  return {
    cancel, focus,
    isPanning: () => spaceHeld || tool() === "pan",
    down(point: WorldPoint, radius: number) {
      if (!store.getSnapshot().enabled || spaceHeld || tool() === "pan") return false;
      dragThreshold = radius * .2;
      ghost = pointSnap(point);
      if (tool() === "light") { placement = ghost; return true; }
      const selected = store.getSnapshot().selectedId;
      const selectedSource = selectedKind() === "light" ? selectedLight() : undefined;
      if (selectedSource) {
        const bulb = selectedSource.position, height = selectedSource.height ?? 24;
        if (tool() === "height" && distance(point, bulb) <= radius) return start({ id: selectedSource.id, kind: "light", type: "lightHeight", start: point, origin: bulb, height });
        if (tool() !== "vertex" && distance(point, { x: bulb.x + selectedSource.radius, y: bulb.y }) <= radius) return start({ id: selectedSource.id, kind: "light", type: "radius", start: point, origin: bulb });
      }
      const selectedVolume = selectedKind() === "caster" ? selectedCaster() : undefined;
      const selectedSurface = selectedKind() === "receiver" ? selectedReceiver() : undefined;
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
      const sources = [...lights()].sort((a, b) => Number(a.id !== selected) - Number(b.id !== selected));
      for (const light of sources) {
        if (distance(point, light.position) > radius) continue;
        store.selectLight(light.id);
        if (tool() === "height") return start({ id: light.id, kind: "light", type: "lightHeight", start: point, origin: light.position, height: light.height ?? 24 });
        if (tool() === "move") return start({ id: light.id, kind: "light", type: "move", start: point, origin: light.position });
        return true;
      }
      const visible = polygonCandidates();
      if (tool() === "vertex") {
        for (const { kind, item } of visible) {
          const vertex = item.points.findIndex(p => distance(p, point) <= radius);
          if (vertex < 0) continue;
          selectPolygon(kind, item.id, vertex); return start({ id: item.id, kind, type: "vertex", vertex, start: point });
        }
        const selectedOutline = selectedPolygon();
        if (selectedOutline && selectedOutline.points.length < 64) {
          const edge = selectedOutline.points.map((a, i) => ({ i, ...closestEdge(point, a, selectedOutline.points[(i + 1) % selectedOutline.points.length]) })).sort((a, b) => a.distance - b.distance)[0];
          if (edge.distance <= radius * .7) {
            store.beginGesture(); store.addVertex(edge.i, pointSnap(edge.position));
            if (store.getSnapshot().error) { store.commitGesture(); return true; }
            const kind = selectedKind() === "receiver" ? "receiver" : "caster";
            selectPolygon(kind, selectedOutline.id, edge.i + 1);
            dragging = { id: selectedOutline.id, kind, type: "vertex", vertex: edge.i + 1, start: point, moved: false }; return true;
          }
        }
      }
      for (const { kind, item } of visible) {
        if (!hits(point, item.points, radius) && !(kind === "caster" && hits(point, topPoints(item as WorldShadowCaster), radius))) continue;
        selectPolygon(kind, item.id);
        if (tool() === "move") return start({ id: item.id, kind, type: "move", start: point, origin: item.points[0] });
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
      if (!drag.moved && distance(point, drag.start) <= dragThreshold) return;
      drag.moved = true;
      if (drag.type === "vertex") store.moveVertex(drag.vertex, pointSnap(point));
      else if (drag.type === "move") {
        const destination = pointSnap({ x: drag.origin.x + point.x - drag.start.x, y: drag.origin.y + point.y - drag.start.y });
        if (drag.kind === "light") store.patchLight({ position: destination });
        else { const current = selectedPolygon()?.points[0]; if (current) store.moveSelectedBy(destination.x - current.x, destination.y - current.y); }
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
    key(event: KeyboardEvent) {
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
        else store.removeSelected();
        return true;
      }
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (!delta || !state.selectedId) return false;
      const step = event.shiftKey ? 10 : state.snap || 1;
      if (selectedKind() === "light") {
        const light = selectedLight(); if (!light) return false;
        store.patchLight({ position: { x: light.position.x + delta[0] * step, y: light.position.y + delta[1] * step } }); return true;
      }
      const polygon = selectedPolygon(), vertex = state.selectedVertex !== null ? polygon?.points[state.selectedVertex] : undefined;
      if (tool() === "vertex" && vertex && state.selectedVertex !== null) { store.moveVertex(state.selectedVertex, { x: vertex.x + delta[0] * step, y: vertex.y + delta[1] * step }); return true; }
      if (tool() === "move") { store.moveSelectedBy(delta[0] * step, delta[1] * step); return true; }
      return false;
    },
    keyUp(event: KeyboardEvent) {
      if (event.code !== "Space" && event.key !== " ") return false;
      const held = spaceHeld; spaceHeld = false; return held;
    },
    blur() { spaceHeld = false; ghost = null; cancel(); },
    draw(ctx: CanvasRenderingContext2D, project: (point: WorldPoint) => WorldPoint) {
      const state = store.getSnapshot(); if (!state.enabled) return;
      const frameLights = lights(); // Refresh view metadata even when the guides are hidden.
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.lineWidth = 1.5; ctx.font = "12px sans-serif";
      const contour = (points: readonly WorldPoint[]) => { ctx.beginPath(); points.forEach((p, i) => { const s = project(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }); ctx.closePath(); };
      let guideColor = "#dfb5ff";
      const handle = (point: WorldPoint, label?: string, active = false) => {
        const p = project(point); ctx.beginPath(); ctx.arc(p.x, p.y, active ? 6 : 5, 0, Math.PI * 2); ctx.fillStyle = active ? "#fff5ac" : guideColor; ctx.fill(); ctx.strokeStyle = "#152a25"; ctx.stroke();
        if (label) { ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3; ctx.strokeText(label, p.x + 8, p.y - 6); ctx.fillText(label, p.x + 8, p.y - 6); ctx.lineWidth = 1.5; }
      };
      const circle = (point: WorldPoint, radius: number) => { const p = project(point), edge = project({ x: point.x + radius, y: point.y }); ctx.beginPath(); ctx.arc(p.x, p.y, distance(p, edge), 0, Math.PI * 2); ctx.stroke(); };
      if (state.overlay !== "off") {
        for (const caster of casters()) {
          const selected = selectedKind() === "caster" && caster.id === state.selectedId;
          if (state.overlay === "selected" && !selected || !state.showCasters && !selected) continue;
          guideColor = "#dfb5ff"; ctx.strokeStyle = selected ? "#dfb5ff" : "#a786c1"; ctx.fillStyle = selected ? "rgba(201,140,255,.12)" : "rgba(201,140,255,.04)";
          ctx.setLineDash([]); contour(caster.points); ctx.fill(); ctx.stroke();
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
          if (tool() === "vertex") caster.points.forEach((p, i) => handle(p, String(i + 1), state.selectedVertex === i));
          if (tool() === "height") { const anchor = center(caster.points); handle({ x: anchor.x, y: anchor.y - caster.baseHeight }, "Низ " + caster.baseHeight); handle({ x: anchor.x, y: anchor.y - caster.baseHeight - caster.height }, "Верх " + (caster.baseHeight + caster.height)); }
          if (tool() === "move") handle(center(caster.points), "Переместить объём");
          const label = project(top[0]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3;
          const text = "Объём · " + caster.id + " · " + caster.baseHeight + "–" + (caster.baseHeight + caster.height);
          ctx.strokeText(text, label.x + 5, label.y - 9); ctx.fillText(text, label.x + 5, label.y - 9); ctx.lineWidth = 1.5;
        }
        for (const receiver of receivers()) {
          const selected = selectedKind() === "receiver" && receiver.id === state.selectedId;
          if (state.overlay === "selected" && !selected || !state.showReceivers && !selected) continue;
          guideColor = "#7dcfff"; ctx.strokeStyle = selected ? "#7dcfff" : "#5897c5"; ctx.fillStyle = selected ? "rgba(95,189,255,.12)" : "rgba(95,189,255,.025)";
          ctx.setLineDash([]); contour(receiver.points); ctx.fill(); ctx.stroke();
          if (!selected) continue;
          if (state.showWireframe && receiver.height > 0) {
            const ground = receiver.points.map(p => ({ x: p.x, y: p.y + receiver.height }));
            ctx.setLineDash([4, 4]); contour(ground); ctx.stroke();
            ctx.beginPath(); receiver.points.forEach((p, i) => { const a = project(p), b = project(ground[i]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke(); ctx.setLineDash([]);
          }
          if (tool() === "vertex") receiver.points.forEach((p, i) => handle(p, String(i + 1), state.selectedVertex === i));
          if (tool() === "height") handle(center(receiver.points), "Высота поверхности " + receiver.height);
          if (tool() === "move") handle(center(receiver.points), "Переместить поверхность");
          const label = project(receiver.points[0]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3;
          const text = "Поверхность · " + receiver.id + " · принимает тени";
          ctx.strokeText(text, label.x + 5, label.y - 9); ctx.fillText(text, label.x + 5, label.y - 9); ctx.lineWidth = 1.5;
        }
        for (const light of frameLights) {
          const selected = selectedKind() === "light" && light.id === state.selectedId;
          if (state.overlay === "selected" && !selected) continue;
          guideColor = "#ffdf78"; ctx.setLineDash(light.enabled === false || light.intensity === 0 ? [3, 3] : []); ctx.strokeStyle = selected ? "#ffdf78" : "#e2b977";
          if (selected) circle(light.position, light.radius);
          ctx.setLineDash([]); handle(light.position, selected ? light.id : undefined, selected);
          if (!selected) continue;
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
