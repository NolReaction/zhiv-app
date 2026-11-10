import type { EconomyCost, EconomyView } from "@/features/economy/domain/model";
import { ItemIcon } from "@/features/items/item-icon";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import styles from "./boat-fishing.module.css";

export function BoatCost({ state, cost }: { state: EconomyView; cost: EconomyCost }) {
  return <ul className={styles.cost} aria-label="Стоимость работы">
    {cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins || undefined}><ItemIcon itemId="coins" size={17} /><strong>{number(cost.coins)}</strong><span className={styles.srOnly}>монет</span></li>}
    {Object.entries(cost.items).map(([id, quantity]) => <li key={id} data-missing={(state.inventory[id] ?? 0) < quantity || undefined} title={itemName(state, id)}><ProductIcon state={state} itemId={id} size={19} /><span>{itemName(state, id)}</span><strong>×{quantity}</strong></li>)}
  </ul>;
}
