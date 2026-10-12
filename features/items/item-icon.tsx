import type { ReactNode } from "react";
import { naturalItemArt } from "./art-natural";
import { relicItemArt } from "./art-relics";
import { craftedItemArt } from "./art-crafted";
import { collectionArt } from "./art-collection";
import { equipmentArt } from "./art-equipment";
import { hookArt } from "./art-hooks";
import { foodItemArt } from "./art-food";
import { FishArt } from "@/features/world/activities/fishing/fish-icon";
import { FISH_SPECIES_IDS } from "@/features/world/activities/fishing/fish-species";

const fishingArt: Record<string, ReactNode> = {
  glow_bait: <>
    <path d="M14 15h21l3 23c-4 7-24 7-28 0Z" fill="#789e88" />
    <ellipse cx="24" cy="15" rx="11" ry="4" fill="#516c5f" />
    <path d="M13 12h22v6H13Z" fill="#b5bf93" />
    <path d="m18 26 3 2m7-5 3 2m-7 8 3 2" stroke="#dded9f" strokeWidth="4" />
    <path d="m16 28 7-3m3-2 7-3m-13 16 9-5" stroke="#bdd398" strokeWidth="1" />
    <path d="M14 38c6 3 14 3 20 0" stroke="#c8d5ad" strokeWidth="1.5" />
  </>,
  firefly_bait: <>
    <path d="M24 24c-3-16-16-14-14-5 1 5 8 8 14 8m1-3c6-16 18-11 13-3-3 4-9 6-13 6" fill="#c6b5d8" />
    <path d="m15 15 10 11 10-12" fill="none" stroke="#eadcc6" strokeWidth="1.5" />
    <path d="M26 24c-9 3-13 10-8 15 6 5 15-2 12-9Z" fill="#b39a65" />
    <path d="m17 32 11 3m-10-6 11 3" stroke="#6d5e65" strokeWidth="2" />
    <ellipse cx="20" cy="38" rx="4" ry="3" fill="#eade98" strokeWidth="1.3" />
    <circle cx="28" cy="24" r="4" fill="#746780" />
    <path d="m28 20 1-6m2 8 5-4m-2 15 7 1" stroke="#806c75" strokeWidth="1.3" />
    <path d="m7 32 1-4 2 4 4 1-4 1-2 4-1-4-4-1Z" fill="#eee2a3" strokeWidth="1" />
  </>,
  ...Object.fromEntries(FISH_SPECIES_IDS.map(species => [species,
    <g key={species} transform="translate(27 25) scale(27)"><FishArt species={species} /></g>])),
  crumb_bait: <>
    <path d="M13 19c-2 5-7 14-4 19 4 6 27 6 31-1 2-5-4-14-6-19Z" fill="#bda370" />
    <path d="m15 9 5 2 5-3 7 2-1 8H17Z" fill="#dfca96" />
    <path d="M15 19c6 2 15 2 19-1" stroke="#776745" strokeWidth="3" />
    <path d="m22 20 3 7 5-1m-5-5-5 6" stroke="#78654b" strokeWidth="1.6" />
    <path d="m18 30 4-2 3 4-3 3-5-2Zm11 3 4-1 2 4-5 2Z" fill="#e4c578" stroke="#91754c" strokeWidth="1.3" />
    <circle cx="13" cy="39" r="2" fill="#e7d395" stroke="none" />
  </>,
  worm_bait: <>
    <path d="M9 23h30v13c0 8-30 8-30 0Z" fill="#819b86" />
    <ellipse cx="24" cy="23" rx="15" ry="6" fill="#526d5b" />
    <path d="M16 24c-3-6 5-5 4-10-1-4 5-6 8-2 4 5-4 6-2 11" stroke="#d59680" strokeWidth="4.5" />
    <path d="m20 15 3 1m1-6 1 3m0 5 3 1" stroke="#ac6f60" strokeWidth="1.2" />
    <path d="M10 30c7 4 21 4 28 0" stroke="#b9c6a3" strokeWidth="2" />
    <path d="M15 36h18" stroke="#607560" strokeWidth="1.5" />
  </>,
};

const currencyArt: Record<string, ReactNode> = {
  coins: <>
    <path d="M8 25h25v10c0 5-25 5-25 0Z" fill="#c3943e" />
    <ellipse cx="20.5" cy="25" rx="12.5" ry="5" fill="#f0cd70" />
    <path d="M10 31c6 4 15 4 21 0M14 34v3m7-2v4m6-5v3" stroke="#8d6b31" strokeWidth="1.5" />
    <ellipse cx="29" cy="19" rx="12" ry="15" transform="rotate(18 29 19)" fill="#e3b34e" />
    <ellipse cx="29" cy="19" rx="8.5" ry="11.5" transform="rotate(18 29 19)" fill="#f6d67d" stroke="#b58838" strokeWidth="1.5" />
    <path d="m30 11-5 8 6 1-4 8" stroke="#9c702e" strokeWidth="2.7" />
    <path d="m24 8 3-1m11 10v5" stroke="#fff0b5" strokeWidth="2.4" />
  </>,
  pearls: collectionArt.river_pearl,
};

const itemArt: Record<string, ReactNode> = { ...naturalItemArt, ...craftedItemArt, ...relicItemArt, ...equipmentArt, ...currencyArt, ...fishingArt, ...hookArt, ...foodItemArt };
export const itemIconIds: readonly string[] = Object.keys(itemArt);
export const collectionIconIds: readonly string[] = Object.keys(collectionArt);

const unknownArt = <>
  <path d="m8 15 16-8 16 8v22l-16 5-16-5Z" fill="#b29970" />
  <path d="m8 15 16 7 16-7M24 22v20" />
  <path d="m16 11 16 8v9l-7 2v-9" fill="#dfc99e" />
</>;

type IconProps = { size?: number; className?: string; label?: string };
function Illustration({ art, size = 24, className, label, itemId, findId }: IconProps & { art: ReactNode; itemId?: string; findId?: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width={size} height={size}
    className={className} focusable="false" role={label ? "img" : undefined} aria-label={label}
    aria-hidden={label ? undefined : true} data-item-icon={itemId} data-collection-icon={findId}
    style={{ flexShrink: 0, verticalAlign: "middle" }}>
    <g fill="none" stroke="#344236" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{art}</g>
  </svg>;
}

/** One visual identity for inventory, recipes, prices, trade and progression. */
export function ItemIcon({ itemId, ...props }: IconProps & { itemId: string }) {
  return <Illustration {...props} itemId={itemId} art={Object.hasOwn(itemArt, itemId) ? itemArt[itemId] : unknownArt} />;
}

/** Collection art is keyed by the find itself, never by its old shared symbol. */
export function CollectionIcon({ findId, size = 48, ...props }: IconProps & { findId: string }) {
  return <Illustration {...props} size={size} findId={findId} art={Object.hasOwn(collectionArt, findId) ? collectionArt[findId] : unknownArt} />;
}
