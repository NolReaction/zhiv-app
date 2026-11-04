"use client";

import { useRef, type PointerEvent } from "react";
import { Anchor, Box, Fuel, Settings2, Ship, X } from "lucide-react";
import { getGarageNodeMatrix, getGarageParentMatrix, getGarageViewport, inverseGaragePoint } from "./garage-scene-model.mjs";
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

type Props = {
  scene: GarageScene; device: GarageDevice; selectedId: string | null; tool: GarageTool;
  guides: boolean; clean: boolean; onSelect: (id: string) => void;
  onChange: (scene: GarageScene, record?: boolean) => void;
  onGestureEnd: (before: GarageScene) => void;
};

export function GarageStage({ scene, device, selectedId, tool, guides, clean, onSelect, onChange, onGestureEnd }: Props) {
  const landscape = device.width > device.height;
  const width = landscape ? device.width - 280 : device.width;
  const height = landscape ? device.height - 60 - device.safeBottom : Math.round(width * (device.width >= 700 ? 941 / 1672 : .73));
  const mode: GarageViewportMode = landscape || device.width >= 700 ? "landscape" : "portrait";
  const viewport = getGarageViewport(scene, width, height, mode);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ before: GarageScene; point: GaragePoint; nodeId: string | null; pointerId: number } | null>(null);
  const selected = scene.nodes.find(node => node.id === selectedId);
  const selectedMatrix = selected ? getGarageNodeMatrix(scene, selected.id) : null;
  const selectedWorldScale = selectedMatrix ? Math.hypot(selectedMatrix[0], selectedMatrix[1]) : 1;
  const ordered = [...scene.nodes].sort((a, b) => a.zIndex - b.zIndex);

  function point(event: PointerEvent<SVGSVGElement | SVGGElement>): GaragePoint {
    const rect = svg.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) * width / rect.width - viewport.x) / viewport.scale,
      y: ((event.clientY - rect.top) * height / rect.height - viewport.y) / viewport.scale };
  }

  function down(event: PointerEvent<SVGSVGElement>, node?: GarageNode) {
    if (clean || event.button !== 0 || drag.current) return;
    svg.current?.focus();
    if (tool === "camera") {
      drag.current = { before: scene, point: point(event), nodeId: null, pointerId: event.pointerId };
    } else if ((tool === "socket" || tool === "pivot") && selected && !selected.locked) {
      const local = inverseGaragePoint(getGarageNodeMatrix(scene, selected.id), point(event));
      const x = Math.max(0, Math.min(1, local.x / selected.width));
      const y = Math.max(0, Math.min(1, local.y / selected.height));
      let next = selected;
      if (tool === "socket") {
        next = { ...selected, sockets: [...selected.sockets, { id: `socket-${crypto.randomUUID().slice(0, 8)}`,
          name: `Крепление ${selected.sockets.length + 1}`, x, y }] };
      } else {
        const dx = (x - selected.pivotX) * selected.width, dy = (y - selected.pivotY) * selected.height;
        const radians = selected.rotation * Math.PI / 180;
        next = { ...selected, pivotX: x, pivotY: y,
          x: selected.x + selected.scale * (Math.cos(radians) * dx - Math.sin(radians) * dy),
          y: selected.y + selected.scale * (Math.sin(radians) * dx + Math.cos(radians) * dy) };
      }
      onChange({ ...scene, nodes: scene.nodes.map(item => item.id === selected.id ? next : item) });
      return;
    } else if (node) {
      onSelect(node.id);
      if (node.locked) return;
      drag.current = { before: scene, point: point(event), nodeId: node.id, pointerId: event.pointerId };
    } else return;
    svg.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const rect = svg.current!.getBoundingClientRect();
    const originalView = getGarageViewport(gesture.before, width, height, mode);
    const now = { x: ((event.clientX - rect.left) * width / rect.width - originalView.x) / originalView.scale,
      y: ((event.clientY - rect.top) * height / rect.height - originalView.y) / originalView.scale };
    const dx = now.x - gesture.point.x, dy = now.y - gesture.point.y;
    if (!gesture.nodeId) {
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

  function finish(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    onGestureEnd(drag.current.before);
    drag.current = null;
  }

  return <div className={styles.device} style={{ width: device.width, height: device.height }} data-landscape={landscape}>
    <div className={styles.deviceSafe} style={{ height: device.safeTop }} aria-hidden><span /></div>
    <div className={styles.gameHeader}><Anchor size={22} /><div><small>У ПРИЧАЛА</small><strong>Лодочная мастерская</strong></div><X size={20} aria-hidden /></div>
    <div className={styles.gameBody}>
      <svg ref={svg} className={styles.stage} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-label="Сцена гаража" tabIndex={0} data-testid="garage-stage" style={{ touchAction: clean ? "auto" : "none" }}
        onPointerDown={event => down(event)} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={finish} onLostPointerCapture={finish}>
        <rect width={width} height={height} fill="#3d2c20" />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {ordered.filter(node => visibleNode(scene, node)).map(node => {
            const asset = scene.assets.find(item => item.id === node.assetId);
            const matrix = getGarageNodeMatrix(scene, node.id);
            return <g key={node.id} transform={`matrix(${matrix.join(" ")})`}
              onPointerDown={event => { event.stopPropagation(); down(event as unknown as PointerEvent<SVGSVGElement>, node); }}>
              {asset && <image href={asset.src} width={node.width} height={node.height} preserveAspectRatio="none"
                style={{ cursor: clean ? "default" : node.locked ? "default" : "move" }} />}
              {!asset && !clean && <rect width={node.width} height={node.height} fill="transparent" pointerEvents={selectedId === node.id ? "all" : "none"}
                stroke={selectedId === node.id ? "#dcb56c" : "#dcb56c55"} strokeDasharray="10 8" vectorEffect="non-scaling-stroke" />}
            </g>;
          })}
          {!clean && guides && <rect x="280" y="180" width="1112" height="620" fill="none" stroke="#b7e4c0"
            strokeWidth="1" strokeDasharray="7 7" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {!clean && selected && visibleNode(scene, selected) && <g transform={`matrix(${getGarageNodeMatrix(scene, selected.id).join(" ")})`} pointerEvents="none">
            <rect width={selected.width} height={selected.height} fill="none" stroke="#ffe1a0" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <circle cx={selected.pivotX * selected.width} cy={selected.pivotY * selected.height} r={5 / (selectedWorldScale * viewport.scale)}
              fill="#ffe1a0" stroke="#18372c" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {selected.sockets.map((socket, index) => <g key={socket.id} transform={`translate(${socket.x * selected.width} ${socket.y * selected.height}) scale(${1 / (selectedWorldScale * viewport.scale)})`}>
              <circle r="6" fill="#69d8c5" stroke="#15392d" /><path d="M-10 0H10M0-10V10" stroke="#bbfff4" />
              <path d={`M0 -7 V${-10 - index * 18}`} stroke="#bbfff480" />
              <text x="8" y={-14 - index * 18} fill="#d9fff8" fontSize="11" paintOrder="stroke" stroke="#15392d" strokeWidth="3">{socket.name}</text>
            </g>)}
          </g>}
        </g>
      </svg>
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
