import { BOAT_ART_PARTS, type BoatArtModule } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";

/** Crop transparent source padding without changing or repainting a generated part. */
export function BoatModuleThumbnail({ module, className, undiscovered = false }: { module: BoatArtModule; className?: string; undiscovered?: boolean }) {
  const layer = BOAT_ART_PARTS[module];
  return <svg viewBox={layer.crop.join(" ")} className={className} width={144} height={90}
    aria-hidden="true" focusable="false" data-undiscovered={undiscovered || undefined}>
    <image href={layer.src} width={layer.source[0]} height={layer.source[1]} />
  </svg>;
}
