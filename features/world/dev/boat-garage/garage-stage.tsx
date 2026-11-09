"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Anchor, Fish, Fuel, Settings2, Ship, X } from "lucide-react";
import { getGarageNodeMatrix, getGarageParentMatrix, getGarageViewport, inverseGaragePoint, moveGaragePivot } from "./garage-scene-model.mjs";
import { getGarageShortcut } from "./garage-editor-shortcuts.mjs";
import { garageLayerStack } from "./garage-layer-order.mjs";
import { panGarageEditorView } from "./garage-editor-view.mjs";
import { garageTransformHandles, pointInsideGarageNode, resizeGarageNode, rotateGarageNode, scaleGarageNodeAroundPivot } from "./garage-transform.mjs";
import type { GarageNode, GaragePoint, GarageScene, GarageViewportMode, GarageWaterPreviewConfig } from "./garage-scene-types";
import { GarageWaterBackground, GarageWaterContact, GarageWaterRig } from "./garage-water";
import { garageWaterEffects, garageWaterSetup } from "./garage-water-setup.mjs";
import { GarageArtwork } from "./garage-artwork";
import { GarageOcclusionOverlay } from "./garage-occlusion-overlay";
import styles from "./garage-editor.module.css";

export type GarageTool = "move" | "rotate" | "scale" | "camera" | "pivot" | "socket" | "occlusion";
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

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type GarageEditingView = { width: number; height: number; x: number; y: number; scale: number };

type Props = {
  scene: GarageScene; device: GarageDevice; selectedId: string | null; tool: GarageTool;
  guides: boolean; clean: boolean; onSelect: (id: string) => void;
  onChange: (scene: GarageScene, record?: boolean) => void;
  onGestureEnd: (before: GarageScene) => void;
  occlusionEdit?: { session: number; redraw: boolean; onExit: () => void; onDraftChange?: (active: boolean) => void };
  waterPreview?: { config: GarageWaterPreviewConfig; running: boolean };
  editingView?: GarageEditingView; onViewChange?: (view: { x: number; y: number; scale: number }) => void;
};

export function GarageStage({ scene, device, selectedId, tool, guides, clean, onSelect, onChange, onGestureEnd, editingView, onViewChange, waterPreview, occlusionEdit }: Props) {
  const landscape = device.width > device.height;
  const width = editingView?.width ?? (landscape ? device.width - 280 : device.width);
  const height = editingView?.height ?? (landscape ? device.height - 60 - device.safeBottom : Math.round(width * (device.width >= 700 ? 941 / 1672 : .73)));
  const mode: GarageViewportMode = landscape || device.width >= 700 ? "landscape" : "portrait";
  const viewport = editingView ?? getGarageViewport(scene, width, height, mode);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ before: GarageScene; point: GaragePoint; nodeId: string | null; pointerId: number; viewport: {x: number; y: number; scale: number}; panView?: GarageEditingView; action?: "resize" | "rotate" | "scale"; handle?: ResizeHandle } | null>(null);
  const spaceHeld = useRef(false);
  const [selectionBypass, setSelectionBypass] = useState(false);
  useEffect(() => {
    const release = () => { spaceHeld.current = false; setSelectionBypass(false); };
    const keyPress = (event: globalThis.KeyboardEvent) => { if (event.key === "Alt") setSelectionBypass(true); };
    const keyRelease = (event: globalThis.KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = false;
      if (event.key === "Alt" || !event.altKey) setSelectionBypass(false);
    };
    window.addEventListener("keydown", keyPress); window.addEventListener("keyup", keyRelease); window.addEventListener("blur", release);
    return () => { window.removeEventListener("keydown", keyPress); window.removeEventListener("keyup", keyRelease); window.removeEventListener("blur", release); };
  }, []);
  const water = waterPreview ? garageWaterSetup({ ...scene, waterPreview: waterPreview.config }) : null;
  const waterEffects = garageWaterEffects(water?.config);
  const waterId = useId().replace(/:/g, "");
  const selected = scene.nodes.find(node => node.id === selectedId);
  const selectedMatrix = selected ? getGarageNodeMatrix(scene, selected.id) : null;
  const transformHandles = selected ? garageTransformHandles(scene, selected.id, viewport.scale) : null;
  const selectionHint = tool === "rotate" ? "Повернуть выбранный слой · Shift — шаг 15°"
    : tool === "scale" ? "Масштабировать от опоры · Shift — шаг 10%" : "Перетащить выбранный слой";

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
    } else if (tool === "occlusion") {
      return;
    } else if (node) {
      onSelect(node.id);
      if (node.locked) return;
      drag.current = { before: scene, point: point(event), nodeId: node.id, pointerId: event.pointerId, viewport,
        ...(tool === "rotate" || tool === "scale" ? { action: tool } : {}) };
    } else return;
    svg.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startTransform(event: PointerEvent<SVGElement>, action: "resize" | "rotate" | "scale", handle?: ResizeHandle) {
    event.stopPropagation();
    if (!selected || selected.locked || clean || drag.current || event.button !== 0 || event.altKey) return;
    svg.current?.focus();
    drag.current = { before: scene, point: point(event as unknown as PointerEvent<SVGSVGElement>), nodeId: selected.id,
      pointerId: event.pointerId, viewport, action, handle };
    svg.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function dragSelection(event: PointerEvent<SVGRectElement>) {
    event.stopPropagation();
    if (event.altKey) {
      const world = point(event as unknown as PointerEvent<SVGSVGElement>);
      const candidate = garageLayerStack(scene).find(node => node.assetId && visibleNode(scene, node) && (!water || water.ids.has(node.id)) && pointInsideGarageNode(scene, node.id, world));
      if (candidate) down(event as unknown as PointerEvent<SVGSVGElement>, candidate);
      return;
    }
    down(event as unknown as PointerEvent<SVGSVGElement>, selected);
  }
  function resizeCursor(handle: { x: number; y: number }) {
    if (!transformHandles) return "move";
    const angle = Math.atan2(handle.y - transformHandles.center.y, handle.x - transformHandles.center.x);
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4];
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const rect = svg.current!.getBoundingClientRect();
    const originalView = gesture.viewport;
    const now = { x: ((event.clientX - rect.left) * width / rect.width - originalView.x) / originalView.scale,
      y: ((event.clientY - rect.top) * height / rect.height - originalView.y) / originalView.scale };
    const dx = now.x - gesture.point.x, dy = now.y - gesture.point.y;
    if (gesture.action && gesture.nodeId) {
      try {
        if (gesture.action === "rotate") onChange(rotateGarageNode(gesture.before, gesture.nodeId, gesture.point, now, { snap: event.shiftKey }), false);
        else if (gesture.action === "scale") onChange(scaleGarageNodeAroundPivot(gesture.before, gesture.nodeId, gesture.point, now, { snap: event.shiftKey }), false);
        else if (gesture.handle) {
          const original = garageTransformHandles(gesture.before, gesture.nodeId)?.handles.find(item => item.id === gesture.handle);
          if (original) onChange(resizeGarageNode(gesture.before, gesture.nodeId, gesture.handle,
            { x: original.x + dx, y: original.y + dy }, { proportional: event.shiftKey }), false);
        }
      } catch { /* Keep the last valid pose when a drag reaches the import geometry limits. */ }
    } else if (gesture.panView) {
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

  const artwork = <GarageArtwork scene={scene} selectedId={selectedId} clean={clean} visibleIds={water?.ids}
    onNodePointerDown={(event, node) => { event.stopPropagation(); down(event as unknown as PointerEvent<SVGSVGElement>, node); }} />;
  const selection = (<>
          {!clean && selected && selectedMatrix && visibleNode(scene, selected) && (!water || water.ids.has(selected.id)) && <g pointerEvents="none" data-testid="garage-selection">
            {(["move", "rotate", "scale"] as GarageTool[]).includes(tool) && !selected.locked && !selectionBypass && <rect transform={`matrix(${selectedMatrix.join(" ")})`}
              data-testid="garage-selection-drag" width={selected.width} height={selected.height} fill="transparent" pointerEvents="all"
              style={{ cursor: tool === "rotate" ? "grab" : tool === "scale" ? "nwse-resize" : "move" }} onPointerDown={dragSelection}>
              <title>{`${selectionHint} · Alt + клик — выбрать другой`}</title></rect>}
            <rect transform={`matrix(${selectedMatrix.join(" ")})`} width={selected.width} height={selected.height} fill="none" stroke="#ffe1a0" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            {(["move", "rotate", "scale"] as GarageTool[]).includes(tool) && !selected.locked && !selectionBypass && transformHandles && <>
              {tool !== "scale" && <line x1={transformHandles.top.x} y1={transformHandles.top.y} x2={transformHandles.rotation.x} y2={transformHandles.rotation.y}
                stroke="#ffe1a0" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
              {tool !== "rotate" && transformHandles.handles.map(handle => <g key={handle.id} transform={`translate(${handle.x} ${handle.y}) scale(${1 / viewport.scale})`}
                pointerEvents="all" data-testid={`garage-resize-${handle.id}`} style={{ cursor: resizeCursor(handle) }}
                onPointerDown={event => startTransform(event, "resize", handle.id)}>
                <title>Растянуть · Shift — сохранить пропорции</title><circle r="12" fill="transparent" />
                <rect x="-4.5" y="-4.5" width="9" height="9" rx="1" fill="#fff0b8" stroke="#17382a" strokeWidth="1.5" />
              </g>)}
              {tool !== "scale" && <g transform={`translate(${transformHandles.rotation.x} ${transformHandles.rotation.y}) scale(${1 / viewport.scale})`}
                data-testid="garage-rotate" pointerEvents="all" style={{ cursor: "grab" }} onPointerDown={event => startTransform(event, "rotate")}>
                <title>Повернуть · Shift — шаг 15°</title><circle r="14" fill="transparent" />
                <circle r="8" fill="#ffe1a0" stroke="#17382a" strokeWidth="1.5" /><path d="M-4 1a4 4 0 1 1 6 2M-4-3v4h4" fill="none" stroke="#17382a" strokeWidth="1.3" />
              </g>}
            </>}
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
  </>);

  const stage = (<svg ref={svg} className={`${styles.stage} ${editingView ? styles.assemblyStage : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-label="Сцена гаража" tabIndex={0} data-testid="garage-stage" data-tool={tool} style={{ touchAction: clean ? "auto" : "none" }}
        onKeyDown={event => { if (editingView && event.code === "Space") { event.preventDefault(); spaceHeld.current = true; finishGesture(); } else if (getGarageShortcut(event)) finishGesture(); }}
        onPointerDown={event => down(event)} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={finish} onLostPointerCapture={finish} onWheel={finishGesture}>
        <rect width={width} height={height} fill={editingView ? "#101b16" : "#3d2c20"} />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {editingView && <rect width={scene.canvas.width} height={scene.canvas.height} fill="#3d2c20" stroke="#758568" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {water && waterPreview ? <>
            <GarageWaterBackground width={scene.canvas.width} height={scene.canvas.height} running={waterPreview.running} />
            <GarageWaterContact center={water.center} beam={water.config.beam} running={waterPreview.running} layer="shadow"
              enabled={waterEffects.effectsEnabled} opacity={waterEffects.effectOpacity} offsetY={waterEffects.effectOffsetY} />
            {waterEffects.immersionEnabled && <defs>
              <linearGradient id={`${waterId}-immersion`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={water.config.waterlineY - 12} y2={water.config.waterlineY + 60}>
                <stop offset="0" stopColor="white" /><stop offset="1" stopColor="#777" />
              </linearGradient>
              <mask id={`${waterId}-submerged`} maskUnits="userSpaceOnUse" x="0" y="0" width={scene.canvas.width} height={scene.canvas.height}>
                <rect width={scene.canvas.width} height={scene.canvas.height} fill={`url(#${waterId}-immersion)`} />
              </mask>
            </defs>}
            <g mask={waterEffects.immersionEnabled ? `url(#${waterId}-submerged)` : undefined}>
              <GarageWaterRig center={water.center} beam={water.config.beam} amplitude={water.config.amplitude} running={waterPreview.running}>{artwork}</GarageWaterRig>
            </g>
            <GarageWaterContact center={water.center} beam={water.config.beam} running={waterPreview.running} layer="surface"
              enabled={waterEffects.effectsEnabled} opacity={waterEffects.effectOpacity} offsetY={waterEffects.effectOffsetY} />
          </> : artwork}
          {!clean && guides && <rect x="280" y="180" width="1112" height="620" fill="none" stroke="#b7e4c0"
            strokeWidth="1" strokeDasharray="7 7" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {selection}
          {!clean && tool === "occlusion" && selected?.assetId && selected.occlusion && !selected.locked && visibleNode(scene, selected)
            && (!water || water.ids.has(selected.id)) && <GarageOcclusionOverlay key={`${selected.id}:${occlusionEdit?.session ?? 0}`}
              scene={scene} node={selected} scale={viewport.scale} redraw={occlusionEdit?.redraw ?? false}
              toWorld={event => point(event as unknown as PointerEvent<SVGSVGElement>)} onChange={onChange} onGestureEnd={onGestureEnd}
              onExit={() => occlusionEdit?.onExit()} onDraftChange={occlusionEdit?.onDraftChange} />}

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
          [Ship, "Корпус"], [Settings2, "Мотор"], [Fish, "Хранилище"], [Fuel, "Бак"],
        ].map(([Icon, label]) => { const PartIcon = Icon as typeof Ship; return <div key={String(label)} className={styles.moduleCard}>
          <PartIcon size={24} /><span>{String(label)}</span><small>{label === "Хранилище" ? "Без изменения рисунка" : "Слот модуля"}</small>
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
