import { Telescope } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { shipOrdersState, shipOrdersUnlocked } from "@/features/economy/domain/ship-orders";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import styles from "./ship-telescope-forecast.module.css";

/** Previously installed telescopes retain their explicit, server-owned forecast. */
export function ShipTelescopeForecast({ state, disabled, onInspect }: {
  state: EconomyView; disabled: boolean; onInspect: () => void;
}) {
  if (!state.boat?.artifacts.includes("telescope")) return null;
  const forecast = shipOrdersState(state).nextVoyage;
  const blocked = disabled || !shipOrdersUnlocked(state);
  return <section className={styles.forecast} aria-label="Подзорная труба" data-ship-telescope>
    <h3><Telescope size={17} aria-hidden="true" />Следующий корабль</h3>
    {forecast ? <>
      <p>Эти товары понадобятся капитану. Можно подготовить их заранее.</p>
      {forecast.orders.map((order, index) => <details key={order.id} open={index === 0} className={styles.order}>
        <summary>Груз {index + 1} · {order.title}</summary>
        <ul>{Object.entries(order.items).map(([itemId, quantity]) => <li key={itemId}>
          <ProductIcon state={state} itemId={itemId} size={20} /><span>{itemName(state, itemId)}</span><strong>×{number(quantity)}</strong>
        </li>)}</ul>
      </details>)}
    </> : <>
      <p>Подзорная труба показывает товары следующего рейса.</p>
      <button type="button" disabled={blocked} onClick={() => { if (!blocked) onInspect(); }}>Посмотреть будущий груз</button>
      {!shipOrdersUnlocked(state) && <p>Сначала восстановите маяк.</p>}
    </>}
  </section>;
}
