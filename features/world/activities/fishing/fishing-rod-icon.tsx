import { FISHING_ROD_ICON, fishingRodAppearance, fishingRodId, fishingRodPath, fishingRodShapes } from "./fishing-rod-art";

type Props = { rodId?: string; size?: number; className?: string; label?: string };

/** Actual model illustration, shared with Canvas; no generic action glyph. */
export function FishingRodIcon({ rodId, size = 44, className, label }: Props) {
  const id = fishingRodId(rodId), colors = fishingRodAppearance(id), framing = FISHING_ROD_ICON;
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={framing.viewBox} width={size} height={size}
    className={className} data-fishing-rod={id} focusable="false" role={label ? "img" : undefined}
    aria-label={label} aria-hidden={label ? undefined : true} style={{ flexShrink: 0, verticalAlign: "middle" }}>
    <g transform={`translate(${framing.origin.x} ${framing.origin.y}) rotate(${framing.angle}) scale(${framing.scale})`}
      strokeLinecap="round" strokeLinejoin="round">
      {fishingRodShapes(id).map((shape, index) => {
        const props = { fill: shape.fill ? colors[shape.fill] ?? colors.handle : "none",
          stroke: shape.stroke ? colors[shape.stroke] ?? colors.handle : "none", strokeWidth: shape.width };
        return shape.kind === "path" ? <path key={index} d={fishingRodPath(shape.commands)} {...props} />
          : <ellipse key={index} cx={shape.x} cy={shape.y} rx={shape.rx} ry={shape.ry} {...props} />;
      })}
    </g>
  </svg>;
}
