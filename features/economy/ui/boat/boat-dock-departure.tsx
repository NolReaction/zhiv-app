import { useState } from "react";
import { Fish, Fuel, X } from "lucide-react";
import { boatConfig, boatDepartureReason, boatFuelStatus, boatState, boatTripStats } from "@/features/economy/domain/boat-fishing";
import { formatPearls } from "@/features/economy/domain/money";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { BoatDepartureReview } from "./boat-departure-review";
import { BoatCountdown } from "./boat-countdown";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
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
        <small>{nextAt !== null ? <>+1 через <BoatCountdown until={nextAt} now={economy.now} readClock={economy.readServerNow} /></> : `+1 каждые ${worldDuration(config.fuel.regenSeconds)}`}</small>
      </div>
      {boat.work ? <p className={styles.workNote}>{reason}</p> : cells === 0 ? <div className={styles.refill} data-fuel-refill>
        <small>Жемчуг в наличии: {formatPearls(state.wallet.pearls)}</small>
        <div>{quotedPrice === price ? <>
          <button type="button" className={shared.secondary} aria-label="Отмена" onClick={() => setQuotedPrice(null)}><X size={15} /></button>
          <button type="button" className={shared.primary} disabled={disabled || state.wallet.pearls < price}
            aria-label={`Подтвердить заправку за ${formatPearls(price)} жемчужин`} onClick={() => {
              if (send("buy_boat_fuel", "fuel_cell")) setQuotedPrice(null);
            }}>Купить <ItemIcon itemId="pearls" size={15} />{formatPearls(price)}</button>
        </> : <button type="button" className={shared.secondary} disabled={disabled || state.wallet.pearls < price}
          aria-label={`Купить одну ячейку за ${formatPearls(price)} жемчужин`} onClick={() => setQuotedPrice(price)}>
          +1 ячейка <ItemIcon itemId="pearls" size={15} />{formatPearls(price)}
        </button>}</div>
      </div> : <BoatDepartureReview economy={economy} disabled={disabled} reason={reason} send={send} />}
    </div>
    {reason && cells > 0 && !boat.work && <p className={shared.note}>{reason}</p>}
  </section>;
}
