import type { WorldPoint, WorldShadowCaster } from "@/features/world/tiled/types";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import { worldLightingEditorStore } from "./world-lighting-editor-store";

function edgeDistance(point: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function hits(point: WorldPoint, polygon: readonly WorldPoint[], radius: number) {
  return previewPointInPolygon(point, polygon) || polygon.some((a, i) => edgeDistance(point, a, polygon[(i + 1) % polygon.length]) <= radius);
}

/** Uses the visible scene's casters, never gameplay silhouettes or collisions.
 * Handle sizes are in CSS pixels; only the projection changes with camera zoom. */
export function createWorldLightingEditorMap(getCasters: () => readonly WorldShadowCaster[], store = worldLightingEditorStore) {
  let dragging: { id: string; vertex: number } | null = null;
  const cancel = () => { const active = dragging; dragging = null; if (active && store.getSnapshot().selectedId === active.id) store.cancelGesture(); };
  return {
    cancel,
    down(point: WorldPoint, radius: number) {
      if (!store.getSnapshot().enabled) return false;
      const visible = getCasters(), selected = store.getSnapshot().selectedId;
      const ordered = [...visible].sort((a, b) => Number(a.id !== selected) - Number(b.id !== selected));
      for (const caster of ordered) {
        const vertex = caster.points.findIndex(p => Math.hypot(p.x - point.x, p.y - point.y) <= radius);
        if (vertex < 0) continue;
        store.select(caster.id, vertex); store.beginGesture(); dragging = { id: caster.id, vertex }; return true;
      }
      for (const caster of ordered) {
        const top = caster.points.map(p => ({ x: p.x, y: p.y - caster.baseHeight - caster.height }));
        if (!hits(point, caster.points, radius) && !hits(point, top, radius)) continue;
        store.select(caster.id); return true;
      }
      return false;
    },
    move(point: WorldPoint) {
      if (dragging === null) return;
      if (!store.getSnapshot().enabled || store.getSnapshot().selectedId !== dragging.id) { cancel(); return; }
      store.moveVertex(dragging.vertex, { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
    },
    end(cancelled: boolean) {
      if (dragging === null) return;
      const active = dragging; dragging = null;
      if (store.getSnapshot().selectedId !== active.id) return;
      if (cancelled) store.cancelGesture(); else store.commitGesture();
    },
    key(event: KeyboardEvent) {
      const state = store.getSnapshot();
      if (!state.enabled) return false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        cancel(); if (event.shiftKey) store.redo(); else store.undo(); return true;
      }
      if (event.key === "Escape") { cancel(); store.select(state.selectedId, null); return true; }
      if ((event.key === "Delete" || event.key === "Backspace") && state.selectedVertex !== null) {
        cancel(); store.deleteVertex(state.selectedVertex); return true;
      }
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      const caster = state.casters.find(value => value.id === state.selectedId);
      const vertex = state.selectedVertex !== null ? caster?.points[state.selectedVertex] : undefined;
      if (delta && vertex && state.selectedVertex !== null) {
        const step = event.shiftKey ? 10 : 1;
        store.moveVertex(state.selectedVertex, { x: vertex.x + delta[0] * step, y: vertex.y + delta[1] * step }); return true;
      }
      return false;
    },
    draw(ctx: CanvasRenderingContext2D, project: (point: WorldPoint) => WorldPoint) {
      const state = store.getSnapshot(); if (!state.enabled) return;
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.5; ctx.font = "12px sans-serif";
      const contour = (points: readonly WorldPoint[]) => {
        ctx.beginPath(); points.forEach((p, i) => { const s = project(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }); ctx.closePath();
      };
      for (const caster of getCasters()) {
        const selected = caster.id === state.selectedId;
        ctx.strokeStyle = selected ? "#7cffe1" : "#dfb5ff"; ctx.fillStyle = selected ? "rgba(77,255,204,.12)" : "rgba(201,140,255,.04)";
        ctx.setLineDash([]); contour(caster.points); ctx.fill(); ctx.stroke();
        if (!selected) continue;
        const top = caster.points.map(p => ({ x: p.x, y: p.y - caster.baseHeight - caster.height }));
        ctx.setLineDash([4, 4]); contour(top); ctx.stroke();
        ctx.beginPath(); caster.points.forEach((p, i) => { const a = project(p), b = project(top[i]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke(); ctx.setLineDash([]);
        caster.points.forEach((p, i) => {
          const s = project(p); ctx.beginPath(); ctx.arc(s.x, s.y, state.selectedVertex === i ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = state.selectedVertex === i ? "#fff5ac" : "#7cffe1"; ctx.fill(); ctx.strokeStyle = "#152a25"; ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3; ctx.strokeText(String(i + 1), s.x + 8, s.y - 6); ctx.fillText(String(i + 1), s.x + 8, s.y - 6); ctx.lineWidth = 1.5;
        });
        const label = project(top[0]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#152a25"; ctx.lineWidth = 3;
        const text = `${caster.id} · ${caster.baseHeight}–${caster.baseHeight + caster.height}`;
        ctx.strokeText(text, label.x + 5, label.y - 9); ctx.fillText(text, label.x + 5, label.y - 9); ctx.lineWidth = 1.5;
      }
      ctx.restore();
    },
  };
}
