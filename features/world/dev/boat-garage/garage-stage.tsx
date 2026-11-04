"use client";

import { useEffect, useRef, type PointerEvent } from "react";
import { Anchor, Box, Fuel, Settings2, Ship, X } from "lucide-react";
import { getGarageNodeMatrix, getGarageParentMatrix, getGarageViewport, inverseGaragePoint, moveGaragePivot } from "./garage-scene-model.mjs";
import { getGarageShortcut } from "./garage-editor-shortcuts.mjs";
import { panGarageEditorView } from "./garage-editor-view.mjs";
import type { GarageNode, GaragePoint, GarageScene, GarageViewportMode } from "./garage-scene-types";
import styles from "./garage-editor.module.css";

export type GarageTool = "move" | "camera" | "pivot" | "socket";
export type GarageDevice = { id: string; name: string; width: number; height: number; safeTop: number; safeBottom: number };
export const GARAGE_DEVICES: GarageDevice[] = [
  { id: "phone", name: "Телефон", width: 390, height: 844, safeTop: 24, safeBottom: 24 },
  { id: "small-phone", name: "Маленький", width: 360, height: 740, safeTop: 20, safeBottom: 20 },
  { id: "tablet", name: "Планшет", width: 820, height: 1180, safeTop: 20, safeBottom: 20 },
  { id: "landscape", name: "Альбомный", width: 844, height: 390, safeTop: 0, safeBottom: 16 },
];

function visibleNode(scene: GarageScene, node: GarageNode): boolean {
  if (!node.visible) return false;
  const parent = scene.nodes.find(item => item.id === node.parentId);
  return !parent || visibleNode(scene, parent);
}

export type GarageEditingView = { width: number; height: number; x: number; y: number; scale: number };

type Props = {
  scene: GarageScene; device: GarageDevice; selectedId: string | null; tool: GarageTool;
  guides: boolean; clean: boolean; onSelect: (id: string) => void;
  onChange: (scene: GarageScene, record?: boolean) => void;
  onGestureEnd: (before: GarageScene) => void;
  editingView?: GarageEditingView; onViewChange?: (view: { x: number; y: number; scale: number }) => void;
};

export function GarageStage({ scene, device, selectedId, tool, guides, clean, onSelect, onChange, onGestureEnd, editingView, onViewChange }: Props) {
  const landscape = device.width > device.height;
  const width = editingView?.width ?? (landscape ? device.width - 280 : device.width);
  const height = editingView?.height ?? (landscape ? device.height - 60 - device.safeBottom : Math.round(width * (device.width >= 700 ? 941 / 1672 : .73)));
  const mode: GarageViewportMode = landscape || device.width >= 700 ? "landscape" : "portrait";
  const viewport = editingView ?? getGarageViewport(scene, width, height, mode);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ before: GarageScene; point: GaragePoint; nodeId: string | null; pointerId: number; viewport: {x: number; y: number; scale: number}; panView?: GarageEditingView } | null>(null);
  const spaceHeld = useRef(false);
  useEffect(() => {
    const release = () => { spaceHeld.current = false; };
    const keyRelease = (event: globalThis.KeyboardEvent) => { if (event.code === "Space") release(); };
    window.addEventListener("keyup", keyRelease); window.addEventListener("blur", release);
    return () => { window.removeEventListener("keyup", keyRelease); window.removeEventListener("blur", release); };
  }, []);
  const selected = scene.nodes.find(node => node.id === selectedId);
  const selectedMatrix = selected ? getGarageNodeMatrix(scene, selected.id) : null;
  const ordered = [...scene.nodes].sort((a, b) => a.zIndex - b.zIndex);

  function point(event: PointerEvent<SVGSVGElement | SVGGElement>, view = viewport): GaragePoint {
    const rect = svg.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) * width / rect.width - view.x) / view.scale,
      y: ((event.clientY - rect.top) * height / rect.height - view.y) / view.scale };
  }

  function down(event: PointerEvent<SVGSVGElement>, node?: GarageNode) {
    const panning = Boolean(editingView) && (event.button === 1 || spaceHeld.current || tool === "camera");
    if (drag.current || (!panning && (clean || event.button !== 0))) return;
    svg.current?.focus();
    if (panning || tool === "camera") {
      drag.current = { before: scene, point: point(event), nodeId: null, pointerId: event.pointerId, viewport,
        ...(editingView ? { panView: editingView } : {}) };
    } else if ((tool === "socket" || tool === "pivot") && selected && !selected.locked) {
      const local = inverseGaragePoint(getGarageNodeMatrix(scene, selected.id), point(event));
      const x = Math.max(0, Math.min(1, local.x / selected.width));
      const y = Math.max(0, Math.min(1, local.y / selected.height));
      let next = selected;
      if (tool === "socket") {
        next = { ...selected, sockets: [...selected.sockets, { id: `socket-${crypto.randomUUID().slice(0, 8)}`,
          name: `Крепление ${selected.sockets.length + 1}`, x, y }] };
      } else {
        onChange(moveGaragePivot(scene, selected.id, { x, y }));
        return;
      }
      onChange({ ...scene, nodes: scene.nodes.map(item => item.id === selected.id ? next : item) });
      return;
    } else if (node) {
      onSelect(node.id);
      if (node.locked) return;
      drag.current = { before: scene, point: point(event), nodeId: node.id, pointerId: event.pointerId, viewport };
    } else return;
    svg.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const rect = svg.current!.getBoundingClientRect();
    const originalView = gesture.viewport;
    const now = { x: ((event.clientX - rect.left) * width / rect.width - originalView.x) / originalView.scale,
      y: ((event.clientY - rect.top) * height / rect.height - originalView.y) / originalView.scale };
    const dx = now.x - gesture.point.x, dy = now.y - gesture.point.y;
    if (gesture.panView) {
      onViewChange?.(panGarageEditorView(gesture.panView, dx * originalView.scale, dy * originalView.scale));
    } else if (!gesture.nodeId) {
      const camera = gesture.before.cameras[mode];
      onChange({ ...gesture.before, cameras: { ...gesture.before.cameras, [mode]: { ...camera, x: camera.x - dx, y: camera.y - dy } } }, false);
    } else {
      const node = gesture.before.nodes.find(item => item.id === gesture.nodeId)!;
      const parent = getGarageParentMatrix(gesture.before, node);
      const from = inverseGaragePoint(parent, gesture.point), to = inverseGaragePoint(parent, now);
      onChange({ ...gesture.before, nodes: gesture.before.nodes.map(item => item.id === node.id
        ? { ...item, x: node.x + to.x - from.x, y: node.y + to.y - from.y } : item) }, false);
    }
  }

  function finishGesture() {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    if (!gesture.panView) onGestureEnd(gesture.before);
    if (svg.current?.hasPointerCapture(gesture.pointerId)) svg.current.releasePointerCapture(gesture.pointerId);
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerId === drag.current?.pointerId) finishGesture();
  }

  const stage = (<svg ref={svg} className={`${styles.stage} ${editingView ? styles.assemblyStage : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-label="Сцена гаража" tabIndex={0} data-testid="garage-stage" style={{ touchAction: clean ? "auto" : "none" }}
        onKeyDown={event => { if (editingView && event.code === "Space") { event.preventDefault(); spaceHeld.current = true; finishGesture(); } else if (getGarageShortcut(event)) finishGesture(); }}
        onPointerDown={event => down(event)} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={finish} onLostPointerCapture={finish} onWheel={finishGesture}>
        <rect width={width} height={height} fill={editingView ? "#101b16" : "#3d2c20"} />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {editingView && <rect width={scene.canvas.width} height={scene.canvas.height} fill="#3d2c20" stroke="#758568" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {ordered.filter(node => visibleNode(scene, node)).map(node => {
            const asset = scene.assets.find(item => item.id === node.assetId);
            const matrix = getGarageNodeMatrix(scene, node.id);
            return <g key={node.id} data-node-id={node.id} transform={`matrix(${matrix.join(" ")})`}
              onPointerDown={event => { event.stopPropagation(); down(event as unknown as PointerEvent<SVGSVGElement>, node); }}>
              {asset && <image href={asset.src} width={node.width} height={node.height} preserveAspectRatio="none"
                style={{ cursor: clean ? "default" : node.locked ? "default" : "move" }} />}
              {!asset && !clean && <rect width={node.width} height={node.height} fill="transparent" pointerEvents={selectedId === node.id ? "all" : "none"}
                stroke={selectedId === node.id ? "#dcb56c" : "#dcb56c55"} strokeDasharray="10 8" vectorEffect="non-scaling-stroke" />}
            </g>;
          })}
          {!clean && guides && <rect x="280" y="180" width="1112" height="620" fill="none" stroke="#b7e4c0"
            strokeWidth="1" strokeDasharray="7 7" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {!clean && selected && selectedMatrix && visibleNode(scene, selected) && <g pointerEvents="none" data-testid="garage-selection">
            <rect transform={`matrix(${selectedMatrix.join(" ")})`} width={selected.width} height={selected.height} fill="none" stroke="#ffe1a0" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <circle cx={selectedMatrix[0] * selected.pivotX * selected.width + selectedMatrix[2] * selected.pivotY * selected.height + selectedMatrix[4]}
              cy={selectedMatrix[1] * selected.pivotX * selected.width + selectedMatrix[3] * selected.pivotY * selected.height + selectedMatrix[5]}
              r={5 / viewport.scale} fill="#ffe1a0" stroke="#18372c" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {selected.sockets.map((socket, index) => <g key={socket.id}
              transform={`translate(${selectedMatrix[0] * socket.x * selected.width + selectedMatrix[2] * socket.y * selected.height + selectedMatrix[4]} ${selectedMatrix[1] * socket.x * selected.width + selectedMatrix[3] * socket.y * selected.height + selectedMatrix[5]}) scale(${1 / viewport.scale})`}>
              <circle r="6" fill="#69d8c5" stroke="#15392d" /><path d="M-10 0H10M0-10V10" stroke="#bbfff4" />
              <path d={`M0 -7 V${-10 - index * 18}`} stroke="#bbfff480" />
              <text x="8" y={-14 - index * 18} fill="#d9fff8" fontSize="11" paintOrder="stroke" stroke="#15392d" strokeWidth="3">{socket.name}</text>
            </g>)}
          </g>}
        </g>
      </svg>);
  if (editingView) return stage;

  return <div className={styles.device} style={{ width: device.width, height: device.height }} data-landscape={landscape}>
    <div className={styles.deviceSafe} style={{ height: device.safeTop }} aria-hidden><span /></div>
    <div className={styles.gameHeader}><Anchor size={22} /><div><small>У ПРИЧАЛА</small><strong>Лодочная мастерская</strong></div><X size={20} aria-hidden /></div>
    <div className={styles.gameBody}>
      {stage}
      <section className={styles.gamePanel} aria-label="Макет панели улучшений">
        <div className={styles.gameEyebrow}>ВАША КОМПЛЕКТАЦИЯ</div>
        <div className={styles.moduleCards}>{[
          [Ship, "Корпус"], [Settings2, "Мотор"], [Box, "Ящик"], [Fuel, "Бак"],
        ].map(([Icon, label]) => { const PartIcon = Icon as typeof Ship; return <div key={String(label)} className={styles.moduleCard}>
          <PartIcon size={24} /><span>{String(label)}</span><small>Слот модуля</small>
        </div>; })}</div>
        <h2>Собираем вашу лодку</h2>
        <p>Корпус, двигатель и снаряжение будут меняться отдельно. Здесь появятся характеристики выбранного улучшения.</p>
        <div className={styles.gameInfo}><span>У причала</span><strong>Подготовка к выходу</strong></div>
        <div className={styles.gameButton}>Место для кнопки улучшения</div>
      </section>
    </div>
    <div className={styles.deviceBottom} style={{ height: device.safeBottom }} aria-hidden><span /></div>
  </div>;
}
