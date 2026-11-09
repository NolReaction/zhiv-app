import { BOAT_ART_PARTS, type BoatArtModule } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";

/** Storage is a numeric capacity upgrade and never adds a crate image to the boat. */
export function BoatModuleThumbnail({ module, className, undiscovered = false }: { module: BoatArtModule; className?: string; undiscovered?: boolean }) {
  if (module === "crate") return <svg viewBox="0 0 144 90" className={className} width={144} height={90}
    aria-hidden="true" focusable="false" data-undiscovered={undiscovered || undefined} data-boat-capacity-icon>
    <path d="M30 44 Q55 16 88 42 L108 26 L108 62 L88 48 Q57 73 30 44Z" fill="#b6ad7b" stroke="#645d40" strokeWidth="3" strokeLinejoin="round" />
    <circle cx="45" cy="42" r="3" fill="#273c31" /><path d="M62 35 Q74 43 62 55 M34 73H99 M40 80H93" fill="none" stroke="#819d8b" strokeWidth="3" strokeLinecap="round" />
  </svg>;
  const layer = BOAT_ART_PARTS[module];
  const crop = module === "repair" ? [214, 176, 1355, 390] : layer.crop;
  return <svg viewBox={crop.join(" ")} className={className} width={144} height={90}
    aria-hidden="true" focusable="false" data-undiscovered={undiscovered || undefined}>
    <image href={layer.src} width={layer.source[0]} height={layer.source[1]} />
  </svg>;
}
