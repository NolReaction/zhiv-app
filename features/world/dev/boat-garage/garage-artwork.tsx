"use client";

import { useId, type PointerEvent } from "react";
import { getGarageNodeMatrix, transformGaragePoint } from "./garage-scene-model.mjs";
import { garageOccludersForNode } from "./garage-occlusion.mjs";
import { garagePaintOrder } from "./garage-layer-order.mjs";
import type { GarageNode, GarageScene } from "./garage-scene-types";

function visible(scene: GarageScene, node: GarageNode): boolean {
  if (!node.visible) return false;
  const parent = scene.nodes.find(item => item.id === node.parentId);
  return !parent || visible(scene, parent);
}

type Props = {
  scene: GarageScene;
  selectedId: string | null;
  clean: boolean;
  visibleIds?: Set<string>;
  onNodePointerDown: (event: PointerEvent<SVGGElement>, node: GarageNode) => void;
};

/** The hull's actual alpha hides only designated parts. Source rasters are never cut. */
export function GarageArtwork({ scene, selectedId, clean, visibleIds, onNodePointerDown }: Props) {
  const prefix = `garage-occlusion-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ordered = garagePaintOrder(scene)
    .filter(node => visible(scene, node) && (!visibleIds || visibleIds.has(node.id)));
  const masks = ordered.filter(node => node.assetId).map(node => ({ node,
    owners: garageOccludersForNode(scene, node.id).filter(owner => !visibleIds || visibleIds.has(owner.id)) as GarageNode[],
  })).filter(item => item.owners.length);
  const maskedIds = new Set(masks.map(item => item.node.id));
  const owners = [...new Map(masks.flatMap(item => item.owners).map(owner => [owner.id, owner])).values()];

  return <>
    {!!masks.length && <defs>
      <filter id={`${prefix}-black`} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
      </filter>
      {owners.map(owner => <clipPath key={owner.id} id={`${prefix}-clip-${owner.id}`} clipPathUnits="userSpaceOnUse">
        <polygon points={owner.occlusion!.points.map(point => `${point.x * owner.width},${point.y * owner.height}`).join(" ")} />
      </clipPath>)}
      {masks.map(({ node, owners: occluders }) => {
        const matrix = getGarageNodeMatrix(scene, node.id);
        const corners = [{ x: 0, y: 0 }, { x: node.width, y: 0 }, { x: node.width, y: node.height }, { x: 0, y: node.height }]
          .map(point => transformGaragePoint(matrix, point));
        const x = Math.min(...corners.map(point => point.x)) - 2, y = Math.min(...corners.map(point => point.y)) - 2;
        const width = Math.max(...corners.map(point => point.x)) - x + 2, height = Math.max(...corners.map(point => point.y)) - y + 2;
        return <mask key={node.id} id={`${prefix}-mask-${node.id}`} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"
          x={x} y={y} width={width} height={height} style={{ maskType: "luminance" }}>
          <rect x={x} y={y} width={width} height={height} fill="white" />
          {occluders.map(owner => {
            const asset = scene.assets.find(item => item.id === owner.assetId)!;
            return <g key={owner.id} transform={`matrix(${getGarageNodeMatrix(scene, owner.id).join(" ")})`}>
              <g clipPath={`url(#${prefix}-clip-${owner.id})`}>
                <image href={asset.src} width={owner.width} height={owner.height} preserveAspectRatio="none" filter={`url(#${prefix}-black)`} />
              </g>
            </g>;
          })}
        </mask>;
      })}
    </defs>}
    {ordered.map(node => {
      const asset = scene.assets.find(item => item.id === node.assetId);
      return <g key={node.id} mask={maskedIds.has(node.id) ? `url(#${prefix}-mask-${node.id})` : undefined}>
        <g data-node-id={node.id} transform={`matrix(${getGarageNodeMatrix(scene, node.id).join(" ")})`}
          onPointerDown={event => onNodePointerDown(event, node)}>
          {asset && <image href={asset.src} width={node.width} height={node.height} preserveAspectRatio="none"
            style={{ cursor: clean || node.locked ? "default" : "move" }} />}
          {!asset && !clean && <rect width={node.width} height={node.height} fill="transparent" pointerEvents={selectedId === node.id ? "all" : "none"}
            stroke={selectedId === node.id ? "#dcb56c" : "#dcb56c55"} strokeDasharray="10 8" vectorEffect="non-scaling-stroke" />}
        </g>
      </g>;
    })}
  </>;
}
