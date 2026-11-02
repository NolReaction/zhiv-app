"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Anchor, ArrowLeft, ArrowRight, BookOpen, Check, Clock3, Fish, FishingRod, Hammer, Package, Sailboat, Trophy, Waves, X } from "lucide-react";
import { boatConfig, boatDepartureReason, boatPhase, boatReturnStartedAt, boatReturnsAt, boatState } from "@/features/economy/domain/boat-fishing";
import type { BoatReelCommand, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import type { EconomyCommand } from "@/features/economy/domain/model";
import { fishingState } from "@/features/economy/domain/fishing";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { WorldTacklePicker } from "@/features/economy/ui/fishing/world-tackle-picker";
import { worldCountdown, worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatArt } from "./boat-art";
import { BoatBlueprints, BoatCatchList, BoatRecords, BoatUpgradeCard, BoatWork } from "./boat-panels";
import { BoatReelGame } from "./boat-reel-game";
import styles from "./boat-fishing.module.css";

const tabs = [{ id: "boat", label: "Лодка", icon: Sailboat }, { id: "blueprints", label: "Чертежи", icon: BookOpen }, { id: "records", label: "Рекорды", icon: Trophy }] as const;
type Tab = typeof tabs[number]["id"];
type Props = { economy: ReadyEconomy; onClose: () => void; onOpenPantry?: () => void };

export function WorldBoatFishingDialog(props: Props) {
  if (!props.economy.snapshot.catalog.boat) return <BoatUnavailableDialog economy={props.economy} onClose={props.onClose} />;
  return <BoatDialogSession key={props.economy.snapshot.ownerPublicId} {...props} />;
}

/** Cached catalogs and older API versions cannot quote the new boat's costs or actions. */
function BoatUnavailableDialog({ economy, onClose }: Pick<Props, "economy" | "onClose">) {
  const id = useId();
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={styles.dialog} style={{ maxWidth: 440 }} aria-describedby={id} data-boat-unavailable
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      <header className={styles.header}><Anchor size={25} /><div><Dialog.Title>Рыбацкая лодка</Dialog.Title></div><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть лодку"><X size={22} /></button></header>
      <div className={styles.body}><section className={styles.trip}><h3>Данные о лодке пока недоступны</h3><Dialog.Description id={id} className={styles.muted}>Обновите сведения о мире, чтобы продолжить.</Dialog.Description>
        <button type="button" className={styles.primary} disabled={economy.busy} onClick={() => economy.refresh()}>Обновить</button>
      </section></div>
    </Dialog.Content>
  </Dialog.Root>;
}

function BoatDialogSession({ economy, onClose, onOpenPantry }: Props) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), phase = boatPhase(boat, economy.now);
  const [tab, setTab] = useState<Tab>("boat"), [confirmReturn, setConfirmReturn] = useState<string | null>(null);
  const sent = useRef(false), content = useRef<HTMLDivElement>(null), id = useId();
  const disabled = locked(economy) || economy.snapshotConfirmed === false;
  const voyage = boat.voyage, challenge = voyage?.challenge;
  const liveChallenge = challenge && economy.now < Date.parse(challenge.expiresAt);
  const hasGame = Boolean(voyage && challenge && phase === "fishing");
  const remaining = voyage ? Math.max(0, voyage.maxCasts - voyage.castsUsed) : 0;
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = false; }, [economy.busy, economy.uncertain, economy.error, state.revision, state.ownerPublicId]);
  useEffect(() => { if (challenge?.id) content.current?.scrollTo({ top: 0 }); }, [challenge?.id]);
  function send(action: EconomyCommand["action"], targetId: string, reel?: BoatReelCommand): boolean {
    if (disabled || sent.current) return false;
    sent.current = true;
    const accepted = economy.act(action, targetId, 1, 0, undefined, undefined, reel);
    if (accepted === false) sent.current = false;
    return accepted !== false;
  }
  const upgrade = (upgradeId: BoatUpgradeId) => { send("start_boat_upgrade", upgradeId); };
  const travelSeconds = boat.upgrades.includes("oars") ? config.oarsTravelSeconds : config.outboundSeconds;
  const catches = config.maxCasts + (boat.upgrades.includes("crate") ? 1 : 0);
  const departureReason = boatDepartureReason(state, economy.now);
  const returnHome = () => { if (voyage && send("return_boat", voyage.id)) setConfirmReturn(null); };
  const selectTab = (next: Tab) => { setTab(next); setConfirmReturn(null); };
  const phaseName = { broken: "Старая лодка у причала", repairing: "Восстанавливаем лодку", docked: "У причала", outbound: "Мохлик плывёт к месту ловли", fishing: "На рыбалке", returning: "Мохлик возвращается домой", ready: "Лодка вернулась" }[phase];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={styles.dialog} aria-describedby={`${id}-description`} data-boat-dialog data-boat-phase={phase}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      <header className={styles.header}><Anchor size={25} strokeWidth={1.6} /><div><small>{phaseName}</small><Dialog.Title>Рыбацкая лодка</Dialog.Title></div><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть лодку"><X size={22} /></button></header>
      <Dialog.Description id={`${id}-description`} className={styles.srOnly}>Лодочная рыбалка, улучшения, книга чертежей и личные рекорды.</Dialog.Description>
      <nav className={styles.tabs} role="tablist" aria-label="Разделы лодки">{tabs.map((entry, index) => <button key={entry.id} id={`${id}-${entry.id}`} type="button" role="tab" className={styles.tab} aria-selected={tab === entry.id} aria-controls={`${id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => selectTab(entry.id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); selectTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus(); }
      }}><entry.icon size={17} />{entry.label}</button>)}</nav>
      {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
      {economy.uncertain && <div className={styles.recovery}><span>Проверим, сохранилось ли последнее действие.</span><button type="button" className={styles.secondary} disabled={economy.busy} onClick={() => economy.retry()}>Проверить</button></div>}
      <div ref={content} className={styles.body} id={`${id}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`${id}-${tab}`}>
        {tab === "blueprints" ? <BoatBlueprints state={state} boat={boat} config={config} now={economy.now} disabled={disabled} onUpgrade={upgrade} onInspect={() => send("inspect_telescope", "port")} />
          : tab === "records" ? <BoatRecords state={state} boat={boat} /> : <>
            {voyage && challenge && phase === "fishing" && <BoatReelGame owner={state.ownerPublicId} voyageId={voyage.id} challenge={challenge} now={economy.now} disabled={disabled} uncertain={economy.uncertain} onSubmit={reel => send("submit_boat_cast", voyage.id, reel)} />}
            <div className={`${styles.layout} ${hasGame ? styles.playingLayout : ""}`}>
              <div className={styles.boatView}><div className={styles.art}><BoatArt repaired={boat.level > 0} crate={boat.upgrades.includes("crate")} oars={boat.upgrades.includes("oars")} net={boat.artifacts.includes("landing_net")} telescope={boat.artifacts.includes("telescope")} travelling={phase === "outbound" || phase === "returning"} /></div>
                <div className={styles.caption}><span><Waves size={14} />{config.name}</span><span><Fish size={14} />{voyage ? `${voyage.catches.length} на борту` : `До ${catches} рыб`}</span></div>
                {phase === "docked" && <details className={styles.gear}><summary><FishingRod size={16} />Снасти перед выходом</summary><WorldTacklePicker state={state} economy={economy} disabled={disabled} onChoose={(kind, itemId) => send(kind === "rod" ? "equip_fishing_rod" : kind === "hook" ? "equip_fishing_hook" : "equip_fishing_bait", itemId)} /><p className={styles.note}>{fishingState(state).equippedBaitId ? "Одна порция наживки на весь выход." : "Можно отправиться без наживки."}</p></details>}
              </div>
              <section className={styles.trip} aria-label="Состояние лодки">
                <span className={styles.eyebrow}><Anchor size={13} />{phaseName}</span>
                {phase === "broken" || phase === "repairing" ? <><h3>У этой лодки ещё будут приключения</h3><p className={styles.muted}>Почините корпус и подготовьте снасти. С лодки можно вываживать рыбу самому и искать новые трофеи.</p><p className={styles.note}>Спокойная рыбалка на пирсе остаётся доступной.</p></>
                  : phase === "docked" ? <><h3>На речной простор</h3><p className={styles.muted}>Мохлик доберётся до места, а вы поможете ему вытащить улов.</p><div className={styles.stats}><div className={styles.stat}><Clock3 size={19} /><div><strong>{worldDuration(travelSeconds)}</strong><small>дорога в одну сторону</small></div></div><div className={styles.stat}><Fish size={19} /><div><strong>{catches} {catches < 5 ? "заброса" : "забросов"}</strong><small>на один выход</small></div></div></div>
                    <button type="button" className={styles.primary} disabled={disabled || Boolean(departureReason)} onClick={() => send("depart_boat", config.routeId)}><Sailboat size={17} />Отправиться на рыбалку<ArrowRight size={15} /></button>{departureReason && <p className={styles.note}>{departureReason}</p>}
                    <p className={styles.note}>На месте лодка ждёт {worldDuration(config.activeSeconds)}, затем возвращается домой.</p></>
                    : voyage && (phase === "outbound" || phase === "returning") ? <><h3>{phase === "outbound" ? "Вёсла тихо рассекают воду" : "Держим курс на причал"}</h3><div className={styles.travelLine}><Anchor size={19} /><span /><Sailboat size={28} /><span /><Fish size={20} /></div>
                      <p className={styles.timer}>{worldCountdown(Math.max(0, Math.ceil(((phase === "outbound" ? Date.parse(voyage.arrivesAt) : boatReturnsAt(voyage)) - economy.now) / 1000)))}</p><p className={styles.muted}>{phase === "outbound" ? "После прибытия здесь откроется рыбалка. Можно закрыть окно и заняться лесом." : "Улов на борту. Заберите его, когда Мохлик вернётся."}</p>
                      <progress className={styles.progress} value={Math.min(1, Math.max(0, (economy.now - (phase === "outbound" ? Date.parse(voyage.departedAt) : boatReturnStartedAt(voyage))) / ((phase === "outbound" ? voyage.outboundSeconds : voyage.inboundSeconds) * 1000)))} max={1} aria-label="Путь лодки" />
                    </> : voyage && phase === "fishing" ? <><h3>{liveChallenge ? "На крючке рыба" : remaining ? "Можно забрасывать" : "Все забросы использованы"}</h3><div className={styles.stats}><div className={styles.stat}><FishingRod size={18} /><div><strong>{remaining}</strong><small>забросов осталось</small></div></div><div className={styles.stat}><Fish size={18} /><div><strong>{voyage.catches.length} / {voyage.maxCatches}</strong><small>рыб на борту</small></div></div></div>
                      {!liveChallenge && remaining > 0 && <button type="button" className={styles.primary} disabled={disabled} onClick={() => send("begin_boat_cast", voyage.id)}><FishingRod size={18} />Забросить удочку</button>}
                      <p className={styles.note}>Лодка отправится домой через {worldCountdown(Math.max(0, Math.ceil((Date.parse(voyage.fishingUntil) - economy.now) / 1000)))}.</p>
                      {confirmReturn === voyage.id ? <div className={styles.confirmation}><p>{liveChallenge ? "Текущая рыба уйдёт. " : ""}Оставшиеся забросы закончатся. Пойманная рыба останется на борту.</p><div><button type="button" className={styles.secondary} onClick={() => setConfirmReturn(null)}>Остаться</button><button type="button" className={styles.primary} disabled={disabled} onClick={returnHome}>Вернуться</button></div></div>
                        : <button type="button" className={styles.secondary} disabled={disabled} onClick={() => remaining || liveChallenge ? setConfirmReturn(voyage.id) : returnHome()}><ArrowLeft size={16} />Вернуться с уловом</button>}
                    </> : voyage && phase === "ready" ? <><h3>{voyage.catches.length ? "Улов прибыл домой" : "Снова у причала"}</h3><p className={styles.muted}>{voyage.catches.length ? `На борту ${voyage.catches.length} рыб. Разгрузите лодку, чтобы пополнить запасы и записать рекорды.` : "Этот выход завершён. Можно подготовить лодку к следующей рыбалке."}</p><button type="button" className={styles.primary} disabled={disabled} onClick={() => send("claim_boat", voyage.id)}>{voyage.catches.length ? <Package size={17} /> : <Check size={17} />}{voyage.catches.length ? "Забрать улов" : "Завершить выход"}</button>{onOpenPantry && <button type="button" className={styles.secondary} onClick={onOpenPantry}>Открыть кладовую</button>}</> : null}
              </section>
            </div>
            <BoatCatchList state={state} boat={boat} />
            {!voyage && !boat.work && <section className={styles.section}><h3 className={styles.sectionHeading}><Hammer size={17} /> {boat.level ? "Обустройство лодки" : "Вернуть лодку на воду"}</h3><div className={styles.upgradeGrid}>{config.upgrades.filter(entry => boat.level ? entry.id === "crate" || entry.id === "oars" : entry.id === "repair").map(entry => <BoatUpgradeCard key={entry.id} state={state} boat={boat} upgrade={entry} now={economy.now} disabled={disabled} onUpgrade={upgrade} />)}</div></section>}
          </>}
        <BoatWork boat={boat} config={config} now={economy.now} disabled={disabled} onClaim={workId => send("claim_boat_upgrade", workId)} />
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
