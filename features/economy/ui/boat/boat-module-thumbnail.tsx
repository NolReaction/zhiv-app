import { installedBoatPart, type BoatVisualLevels } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";

/** Cards depict only the part already owned; storage stays inside the hull. */
export function BoatModuleThumbnail({ module, level, className }: {
  module: keyof BoatVisualLevels | "storage"; level: number; className?: string;
}) {
  if (module === "storage") return <svg viewBox="0 0 144 88" className={className} aria-hidden="true" data-boat-capacity-icon>
    <path d="m16 39 13-13h89l10 13-9 33H25Z" fill="#5a4635" stroke="#302e25" strokeWidth="3" strokeLinejoin="round" />
    <path d="m23 39 12-9h78l8 9-9 19H31Z" fill="#25362c" stroke="#bf985e" strokeWidth="3" />
    <path d="M44 46q15-17 35-3l12-6-3 16-11-5q-17 10-33-2Z" fill="#a7b696" stroke="#45564a" strokeWidth="2" />
    <circle cx="52" cy="43" r="1.8" fill="#293932" />
    <path d="M17 39h110M23 60h97M27 68h89" fill="none" stroke="#b18b55" strokeWidth="3" strokeLinecap="round" />
    <path d="m29 42 5 26m80-26-5 26" fill="none" stroke="#c7ac74" strokeWidth="4" />
  </svg>;
  const layer = installedBoatPart(module, level);
  // Detail crops preserve the silhouette at the small touch-card size.
  const crop = module === "hull" ? [232, 180, 1332, 386] : module === "engine" ? [0, 0, 245, 279] : layer.crop;
  return <svg viewBox={crop.join(" ")} className={className} aria-hidden="true" focusable="false">
    <image href={layer.src} width={layer.source[0]} height={layer.source[1]} />
  </svg>;
}
