"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Grid2X2, Minus, Plus, RotateCcw } from "lucide-react";
import { loadSettlementArt, type SettlementArt } from "./art";
import { renderSettlement, type Placement } from "./scene";
import { project, unproject, SCENE_WIDTH, SCENE_HEIGHT } from "./geometry";
import { buildingInfo, type BuildingKind, type Settlement } from "./model";
import styles from "./settlement.module.css";

type Props = { state: Settlement; selected: BuildingKind | null; placement: Placement | null;
  onSelect: (kind: BuildingKind | null) => void; onPosition: (x: number, y: number) => void };
export function SettlementMap({ state, selected, placement, onSelect, onPosition }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), [art, setArt] = useState<SettlementArt | null>(null), [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0), [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 }), [showGrid, setShowGrid] = useState(true);
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number }; moved: boolean } | null>(null);
  useEffect(() => { let active = true; loadSettlementArt().then(value => { if (active) { setArt(value); setError(""); } }).catch(reason => { if (active) setError(reason.message); }); return () => { active = false; }; }, [loadAttempt]);
  useEffect(() => {
    const element = canvas.current; if (!element || !art) return;
    const paint = () => {
      const box = element.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.max(1, Math.round(box.width * dpr)); element.height = Math.max(1, Math.round(box.height * dpr));
      const ctx = element.getContext("2d"); if (!ctx) return;
      ctx.setTransform(element.width / SCENE_WIDTH, 0, 0, element.height / SCENE_HEIGHT, 0, 0);
      renderSettlement(ctx, art, state, { zoom, pan, showGrid, selected, placement });
    };
    paint(); const observer = new ResizeObserver(paint); observer.observe(element); return () => observer.disconnect();
  }, [art, state, zoom, pan, showGrid, selected, placement]);
  const position = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width * SCENE_WIDTH, y: (event.clientY - box.top) / box.height * SCENE_HEIGHT };
  };
  const clickMap = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = position(event), local = { x: (point.x - 500 - pan.x) / zoom + 500, y: (point.y - 350 - pan.y) / zoom + 350 };
    const cell = unproject(local.x, local.y), x = Math.floor(cell.x), y = Math.floor(cell.y);
    if (placement) { if (x >= 0 && y >= 0 && x < 10 && y < 10) onPosition(x, y); return; }
    // Prefer the whole visible sprite silhouette, then fall back to its footprint.
    const hit = [...state.buildings].sort((a, b) => b.x + b.y - a.x - a.y).find(item => {
      const base = project(item.x + 1, item.y + 1);
      return local.x > base.x - 80 && local.x < base.x + 80 && local.y > base.y - 135 && local.y < base.y + 44;
    });
    onSelect(hit?.kind ?? null);
  };
  const keyboard = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!placement || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); onPosition(Math.max(0, Math.min(8, placement.x + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0))),
      Math.max(0, Math.min(8, placement.y + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0))));
  };
  return <div className={styles.mapWrap}>
    <div className={styles.mapTools} aria-label="Вид поляны">
      <button type="button" aria-label="Уменьшить" disabled={zoom <= .8} onClick={() => setZoom(value => Math.max(.8, +(value - .2).toFixed(1)))}><Minus size={18} /></button>
      <button type="button" aria-label="Увеличить" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, +(value + .2).toFixed(1)))}><Plus size={18} /></button>
      <button type="button" aria-label="Показать всю поляну" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><RotateCcw size={17} /></button>
      <button type="button" aria-label="Показать сетку" aria-pressed={showGrid} onClick={() => setShowGrid(value => !value)}><Grid2X2 size={18} /></button>
    </div>
    <canvas ref={canvas} className={styles.canvas} width={1000} height={720} tabIndex={0}
      aria-label={placement ? `Размещение: ${buildingInfo(placement.kind).name}. Стрелки перемещают участок, подтверждение — кнопкой ниже.` : "Огороженная поляна. Выберите постройку на карте или в списке. Потяните карту для перемещения."}
      onKeyDown={keyboard} onPointerDown={event => {
        if (!event.isPrimary) return; const point = position(event); drag.current = { ...point, pan, moved: false }; event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const start = drag.current; if (!start || !event.isPrimary) return; const point = position(event);
        if (Math.hypot(point.x - start.x, point.y - start.y) > 9) start.moved = true;
        if (start.moved) setPan({ x: Math.max(-350, Math.min(350, start.pan.x + point.x - start.x)), y: Math.max(-220, Math.min(220, start.pan.y + point.y - start.y)) });
      }} onPointerUp={event => { if (!event.isPrimary) return; const start = drag.current; drag.current = null; if (start && !start.moved) clickMap(event); }}
      onPointerCancel={() => { drag.current = null; }}>
      Управляйте постройками через список рядом с картой.
    </canvas>
    {!art && <div className={styles.mapLoading} role="status">{error || "Готовим поляну…"}{error && <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>Повторить</button>}</div>}
    <div className={styles.mapCaption}>{placement ? "Выберите клетку для постройки" : "Потяните карту, чтобы осмотреть поляну"}</div>
  </div>;
}
