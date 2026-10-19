import { Hammer } from "lucide-react";
import { stationIcons } from "@/features/economy/ui/shared/world-economy-parts";
import { CampfireIcon } from "./campfire-icon";
import styles from "./construction-requirements.module.css";

/** Reuse the map artwork; older economic tiers keep the latest authored appearance. */
export function ConstructionBuildingArt({ stationId, level = 1 }: { stationId: string; level?: number }) {
  const sources: Record<string, string> = {
    home: `home-level-${Math.min(5, Math.max(1, level))}.png`,
    workshop: `forest-workshop-level-${Math.min(2, Math.max(1, level))}.png`,
    quarry: `/world/buildings/quarry/quarry-lvl-${Math.min(5, Math.max(0, level))}.png`, garden: "bushv1.png",
    woodlot: `lopukh-house-lvl-${level >= 3 ? 2 : 1}.png`,
    bridge: "bridge-level-1.png", lighthouse: "lighthouse-level-1.png",
  };
  const source = sources[stationId];
  const Icon = stationIcons[stationId] ?? Hammer;
  return <span className={styles.art} data-building-art={stationId} data-building-level={level} aria-hidden="true"
    style={source ? { backgroundImage: `url(${source.startsWith("/") ? source : `/world/prototype/${source}`})` } : undefined}>
    {stationId === "dryer" ? <CampfireIcon size={34} /> : !source && <Icon size={27} strokeWidth={1.6} />}
  </span>;
}
