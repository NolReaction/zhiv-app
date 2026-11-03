"use client";

import { useState } from "react";
import { Anchor, ArrowLeft, Check, Fish, FishingRod, Package, Sailboat, Waves } from "lucide-react";
import { boatConfig, boatPhase, boatReturnStartedAt, boatReturnsAt, boatState } from "@/features/economy/domain/boat-fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";
import { BoatArt } from "./boat-art";
import { BoatCatchList } from "./boat-panels";
import type { BoatSend } from "./world-boat-fishing-dialog";
import styles from "./boat-fishing.module.css";

type Props = { economy: ReadyEconomy; disabled: boolean; send: BoatSend; onOpenPantry?: () => void };
export function BoatVoyagePanel({ economy, disabled, send, onOpenPantry }: Props) {
  const [confirmReturn, setConfirmReturn] = useState<string | null>(null);
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), phase = boatPhase(boat, economy.now);
  const voyage = boat.voyage;
  if (!voyage) return null;
  const challenge = voyage.challenge, liveChallenge = challenge && economy.now < Date.parse(challenge.expiresAt);
  const remaining = Math.max(0, voyage.maxCasts - voyage.castsUsed);
  const returnHome = () => { if (send("return_boat", voyage.id)) setConfirmReturn(null); };
  return <>
    <div className={styles.layout}>
      <div className={styles.boatView}><div className={styles.art}><BoatArt repaired={boat.level > 0} crate={boat.upgrades.includes("crate")} oars={boat.upgrades.includes("oars")} travelling={phase === "outbound" || phase === "returning"} /></div><div className={styles.caption}><span><Waves size={14} />{config.name}</span><span><Fish size={14} />{voyage.catches.length} на борту</span></div></div>
      <section className={styles.trip} aria-label="Состояние лодки">
        <span className={styles.eyebrow}><Anchor size={13} />{phase === "outbound" ? "Дорога к месту ловли" : phase === "returning" ? "Возвращение домой" : phase === "ready" ? "У причала" : "Речной плёс"}</span>
        {phase === "outbound" || phase === "returning" ? <><h3>{phase === "outbound" ? "К месту ловли" : "Курс на причал"}</h3><div className={styles.travelLine}><Anchor size={19} /><span /><Sailboat size={28} /><span /><Fish size={20} /></div>
          <p className={styles.timer}>{worldCountdown(Math.max(0, Math.ceil(((phase === "outbound" ? Date.parse(voyage.arrivesAt) : boatReturnsAt(voyage)) - economy.now) / 1000)))}</p><p className={styles.muted}>{phase === "outbound" ? "После прибытия здесь откроется рыбалка. Можно закрыть окно и заняться лесом." : "Улов на борту. Заберите его, когда Мохлик вернётся."}</p>
          <progress className={styles.progress} value={Math.min(1, Math.max(0, (economy.now - (phase === "outbound" ? Date.parse(voyage.departedAt) : boatReturnStartedAt(voyage))) / ((phase === "outbound" ? voyage.outboundSeconds : voyage.inboundSeconds) * 1000)))} max={1} aria-label="Путь лодки" />
        </> : phase === "fishing" ? <><h3>{liveChallenge ? "На крючке рыба" : remaining ? "Можно забрасывать" : "Все забросы использованы"}</h3><div className={styles.stats}><div className={styles.stat}><FishingRod size={18} /><div><strong>{remaining}</strong><small>забросов осталось</small></div></div><div className={styles.stat}><Fish size={18} /><div><strong>{voyage.catches.length} / {voyage.maxCatches}</strong><small>рыб на борту</small></div></div></div>
          {!liveChallenge && remaining > 0 && <button type="button" className={styles.primary} disabled={disabled} onClick={() => send("begin_boat_cast", voyage.id)}><FishingRod size={18} />Забросить удочку</button>}
          <p className={styles.note}>Лодка отправится домой через {worldCountdown(Math.max(0, Math.ceil((Date.parse(voyage.fishingUntil) - economy.now) / 1000)))}.</p>
          {confirmReturn === voyage.id ? <div className={styles.confirmation}><p>{liveChallenge ? "Текущая рыба уйдёт. " : ""}Оставшиеся забросы закончатся. Пойманная рыба останется на борту.</p><div><button type="button" className={styles.secondary} onClick={() => setConfirmReturn(null)}>Остаться</button><button type="button" className={styles.primary} disabled={disabled} onClick={returnHome}>Вернуться</button></div></div>
            : <button type="button" className={styles.secondary} disabled={disabled} onClick={() => remaining || liveChallenge ? setConfirmReturn(voyage.id) : returnHome()}><ArrowLeft size={16} />Вернуться с уловом</button>}
        </> : phase === "ready" ? <><h3>{voyage.catches.length ? "Улов прибыл домой" : "Снова у причала"}</h3><p className={styles.muted}>{voyage.catches.length ? `На борту ${voyage.catches.length} рыб. Разгрузите лодку, чтобы пополнить запасы и записать рекорды.` : "Этот выход завершён. Можно подготовить лодку к следующей рыбалке."}</p><button type="button" className={styles.primary} disabled={disabled} onClick={() => send("claim_boat", voyage.id)}>{voyage.catches.length ? <Package size={17} /> : <Check size={17} />}{voyage.catches.length ? "Забрать улов" : "Завершить выход"}</button>{onOpenPantry && <button type="button" className={styles.secondary} onClick={onOpenPantry}>Открыть кладовую</button>}</> : null}
      </section>
    </div>
    <BoatCatchList state={state} boat={boat} />
  </>;
}
