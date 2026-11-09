import { useState } from "react";
import { ArrowRight, Clock3, Fish, FishingRod, Fuel, Sailboat } from "lucide-react";
import { boatConfig, boatDepartureReason, boatFuelStatus, boatState, boatTripStats } from "@/features/economy/domain/boat-fishing";
import { fishingState } from "@/features/economy/domain/fishing";
import { formatPearls } from "@/features/economy/domain/money";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { WorldTacklePicker } from "@/features/economy/ui/fishing/world-tackle-picker";
import { worldCountdown, worldDuration } from "@/features/economy/ui/shared/world-stations";
import { ItemIcon } from "@/features/items/item-icon";
import type { BoatSend } from "./world-boat-fishing-dialog";
import shared from "./boat-fishing.module.css";
import styles from "./boat-dock-departure.module.css";

export function BoatDockDeparture({ economy, disabled, send }: { economy: ReadyEconomy; disabled: boolean; send: BoatSend }) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog);
  const { cells, capacity, nextAt } = boatFuelStatus(boat, economy.now, config);
  const { maxCatches, maxCasts } = boatTripStats(boat, config);
  const price = config.fuel.refillPricePearls;
  const [quotedPrice, setQuotedPrice] = useState<number | null>(null);
  const reason = boatDepartureReason(state, economy.now);
  return <section className={styles.dock} aria-label="Подготовка к выходу">
    <div className={styles.route}>
      <div><strong>{config.name}</strong><span><Fish size={13} />Улов до {maxCatches}<span aria-hidden="true">·</span>Забросов {maxCasts}</span></div>
      <div className={styles.fuel} aria-label={`Бензин: ${cells} из ${capacity}`}>
        <span><Fuel size={13} />Бензин <b>{cells} / {capacity}</b></span>
        <div className={styles.cells} aria-hidden="true">{Array.from({ length: capacity }, (_, index) => <i key={index} data-filled={index < cells || undefined} />)}</div>
        <small>{nextAt !== null ? <>+1 через <time>{worldCountdown((nextAt - economy.now) / 1000)}</time></> : `+1 каждые ${worldDuration(config.fuel.regenSeconds)}`}</small>
      </div>
      <button className={shared.primary} type="button" disabled={disabled || Boolean(reason)} onClick={() => send("depart_boat", config.routeId)}>
        <Sailboat size={16} /><span>Отправиться на рыбалку<small>1 ячейка бензина</small></span><ArrowRight size={15} />
      </button>
    </div>
    {cells === 0 && !boat.work && <div className={styles.refill} data-fuel-refill>
      <span>Можно дождаться заправки или купить одну ячейку.</span>
      <div><small>Жемчуг в наличии: {formatPearls(state.wallet.pearls)}</small>
        {quotedPrice === price ? <>
          <button type="button" className={shared.secondary} onClick={() => setQuotedPrice(null)}>Отмена</button>
          <button type="button" className={shared.primary} disabled={disabled || state.wallet.pearls < price}
            aria-label={`Подтвердить заправку за ${formatPearls(price)} жемчужин`} onClick={() => {
              if (send("buy_boat_fuel", "fuel_cell")) setQuotedPrice(null);
            }}>Заправить <ItemIcon itemId="pearls" size={15} />{formatPearls(price)}</button>
        </> : <button type="button" className={shared.secondary} disabled={disabled || state.wallet.pearls < price}
          aria-label={`Купить одну ячейку за ${formatPearls(price)} жемчужин`} onClick={() => setQuotedPrice(price)}>
          +1 ячейка <ItemIcon itemId="pearls" size={15} />{formatPearls(price)}
        </button>}</div>
    </div>}
    {reason && (cells > 0 || boat.work) && <p className={shared.note}>{reason}</p>}
    <details className={shared.gear}><summary><FishingRod size={16} />Снасти перед выходом</summary>
      <WorldTacklePicker state={state} economy={economy} disabled={disabled} onChoose={(kind, itemId) => send(kind === "rod" ? "equip_fishing_rod" : kind === "hook" ? "equip_fishing_hook" : "equip_fishing_bait", itemId)} />
      <p className={shared.note}>{fishingState(state).equippedBaitId ? "Одна порция наживки на весь выход." : "Можно отправиться без наживки."}</p>
      <p className={shared.note}><Clock3 size={12} /> Время на воде — {worldDuration(config.activeSeconds)}.</p>
    </details>
  </section>;
}
