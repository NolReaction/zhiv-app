import styles from "./fish-rarity.module.css";

export const FISH_RARITY_LEVELS = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type FishRarity = typeof FISH_RARITY_LEVELS[number];
export const FISH_RARITY_NAMES: Record<FishRarity, string> = {
  common: "Обычная", uncommon: "Необычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная",
};

export function FishRarityBadge({ rarity, className }: { rarity: FishRarity; className?: string }) {
  return <span className={[styles.badge, className].filter(Boolean).join(" ")} data-fish-rarity={rarity}>{FISH_RARITY_NAMES[rarity]}</span>;
}

/** This is a classification key, not a list of fictional catches or unlocked species. */
export function FishRarityScale() {
  return <div className={styles.scale} aria-label="Разряды рыб"><span>Разряды улова</span><div>{FISH_RARITY_LEVELS.map(rarity => <FishRarityBadge key={rarity} rarity={rarity} />)}</div></div>;
}
