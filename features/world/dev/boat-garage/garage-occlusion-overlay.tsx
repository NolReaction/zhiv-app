"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { getGarageNodeMatrix, inverseGaragePoint, transformGaragePoint } from "./garage-scene-model.mjs";
import { defaultGarageOcclusion, garageOcclusionPolygonProblem } from "./garage-occlusion.mjs";
import type { GarageNode, GaragePoint, GarageScene } from "./garage-scene-types";

type Props = {
  scene: GarageScene;
  node: GarageNode;
  scale: number;
  redraw: boolean;
  onChange: (scene: GarageScene, record?: boolean) => void;
  onGestureEnd: (before: GarageScene) => void;
  toWorld: (event: PointerEvent<SVGElement>) => GaragePoint;
  onExit: () => void;
  onDraftChange?: (active: boolean) => void;
};

type VertexGesture = {
  before: GarageScene;
  index: number;
  pointerId: number;
  target: SVGElement;
  onGestureEnd: Props["onGestureEnd"];
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const editableTarget = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]"));

/** The polygon belongs to the hull image, but all handles have a fixed screen size.
 * A redraw is a local draft until closure; the previous occlusion stays intact. */
export function GarageOcclusionOverlay({ scene, node, scale, redraw, onChange, onGestureEnd, toWorld, onExit, onDraftChange }: Props) {
  const [draft, setDraft] = useState<GaragePoint[] | null>(redraw ? [] : null);
  const [draftRedo, setDraftRedo] = useState<GaragePoint[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const gesture = useRef<VertexGesture | null>(null);
  const spaceHeld = useRef(false);
  const lastDraftClick = useRef<{ point: GaragePoint; time: number } | null>(null);
  const matrix = getGarageNodeMatrix(scene, node.id);
  const points = draft ?? node.occlusion?.points ?? [];
  const safeScale = Math.max(.001, scale);
  const worldPoints = points.map(point => transformGaragePoint(matrix, { x: point.x * node.width, y: point.y * node.height }));
  const corners = [{ x: 0, y: 0 }, { x: node.width, y: 0 }, { x: node.width, y: node.height }, { x: 0, y: node.height }]
    .map(point => transformGaragePoint(matrix, point));
  const statusOrigin = { x: Math.min(...corners.map(point => point.x)), y: Math.min(...corners.map(point => point.y)) - 34 / safeScale };
  const draftActive = draft !== null;

  useEffect(() => {
    onDraftChange?.(draftActive);
    return () => onDraftChange?.(false);
  }, [draftActive, onDraftChange]);

  function finishGesture() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    current.onGestureEnd(current.before);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }

  useEffect(() => {
    const finish = () => {
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      current.onGestureEnd(current.before);
      if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    };
    const blur = () => { spaceHeld.current = false; finish(); };
    window.addEventListener("wheel", finish, { capture: true, passive: true });
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("wheel", finish, true);
      window.removeEventListener("blur", blur);
      finish();
    };
  }, []);

  function commitPoints(next: GaragePoint[], record = true, base = scene) {
    const issue = garageOcclusionPolygonProblem(next);
    if (issue) { setProblem(issue); return false; }
    const owner = base.nodes.find(item => item.id === node.id);
    if (!owner || owner.locked) return false;
    const occlusion = { ...(owner.occlusion ?? defaultGarageOcclusion()), points: next };
    onChange({ ...base, nodes: base.nodes.map(item => item.id === owner.id ? { ...item, occlusion } : item) }, record);
    setProblem("");
    return true;
  }

  function finishDraft() {
    if (draft === null || node.locked) return;
    if (commitPoints(draft)) {
      setDraft(null); setDraftRedo([]); setSelectedPoint(null); lastDraftClick.current = null;
    }
  }

  function popDraftPoint() {
    if (!draft?.length) return;
    setDraftRedo([draft[draft.length - 1], ...draftRedo]);
    setDraft(draft.slice(0, -1)); setProblem("");
  }

  function removePoint() {
    if (draft !== null) { popDraftPoint(); return; }
    if (selectedPoint === null || selectedPoint >= points.length || node.locked) return;
    if (points.length <= 3) { setProblem("В контуре должны остаться хотя бы 3 точки."); return; }
    if (commitPoints(points.filter((_, index) => index !== selectedPoint))) setSelectedPoint(null);
  }

  useEffect(() => {
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || editableTarget(event.target)) return;
      if (event.code === "Space") { spaceHeld.current = true; finishGesture(); return; }
      const code = event.code || (({ z: "KeyZ", y: "KeyY", s: "KeyS" } as Record<string, string>)[event.key.toLowerCase()] ?? event.key);
      if ((event.ctrlKey || event.metaKey) && code === "KeyS" && draft !== null) {
        event.preventDefault(); event.stopImmediatePropagation(); finishGesture();
        setProblem("Сначала завершите контур Enter или отмените Escape."); return;
      }
      if ((event.ctrlKey || event.metaKey) && ["KeyZ", "KeyY"].includes(code)) {
        finishGesture();
        if (draft === null) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (code === "KeyY" || event.shiftKey) {
          if (draftRedo.length) { setDraft([...draft, draftRedo[0]]); setDraftRedo(draftRedo.slice(1)); setProblem(""); }
        } else popDraftPoint();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (code === "Enter" && draft === null) return;
      if (["Delete", "Backspace", "Enter", "Escape"].includes(code)) {
        event.preventDefault(); event.stopImmediatePropagation(); finishGesture();
        if (code === "Delete" || code === "Backspace") removePoint();
        else if (code === "Enter") finishDraft();
        else { setDraft(null); setProblem(""); onExit(); }
      }
    };
    const release = (event: globalThis.KeyboardEvent) => { if (event.code === "Space") spaceHeld.current = false; };
    window.addEventListener("keydown", keyboard, true); window.addEventListener("keyup", release, true);
    return () => { window.removeEventListener("keydown", keyboard, true); window.removeEventListener("keyup", release, true); };
  });

  function localPoint(event: PointerEvent<SVGElement>, base = scene) {
    const owner = base.nodes.find(item => item.id === node.id)!;
    const local = inverseGaragePoint(getGarageNodeMatrix(base, owner.id), toWorld(event));
    return { x: clamp(local.x / owner.width), y: clamp(local.y / owner.height) };
  }

  function addDraftPoint(event: PointerEvent<SVGElement>) {
    if (event.button !== 0 || spaceHeld.current || node.locked || draft === null) return;
    event.stopPropagation(); event.preventDefault();
    const point = localPoint(event), previous = lastDraftClick.current;
    // The second press of a double click closes the outline without a duplicate vertex.
    if (previous && event.timeStamp - previous.time < 450
      && Math.hypot((point.x - previous.point.x) * node.width, (point.y - previous.point.y) * node.height) * safeScale < 5) return;
    if (draft.length >= 64) { setProblem("В контуре может быть не больше 64 точек."); return; }
    setDraft([...draft, point]); setDraftRedo([]); setProblem(""); setSelectedPoint(null);
    lastDraftClick.current = { point, time: event.timeStamp };
  }

  function startVertex(event: PointerEvent<SVGElement>, index: number) {
    if (event.button !== 0 || spaceHeld.current || node.locked) return;
    event.stopPropagation(); event.preventDefault();
    if (draft !== null) { if (index === 0 && draft.length >= 3) finishDraft(); return; }
    finishGesture(); setSelectedPoint(index); setProblem("");
    gesture.current = { before: scene, index, pointerId: event.pointerId, target: event.currentTarget, onGestureEnd };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveVertex(event: PointerEvent<SVGElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.stopPropagation();
    const original = current.before.nodes.find(item => item.id === node.id)?.occlusion?.points;
    if (!original) return;
    const point = localPoint(event, current.before);
    commitPoints(original.map((value, index) => index === current.index ? point : value), false, current.before);
  }

  function endVertex(event: PointerEvent<SVGElement>) {
    if (event.pointerId !== gesture.current?.pointerId) return;
    event.stopPropagation(); finishGesture();
  }

  function insertVertex(event: PointerEvent<SVGElement>, index: number) {
    if (event.button !== 0 || spaceHeld.current || node.locked || draft !== null) return;
    event.stopPropagation(); event.preventDefault(); finishGesture();
    if (points.length >= 64) { setProblem("В контуре может быть не больше 64 точек."); return; }
    const start = worldPoints[index], end = worldPoints[(index + 1) % points.length], pointer = toWorld(event);
    const dx = end.x - start.x, dy = end.y - start.y;
    const fraction = Math.max(0, Math.min(1, ((pointer.x - start.x) * dx + (pointer.y - start.y) * dy) / (dx * dx + dy * dy)));
    if (fraction < .00001 || fraction > .99999) { setSelectedPoint(fraction < .5 ? index : (index + 1) % points.length); return; }
    const first = points[index], second = points[(index + 1) % points.length];
    const point = { x: first.x + (second.x - first.x) * fraction, y: first.y + (second.y - first.y) * fraction };
    const next = [...points.slice(0, index + 1), point, ...points.slice(index + 1)];
    if (commitPoints(next)) setSelectedPoint(index + 1);
  }

  const status = problem || (draft !== null ? `Новый контур: ${draft.length} точек · Enter — завершить · Esc — отменить`
    : "Контур борта · перетащите точки · клик по ребру добавит точку");

  return <g data-testid="garage-occlusion-overlay" aria-label="Редактор контура борта"
    onPointerMove={moveVertex} onPointerUp={endVertex} onPointerCancel={endVertex} onLostPointerCapture={endVertex}
    onDoubleClick={event => { if (draft !== null) { event.preventDefault(); event.stopPropagation(); finishDraft(); } }}>
    {draft !== null && <rect data-testid="garage-occlusion-draft" transform={`matrix(${matrix.join(" ")})`}
      width={node.width} height={node.height} fill="transparent" pointerEvents="all" style={{ cursor: "crosshair" }}
      onPointerDown={addDraftPoint} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); finishDraft(); }}>
      <title>Щёлкайте по контуру переднего борта. Enter или двойной щелчок — завершить; Esc — отменить.</title>
    </rect>}
    {worldPoints.length > 1 && <polyline points={worldPoints.map(point => `${point.x},${point.y}`).join(" ")}
      fill={worldPoints.length >= 3 ? "#5ce4ca25" : "none"} stroke={draft !== null ? "#8fffea" : "#ffd281"}
      strokeWidth="1.5" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
    {draft === null && worldPoints.map((point, index) => {
      const next = worldPoints[(index + 1) % worldPoints.length];
      return <g key={`edge-${index}`}>
        <line x1={point.x} y1={point.y} x2={next.x} y2={next.y} stroke="#ffd281" strokeWidth="1.5" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        <line data-testid={`garage-occlusion-edge-${index}`} x1={point.x} y1={point.y} x2={next.x} y2={next.y}
          stroke="transparent" strokeWidth="14" vectorEffect="non-scaling-stroke" pointerEvents="stroke" style={{ cursor: "copy" }}
          onPointerDown={event => insertVertex(event, index)}><title>Добавить точку контура</title></line>
      </g>;
    })}
    {worldPoints.map((point, index) => <g key={`point-${index}`} data-testid={`garage-occlusion-point-${index}`}
      transform={`translate(${point.x} ${point.y}) scale(${1 / safeScale})`} pointerEvents="all"
      style={{ cursor: draft !== null && index === 0 && points.length >= 3 ? "pointer" : "grab" }}
      onPointerDown={event => startVertex(event, index)}>
      <title>{draft !== null && index === 0 && points.length >= 3 ? "Замкнуть контур" : `Точка ${index + 1} · перетащить · Delete — удалить`}</title>
      <circle r="13" fill="transparent" />
      <circle r={selectedPoint === index ? 6 : 5} fill={selectedPoint === index ? "#fff7d7" : "#ffd281"} stroke="#133c30" strokeWidth="1.5" />
      <text x="9" y="-8" fill="#fff7d7" fontSize="11" stroke="#163e30" strokeWidth="3" paintOrder="stroke" pointerEvents="none">{index + 1}</text>
    </g>)}
    <g transform={`translate(${statusOrigin.x} ${statusOrigin.y}) scale(${1 / safeScale})`} pointerEvents="none">
      <rect x="0" y="0" width={Math.min(640, Math.max(200, status.length * 6.4 + 20))} height="26" rx="5" fill="#10352eeb" stroke={problem ? "#f4b08d" : "#93c1a4"} />
      <text x="10" y="17" fontSize="11" fill={problem ? "#ffcca3" : "#e4f7d9"} role="status" aria-live="polite"><title>{status}</title>{status}</text>
    </g>
  </g>;
}
