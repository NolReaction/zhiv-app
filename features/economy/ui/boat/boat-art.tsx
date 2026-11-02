import { useId } from "react";
import { BOAT_ASSEMBLY, boatArtworkLayers, type BoatArtLayer, type BoatArtModule } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import styles from "./boat-art.module.css";

/** SVG is only a viewport for independently replaceable raster layers, with no drawn hull. */
function RasterPart({ layer }: { layer: BoatArtLayer }) {
  const [x, y, width, height] = layer.box;
  return <svg x={x} y={y} width={width} height={height} viewBox={layer.crop.join(" ")} overflow="hidden" preserveAspectRatio="none">
    <image href={layer.src} width={layer.source[0]} height={layer.source[1]} />
  </svg>;
}

export function BoatArt({ repaired = true, crate = false, oars = false, net = false, telescope = false,
  travelling = false, selectedModule, previewModule }: {
  repaired?: boolean; crate?: boolean; oars?: boolean; net?: boolean; telescope?: boolean; travelling?: boolean;
  selectedModule?: BoatArtModule; previewModule?: BoatArtModule;
}) {
  const id = useId().replace(/:/g, ""), front = `${id}-front`;
  const layers = boatArtworkLayers({ repaired, upgrades: [crate && "crate", oars && "oars"].filter(Boolean) as string[],
    artifacts: [net && "landing_net", telescope && "telescope"].filter(Boolean) as string[], previewModule });
  const hull = layers[0];
  return <svg viewBox={`0 100 ${BOAT_ASSEMBLY.width} 500`} className={styles.art} role="img"
    aria-label={repaired || previewModule === "repair" ? "Рыбацкая лодка с установленными модулями" : "Повреждённый корпус лодки"}
    data-boat-art={repaired ? "repaired" : "broken"} data-travelling={travelling || undefined} data-preview-module={previewModule}>
    <defs><clipPath id={front}><rect x="0" y={BOAT_ASSEMBLY.foredeck} width={BOAT_ASSEMBLY.width} height={BOAT_ASSEMBLY.height} /></clipPath></defs>
    <g className={styles.assembly}>
      {layers.filter(layer => layer.id !== "oars").map(layer => <g key={layer.id} data-boat-part={layer.id} className={styles.part}
        data-selected={selectedModule === layer.id || undefined} data-preview={previewModule === layer.id || undefined}><RasterPart layer={layer} /></g>)}
      <g clipPath={`url(#${front})`} aria-hidden="true"><RasterPart layer={hull} /></g>
      {layers.filter(layer => layer.id === "oars").map(layer => <g key={layer.id} data-boat-part={layer.id} className={styles.part}
        data-selected={selectedModule === layer.id || undefined} data-preview={previewModule === layer.id || undefined}><RasterPart layer={layer} /></g>)}
    </g>
  </svg>;
}
