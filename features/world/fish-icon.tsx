import { FISH_SPECIES, fishShapes, fishSpeciesId, type FishSpeciesId } from "./fish-species";

type Props = { species?: FishSpeciesId; size?: number; className?: string; label?: string };

export function FishArt({ species = "fish" }: Pick<Props, "species">) {
  const id = fishSpeciesId(species), colors = FISH_SPECIES[id].colors;
  return <g strokeLinecap="round" strokeLinejoin="round">{fishShapes(id).map((shape, index) => {
    const props = { fill: shape.fill ? colors[shape.fill] : "none", stroke: shape.stroke ? colors[shape.stroke] : "none", strokeWidth: shape.width };
    return shape.kind === "ellipse"
      ? <ellipse key={index} cx={shape.x} cy={shape.y} rx={shape.rx} ry={shape.ry} {...props} />
      : shape.kind === "polygon"
        ? <polygon key={index} points={shape.points.map(point => point.join(",")).join(" ")} {...props} />
        : <polyline key={index} points={shape.points.map(point => point.join(",")).join(" ")} {...props} />;
  })}</g>;
}

/** Inline vector twin of the fish used in the forest; no image load or canvas effect. */
export function FishIcon({ species = "fish", size = 40, className, label }: Props) {
  return <svg viewBox="-0.85 -0.53 1.48 1.06" width={size} height={size} className={className}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false"
    fill="none" strokeLinecap="round" strokeLinejoin="round">
    <FishArt species={species} />
  </svg>;
}
