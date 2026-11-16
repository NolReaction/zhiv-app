import { BOAT_SIDE_VIEWPORT, boatArtworkLayers, type BoatArtLayer, type BoatArtModule, type BoatArtPartId, type BoatVisualLevels } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import styles from "./boat-art.module.css";

/** A viewport preserves each source SVG's canvas and its common authored transform. */
function ArtworkPart({ layer }: { layer: BoatArtLayer }) {
  const [x, y, width, height] = layer.box;
  return <svg x={x} y={y} width={width} height={height} viewBox={layer.crop.join(" ")} overflow="hidden" preserveAspectRatio="none">
    <image href={layer.src} width={layer.source[0]} height={layer.source[1]} />
  </svg>;
}

export type BoatArtProps = {
  modules?: BoatVisualLevels; repaired?: boolean; crate?: boolean; oars?: boolean; net?: boolean; telescope?: boolean; travelling?: boolean;
  selectedModule?: BoatArtPartId | "crate"; previewModule?: BoatArtModule;
};

export function BoatArtAssembly({ repaired = true, modules, crate = false, oars = false, net = false, telescope = false,
  selectedModule, previewModule }: BoatArtProps) {
  const layers = boatArtworkLayers({ repaired, modules, upgrades: [crate && "crate", oars && "oars"].filter(Boolean) as string[],
    artifacts: [net && "landing_net", telescope && "telescope"].filter(Boolean) as string[], previewModule });
  return <g className={styles.assembly}>{layers.map(layer => <g key={layer.id} data-boat-part={layer.id} className={styles.part}
    data-selected={selectedModule === layer.id || undefined} data-preview={previewModule === layer.id || undefined}><ArtworkPart layer={layer} /></g>)}</g>;
}

export function BoatArt({ repaired = true, travelling = false, previewModule, ...props }: BoatArtProps) {
  return <svg viewBox={BOAT_SIDE_VIEWPORT.join(" ")} className={styles.art} role="img"
    aria-label={repaired || previewModule === "repair" ? "Рыбацкая лодка с установленными модулями" : "Повреждённый корпус лодки"}
    data-boat-art={repaired ? "repaired" : "broken"} data-travelling={travelling || undefined} data-preview-module={previewModule}>
    <BoatArtAssembly {...props} repaired={repaired} previewModule={previewModule} />
  </svg>;
}
