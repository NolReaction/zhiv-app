import { BOAT_GARAGE_STAND_ASSET, boatGarageStandFrames } from "@/features/world/objects/fishing-boat/fishing-boat-garage-layout.mjs";
import { BoatArtAssembly, type BoatArtProps } from "./boat-art";
import styles from "./boat-art.module.css";

const stands = boatGarageStandFrames({ boatScale: .625, boatY: 185 });

/** Dry-dock scenery is kept outside the floating/travelling boat assembly. */
export function BoatGarageArt(props: BoatArtProps) {
  return <svg viewBox="0 185 1000 490" className={styles.art} role="img"
    aria-label="Рыбацкая лодка на двух винтовых подставках" data-boat-garage-art>
    <g data-garage-supports aria-hidden="true">{stands.map((stand, index) => <g key={index}>
      <ellipse cx={stand.x} cy={stand.y + 1} rx={153 * stand.scale} ry={9 * stand.scale} fill="#291d12" opacity=".35" />
      <g transform={`translate(${stand.x} ${stand.y}) scale(${stand.scale}) translate(-160 -304)`}>
        <image href={BOAT_GARAGE_STAND_ASSET.src} width={stand.width} height={stand.height} />
      </g>
    </g>)}</g>
    <BoatArtAssembly {...props} />
  </svg>;
}
