import { Anchor, Check, Coins, Fish, Package, Sailboat, Waves } from "lucide-react";
import { boatConfig, boatModules, boatPhase, boatReturnStartedAt, boatReturnsAt, boatState } from "@/features/economy/domain/boat-fishing";
import { ECONOMY_MAX_BALANCE } from "@/features/economy/domain/model";
import { boatDockSaleQuote } from "@/features/economy/domain/boat-dock-sale";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { BoatCountdown } from "./boat-countdown";
import { BoatArt } from "./boat-art";
import { BoatTripSummary } from "./boat-trip-summary";
import { createBoatTripReceipt } from "./boat-trip-summary-data";
import summaryStyles from "./boat-trip-summary.module.css";
import { BoatCatchList } from "./boat-panels";
import type { BoatSend } from "./world-boat-fishing-dialog";
import styles from "./boat-fishing.module.css";

type Props = { economy: ReadyEconomy; disabled: boolean; send: BoatSend; onOpenPantry?: () => void };
export function BoatVoyagePanel({ economy, disabled, send, onOpenPantry }: Props) {
  const state = economy.snapshot, boat = boatState(state), voyage = boat.voyage;
  if (!voyage) return null;
  const phase = boatPhase(boat, economy.now);
  if (phase === "ready") {
    if (economy.preparedBoatPending || economy.pendingBoatCastId && economy.pendingBoatCastId === voyage.challenge?.id) {
      const pending = (economy.localBoatCatches ?? 0) + Number(economy.pendingBoatOutcome === "caught");
      return <section className={summaryStyles.unloading} data-boat-manifest-pending role="status">
        <h3>Лодка у причала</h3>
        <p>{pending > 0 ? `Сохраняем улов · ${pending}. ` : ""}После сверки последнего заброса можно будет разгрузить лодку.</p>
        <BoatCatchList state={state} boat={boat} />
      </section>;
    }
    const sale = boatDockSaleQuote(voyage.catches, state.catalog);
    const walletFull = sale != null && sale.total > ECONOMY_MAX_BALANCE - state.wallet.coins;
    const shortfall = Math.max(0, voyage.catches.length - state.storage.available);
    return <section data-boat-trip-ready>
      <BoatTripSummary receipt={createBoatTripReceipt(state, voyage)} />
      <div className={summaryStyles.unloading}>
        {shortfall > 0 && <p>Освободите мест в кладовой: {shortfall}. Улов ждёт на борту.</p>}
        {sale && <p>Выкуп у причала: {sale.base} за весь улов + {sale.bonus} за вес. После разгрузки в холодильнике рыба продаётся поштучно по цене своей редкости.{walletFull && " Кошелёк заполнен."}</p>}
        {sale && <button type="button" className={styles.secondary} disabled={disabled || walletFull}
          onClick={() => send("sell_boat_catch", voyage.id, undefined, sale.total)}><Coins size={17} />Продать весь улов · {sale.total} монет</button>}
        {shortfall > 0
          ? <button type="button" className={styles.primary} disabled={!onOpenPantry || economy.busy} onClick={onOpenPantry}><Package size={17} />В кладовую</button>
          : <button type="button" className={styles.primary} disabled={disabled} onClick={() => send("claim_boat", voyage.id)}><Check size={17} />{voyage.catches.length ? "Принять улов" : "Завершить выход"}</button>}
      </div>
    </section>;
  }
  if (phase !== "outbound" && phase !== "returning") return null;
  const outbound = phase === "outbound";
  const start = outbound ? Date.parse(voyage.departedAt) : boatReturnStartedAt(voyage);
  const end = outbound ? Date.parse(voyage.arrivesAt) : boatReturnsAt(voyage);
  const config = boatConfig(state.catalog);
  return <>
    <div className={styles.layout}>
      <div className={styles.boatView}><div className={styles.art}><BoatArt modules={boatModules(boat)} repaired={boat.level > 0} travelling /></div><div className={styles.caption}><span><Waves size={14} />{config.name}</span><span><Fish size={14} />{voyage.catches.length} на борту</span></div></div>
      <section className={styles.trip} aria-label="Состояние лодки">
        <span className={styles.eyebrow}><Anchor size={13} />{outbound ? "Дорога к месту ловли" : "Возвращение домой"}</span>
        <h3>{outbound ? "К месту ловли" : "Курс на причал"}</h3><div className={styles.travelLine}><Anchor size={19} /><span /><Sailboat size={28} /><span /><Fish size={20} /></div>
        <p className={styles.timer}><BoatCountdown until={end} now={economy.now} readClock={economy.readServerNow} /></p>
        <p className={styles.muted}>{outbound ? "После прибытия здесь откроется рыбалка. Можно закрыть окно и заняться лесом." : "Улов на борту. Заберите его в мастерской, когда Мохлик вернётся."}</p>
        <progress className={styles.progress} value={Math.min(1, Math.max(0, (economy.now - start) / Math.max(1, end - start)))} max={1} aria-label="Путь лодки" />
      </section>
    </div>
    <BoatCatchList state={state} boat={boat} />
  </>;
}
