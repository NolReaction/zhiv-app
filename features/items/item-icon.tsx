import type { ReactNode } from "react";
import { naturalItemArt } from "./art-natural";
import { craftedItemArt } from "./art-crafted";
import { collectionArt } from "./art-collection";
import { equipmentArt } from "./art-equipment";

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

const itemArt: Record<string, ReactNode> = { ...naturalItemArt, ...craftedItemArt, ...equipmentArt, ...currencyArt };
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
