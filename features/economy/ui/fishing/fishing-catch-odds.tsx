import { ArrowRight } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyView } from "@/features/economy/domain/model";
import { fishingBaitCompatible, fishingClassOdds, fishingState } from "@/features/economy/domain/fishing";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";
import { FishRarityBadge, FISH_RARITY_NAMES, type FishRarity } from "./fish-rarity";
import { FishingSpeciesFocus, FishingSpeciesOdds } from "./fishing-species-odds";
import styles from "./fishing-catch-odds.module.css";

type Props = { state: EconomyView; catalog: NonNullable<EconomyView["catalog"]["fishing"]>;
  override?: Parameters<typeof fishingClassOdds>[2]; preview?: boolean; targetRarity?: FishRarity; showLoadout?: boolean };
const probabilityFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });
const percent = (probability: number) => `${probabilityFormat.format(probability * 100)}%`;

/** Both merchants compare the same single-item replacement against equipped gear.
 * Class odds are unconditional; species preferences remain explicitly separate. */
export function FishingCatchOdds({ state, catalog, override, preview = false, targetRarity, showLoadout = false }: Props) {
  const current = fishingState(state);
  // Choosing a rod clears an incompatible equipped bait, just like equip_rod.
  const removedBait = preview && override?.rodId && override.baitId === undefined && current.equippedBaitId
    && !fishingBaitCompatible(override.rodId, current.equippedBaitId, catalog) ? current.equippedBaitId : null;
  const previewOverride = removedBait ? { ...override, baitId: null } : override;
  const odds = fishingClassOdds(state, catalog, previewOverride);
  const currentOdds = preview ? fishingClassOdds(state, catalog) : odds;
  const rod = catalog.rods.find(item => item.id === (previewOverride?.rodId ?? current.equippedRodId));
  const hook = catalog.hooks.find(item => item.id === (previewOverride?.hookId ?? current.equippedHookId));
  const baitId = previewOverride?.baitId === undefined ? current.equippedBaitId : previewOverride.baitId;
  return <section className={styles.odds} data-fishing-catch-odds data-guide-plesk-odds aria-label={preview ? "Шансы с выбранной снастью" : "Шансы текущих снастей"}>
    <div className={styles.oddsHeading}><strong>Шансы улова</strong><small>{preview ? "Сейчас → с этой снастью" : "На одну рыбу"}</small></div>
    <dl className={styles.rarityOdds} aria-label="Шансы по классам">{odds.map(({ rarity, itemId, probability }) => {
      const before = currentOdds.find(odd => odd.rarity === rarity)?.probability ?? probability;
      const changed = preview && Math.abs(before - probability) > 1e-10;
      const description = changed ? `Сейчас ${percent(before)} → с этой снастью ${percent(probability)}` : percent(probability);
      return <div key={rarity} data-fish-class-odds={itemId} data-target={rarity === targetRarity || undefined}
        data-fishing-target={rarity === targetRarity ? itemId : undefined} data-odds-change={changed ? probability > before ? "increase" : "decrease" : undefined}>
        <dt><ItemIcon itemId={itemId} size={24} /><FishRarityBadge rarity={rarity} /></dt>
        <dd aria-label={`${FISH_RARITY_NAMES[rarity]} рыба: ${description}`}>
          {changed && <span className={styles.previousOdds} aria-hidden="true">{percent(before)}<ArrowRight size={12} /></span>}
          <strong data-catch-probability={itemId} aria-hidden="true">{percent(probability)}</strong>
        </dd>
      </div>;
    })}</dl>
    {showLoadout && <p className={styles.loadout} data-odds-loadout>
      Для расчёта: {rod?.name} · {hook?.name} · {baitId ? itemName(state, baitId) : "без наживки"}.
    </p>}
    {showLoadout && removedBait && <p className={styles.loadout} data-odds-bait-removed>
      {itemName(state, removedBait)} не подходит к этой удочке и будет снята при её выборе.
    </p>}
    {showLoadout && preview && targetRarity && odds.find(row => row.rarity === targetRarity)?.probability === 0
      && <p className={styles.loadout}>Выбранная удочка пока не ловит этот класс рыбы.</p>}
    <FishingSpeciesFocus state={state} override={previewOverride} />
    <FishingSpeciesOdds state={state} override={previewOverride} />
  </section>;
}
