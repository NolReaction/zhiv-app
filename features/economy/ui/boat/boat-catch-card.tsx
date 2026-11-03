import { Sparkles, Trophy } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import type { BoatVoyage } from "@/features/economy/domain/boat-model";
import { ItemIcon } from "@/features/items/item-icon";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";
import { boatCatchPresentation } from "./boat-catch-presentation";
import { boatCatchStory } from "./boat-catch-story";
import { boatFishWeightLabel } from "./boat-panels";
import styles from "./boat-catch-card.module.css";

/** Only the public, confirmed catch list may supply this card. */
export function BoatCatchCard({ state, caught }: { state: EconomyView; caught: BoatVoyage["catches"][number] }) {
  const presentation = boatCatchPresentation(state, caught);
  const story = boatCatchStory(state, caught);
  return <div className={styles.card} data-confirmed-catch={caught.fishId} data-catch-size={presentation.sizeLabel} data-rarity={presentation.rarity} data-catch-record={presentation.isRecord || undefined} role="status">
    <span className={styles.portrait}><ItemIcon itemId={caught.fishId} size={64} /></span>
    <div className={styles.details}><span className={styles.rarity}>{presentation.rarityLabel} · {presentation.sizeLabel}</span>
      <h3>{itemName(state, caught.fishId)} на борту!</h3>
      <div className={styles.weight}><strong>{boatFishWeightLabel(caught.weightGrams)}</strong><span title={story.tripSpeciesCount > 1 ? "Поймано этого вида за текущую поездку" : undefined}>{story.tripSpeciesCount > 1 ? `Этого вида: ${story.tripSpeciesCount} шт.` : "Улов подтверждён"}</span></div>
      {story.note && <p className={styles.note} title={story.note}>{story.note}</p>}
      <div className={styles.badges}>{presentation.isNewSpecies && <span><Sparkles size={12} />Новый вид</span>}{presentation.isRecord && <span><Trophy size={12} />{presentation.previousBestGrams > 0 ? "Личный рекорд!" : "Первый рекорд"}</span>}</div>
      {presentation.isRecord && presentation.previousBestGrams > 0 && <small className={styles.previous}>Прежний: {boatFishWeightLabel(presentation.previousBestGrams)} · +{boatFishWeightLabel(story.recordGainGrams)}</small>}
    </div>
  </div>;
}
