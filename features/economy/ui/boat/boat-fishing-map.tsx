"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertDialog } from "radix-ui";
import { ArrowLeft, Clock3, Fish, FishingRod, Sailboat, X } from "lucide-react";
import { boatConfig, boatState } from "@/features/economy/domain/boat-fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";
import { BoatDevControls } from "@/features/economy/dev/boat-dev-controls";
import { BoatCatchList } from "./boat-panels";
import { BoatReelGame, type BoatReelVisualState } from "./boat-reel-game";
import { FishingSceneCanvas } from "./scene/fishing-scene-canvas";
import { useFishingAudio } from "./use-fishing-audio";
import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import type { BoatSend } from "./world-boat-fishing-dialog";
import styles from "./boat-fishing-map.module.css";

type Props = { economy: ReadyEconomy; disabled: boolean; send: BoatSend; onClose: () => void;
  suspended?: boolean; appearance?: FishingSceneFrame["appearance"] };

/** A separate river view shares the saved voyage, never a second source of rewards. */
export function BoatFishingMap({ economy, disabled, send, onClose, appearance, suspended = false }: Props) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), voyage = boat.voyage!;
  const challenge = voyage.challenge;
  const [visual, setVisual] = useState<BoatReelVisualState | null>(null);
  const [confirmReturn, setConfirmReturn] = useState(false), [showCatch, setShowCatch] = useState(false), [showDev, setShowDev] = useState(false);
  const publishVisual = useCallback((next: BoatReelVisualState) => setVisual(next), []);
  const remaining = Math.max(0, voyage.maxCasts - voyage.castsUsed);
  const expired = challenge && economy.now >= Date.parse(challenge.expiresAt);
  const activeVisual = visual?.challengeId === challenge?.id ? visual : null;
  const frame = useMemo<FishingSceneFrame>(() => ({ stage: suspended ? "paused" : challenge ? activeVisual?.stage ?? (expired ? "expired" : "bite") : "waiting",
    held: activeVisual?.held ?? false, castKey: challenge?.id, reel: activeVisual?.reel,
    boat: { repaired: true, upgrades: boat.upgrades }, rodId: voyage.loadout.rodId, appearance }),
  [suspended, challenge, activeVisual, expired, boat.upgrades, voyage.loadout.rodId, appearance]);
  useFishingAudio({ ownerPublicId: state.ownerPublicId, voyageId: voyage.id, stage: frame.stage, castKey: frame.castKey,
    held: frame.held, progress: frame.reel?.progress ?? 0,
    inZone: Boolean(frame.reel && Math.abs(frame.reel.bar - frame.reel.fish) <= frame.reel.zoneWidth / 2),
    caughtCount: voyage.catches.length, suspended });
  const finishReturn = () => { if (!disabled && send("return_boat", voyage.id)) setConfirmReturn(false); };
  return <section className={styles.map} data-boat-map data-fishing-stage={frame.stage} aria-label="Карта речной рыбалки">
    <FishingSceneCanvas frame={frame} className={styles.canvas} />
    <header className={styles.header}><div className={styles.location}><span>РЕЧНАЯ РЫБАЛКА</span><h2>{config.name}</h2><small><Clock3 size={13} /><span className={styles.returnLabel}>До возвращения</span><time>{worldCountdown(Math.max(0, Math.ceil((Date.parse(voyage.fishingUntil) - economy.now) / 1000)))}</time></small></div>
      <div className={styles.headerActions}><span className={styles.counter}><FishingRod size={16} />{remaining}<small>забросов</small></span><span className={styles.counter}><Fish size={16} />{voyage.catches.length} / {voyage.maxCatches}<small>на борту</small></span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="К поляне, сохранить рыбалку"><X size={22} /></button></div></header>
    <div className={styles.tools}><button type="button" className={styles.tool} onClick={() => setShowCatch(value => !value)} aria-expanded={showCatch}><Fish size={16} />Улов · {voyage.catches.length}</button>
      {process.env.NODE_ENV === "development" && economy.devAvailable && <button type="button" className={styles.tool} onClick={() => setShowDev(value => !value)} aria-expanded={showDev}>DEV</button>}</div>
    {showCatch && <aside className={styles.catchTray}><button type="button" className={styles.trayClose} onClick={() => setShowCatch(false)} aria-label="Закрыть улов"><X size={18} /></button><BoatCatchList state={state} boat={boat} /></aside>}
    {showDev && <aside className={styles.devTray}><button type="button" className={styles.trayClose} onClick={() => setShowDev(false)} aria-label="Закрыть DEV рыбалки"><X size={18} /></button><BoatDevControls economy={economy} compact /></aside>}
    {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
    {economy.uncertain && <div className={styles.recovery}><span>Проверяем последнее действие.</span><button type="button" disabled={economy.busy} onClick={() => economy.retry()}>Проверить результат</button></div>}
    <div className={styles.bottom}>
      <div className={styles.controls}>
        {challenge ? <BoatReelGame owner={state.ownerPublicId} voyageId={voyage.id} challenge={challenge} now={economy.now} disabled={disabled || suspended}
          uncertain={economy.uncertain} suspended={suspended || showCatch || showDev || confirmReturn} onVisualState={publishVisual} onSubmit={reel => send("submit_boat_cast", voyage.id, reel)} />
          : <div className={styles.waiting}><span className={styles.eyebrow}><Sailboat size={15} />Мохлик на речном плёсе</span><h3>{remaining ? "Пора забросить удочку" : "Все забросы использованы"}</h3><p>{remaining ? "Забросьте удочку. Следите за поплавком и удерживайте рыбу в зоне снасти." : "Улов остаётся на борту. Можно возвращаться к причалу."}</p></div>}
        {(!challenge || expired) && remaining > 0 && <button type="button" className={styles.primary} data-fishing-action="cast" disabled={disabled || suspended} onClick={() => { if (!disabled) send("begin_boat_cast", voyage.id); }}><FishingRod size={18} />Забросить удочку</button>}
        <div className={styles.bottomRow}><button type="button" className={styles.back} onClick={onClose}><ArrowLeft size={15} />К поляне</button><button type="button" className={styles.back} data-fishing-action="return" disabled={disabled || suspended} onClick={() => { if (!disabled) setConfirmReturn(true); }}>Вернуться с уловом</button></div>
      </div>
    </div>
    <AlertDialog.Root open={confirmReturn} onOpenChange={setConfirmReturn}><AlertDialog.Portal>
      <AlertDialog.Overlay className={styles.confirmationOverlay} />
      <AlertDialog.Content className={styles.confirmation}>
        <AlertDialog.Title>Вернуться к причалу?</AlertDialog.Title><AlertDialog.Description>{challenge && !expired ? "Текущая рыба уйдёт. " : ""}Оставшиеся забросы закончатся. Пойманная рыба останется на борту.</AlertDialog.Description>
        <div><AlertDialog.Cancel asChild><button type="button" className={styles.secondary}>Остаться</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className={styles.primary} data-fishing-action="confirm-return" disabled={disabled || suspended} onClick={event => { event.preventDefault(); finishReturn(); }}>Вернуться</button></AlertDialog.Action></div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </section>;
}
