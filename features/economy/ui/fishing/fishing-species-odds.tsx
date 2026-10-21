import type { EconomyView } from "@/features/economy/domain/model";
import { fishingClassOdds, fishingOdds, fishingState } from "@/features/economy/domain/fishing";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";
import { fishDiscovered, HiddenFishIcon, PlayerItemIcon } from "./fish-discovery";
import { FishRarityBadge } from "./fish-rarity";
import styles from "./fishing-species-odds.module.css";

type Override = Parameters<typeof fishingOdds>[2];
type Props = { state: EconomyView; override?: Override };
const percentage = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const percent = (value: number) => `${percentage.format(value * 100)}%`;
const fishName = (state: EconomyView, itemId: string) => fishDiscovered(state, itemId) ? itemName(state, itemId) : "Неизвестная рыба";
function SpeciesArt({ state, itemId, size }: { state: EconomyView; itemId: string; size: number }) {
  return fishDiscovered(state, itemId) ? <PlayerItemIcon state={state} itemId={itemId} size={size} /> : <HiddenFishIcon size={size} />;
}

/** Picture-led view; numbers describe a single future catch. */
export function FishingSpeciesOdds({ state, override }: Props) {
  const catalog = state.catalog.fishing;
  if (!catalog) return null;
  const odds = fishingOdds(state, catalog, override), classes = fishingClassOdds(state, catalog, override);
  return <details className={styles.details} data-fishing-species-odds>
    <summary>Какая рыба клюнет</summary>
    <div className={styles.groups}>{classes.filter(group => group.probability > 0).map(group => <div key={group.rarity} className={styles.group}>
      <FishRarityBadge rarity={group.rarity} />
      <div className={styles.fish}>{catalog.fish.filter(fish => fish.rarity === group.rarity).map(fish => {
        const probability = odds.find(row => row.itemId === fish.itemId)!.probability, name = fishName(state, fish.itemId);
        return <span key={fish.itemId} className={styles.species} data-species-odds={fish.itemId} aria-label={`${name}: ${percent(probability)} на одну рыбу`}>
          <SpeciesArt state={state} itemId={fish.itemId} size={29} /><span>{name}<strong>{percent(probability)}</strong></span>
          <progress max={1} value={probability / group.probability} aria-label={`Доля внутри класса: ${percent(probability / group.probability)}`} />
        </span>;
      })}</div>
    </div>)}</div>
  </details>;
}

/** Preferences are conditional shares, never extra rarity chance. */
export function FishingSpeciesFocus({ state, override }: Props) {
  const catalog = state.catalog.fishing;
  if (!catalog) return null;
  const current = fishingState(state), rod = catalog.rods.find(rod => rod.id === (override?.rodId ?? current.equippedRodId));
  const hook = catalog.hooks.find(hook => hook.id === (override?.hookId ?? current.equippedHookId));
  const focused = catalog.fish.filter(fish => (rod?.speciesWeights?.[fish.itemId] ?? 100) * (hook?.speciesWeights?.[fish.itemId] ?? 100) > 10000);
  const odds = fishingOdds(state, catalog, override), classes = fishingClassOdds(state, catalog, override);
  const visible = focused.filter(fish => (classes.find(group => group.rarity === fish.rarity)?.probability ?? 0) > 0).slice(0, 3);
  if (!visible.length) return null;
  return <span className={styles.focus} data-species-focus aria-label="Предпочтения внутри класса">{visible.map(fish => {
    const probability = odds.find(row => row.itemId === fish.itemId)!.probability / classes.find(group => group.rarity === fish.rarity)!.probability;
    const name = fishName(state, fish.itemId);
    return <span key={fish.itemId} title={`${name}: ${percent(probability)} внутри своего класса`} aria-label={`${name}: ${percent(probability)} внутри своего класса`}>
      <SpeciesArt state={state} itemId={fish.itemId} size={24} /><strong>{percent(probability)}</strong>
    </span>;
  })}<small>в своём классе</small></span>;
}
