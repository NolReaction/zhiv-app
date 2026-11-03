"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";
import { ArrowLeft, BookOpen, CircleHelp, Clock3, Fish, FishingRod, Sailboat, X } from "lucide-react";
import { boatConfig, boatState } from "@/features/economy/domain/boat-fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";
import { BoatDevControls } from "@/features/economy/dev/boat-dev-controls";
import { boatCastStage } from "./boat-cast-timing";
import { BoatCatchList } from "./boat-panels";
import { BoatCatchCard } from "./boat-catch-card";
import { BoatFishingCompletion } from "./boat-fishing-completion";
import { createBoatTripReceipt } from "./boat-trip-summary-data";
import { BoatFishingAlbum } from "./boat-fishing-album";
import { boatCatchPresentation } from "./boat-catch-presentation";
import { BoatReelGame, type BoatReelVisualState } from "./boat-reel-game";
import { FishingSceneCanvas } from "./scene/fishing-scene-canvas";
import { useBoatFishingCoach } from "./use-boat-fishing-coach";
import { boatCoachInstruction } from "./boat-fishing-coach";
import coachStyles from "./boat-fishing-coach.module.css";
import { useFishingAudio } from "./use-fishing-audio";
import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import type { BoatSend } from "./world-boat-fishing-dialog";
import styles from "./boat-fishing-map.module.css";

type Props = { economy: ReadyEconomy; disabled: boolean; send: BoatSend; onClose: () => void;
  suspended?: boolean; timeZone?: string; appearance?: FishingSceneFrame["appearance"] };

/** A separate river view shares the saved voyage, never a second source of rewards. */
export function BoatFishingMap({ economy, disabled, send, onClose, appearance, suspended = false, timeZone = "UTC" }: Props) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), voyage = boat.voyage!;
  const challenge = voyage.challenge;
  const coach = useBoatFishingCoach(state.ownerPublicId);
  const [visual, setVisual] = useState<BoatReelVisualState | null>(null);
  const [showAlbum, setShowAlbum] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false), [showCatch, setShowCatch] = useState(false), [showDev, setShowDev] = useState(false);
  const publishVisual = useCallback((next: BoatReelVisualState) => setVisual(next), []);
  const remaining = Math.max(0, voyage.maxCasts - voyage.castsUsed);
  const expired = challenge && economy.now >= Date.parse(challenge.expiresAt);
  const liveChallenge = Boolean(challenge && !expired);
  const full = voyage.catches.length >= voyage.maxCatches;
  const usableCasts = full ? 0 : remaining;
  const completed = !liveChallenge && usableCasts === 0;
  const lastCatch = voyage.catches.at(-1);
  const lastPresentation = lastCatch ? boatCatchPresentation(state, lastCatch) : undefined;
  const landed = !challenge && lastCatch && economy.now >= Date.parse(lastCatch.caughtAt) && economy.now - Date.parse(lastCatch.caughtAt) < (lastPresentation?.revealMs ?? 3500) ? lastCatch : undefined;
  const fishRarity = landed ? state.catalog.fishing?.fish.find(fish => fish.itemId === landed.fishId)?.rarity : undefined;
  const activeVisual = visual?.challengeId === challenge?.id ? visual : null;
  const hasBite = challenge && !expired && !["casting", "soaking"].includes(activeVisual?.stage ?? boatCastStage(challenge, economy.now));
  const frame = useMemo<FishingSceneFrame>(() => ({ stage: suspended ? "paused" : challenge ? expired ? "expired" : activeVisual?.stage ?? boatCastStage(challenge, economy.now) : landed ? "landed" : "waiting",
    sceneKey: voyage.id, resistance: challenge?.resistance, resistancePhase: expired ? undefined : activeVisual?.resistancePhase,
    ambience: { now: economy.now, timeZone }, biteLeadSeconds: challenge ? Math.max(0, (Date.parse(challenge.biteAt ?? challenge.startedAt) - economy.now) / 1000) : undefined,
    fishSizeScale: landed ? lastPresentation?.sizeScale : undefined, catchKey: landed ? `${state.ownerPublicId}.${voyage.id}.${landed.castIndex}` : undefined,
    fishRarity, fishId: landed?.fishId, held: !expired && (activeVisual?.held ?? false), castKey: challenge?.id, reel: hasBite ? activeVisual?.reel : undefined,
    boat: { repaired: true, upgrades: boat.upgrades }, rodId: voyage.loadout.rodId, appearance }),
  [suspended, challenge, economy.now, timeZone, state.ownerPublicId, voyage.id, landed, lastPresentation?.sizeScale, fishRarity, hasBite, activeVisual, expired, boat.upgrades, voyage.loadout.rodId, appearance]);
  useFishingAudio({ ownerPublicId: state.ownerPublicId, voyageId: voyage.id, stage: frame.stage, castKey: frame.castKey,
    held: frame.held, progress: frame.reel?.progress ?? 0,
    inZone: Boolean(frame.reel && Math.abs(frame.reel.bar - frame.reel.fish) <= frame.reel.zoneWidth / 2),
    caughtCount: voyage.catches.length, ambience: frame.ambience, suspended });
  const finishReturn = () => { if (!disabled && !suspended && send("return_boat", voyage.id)) setConfirmReturn(false); };
  const requestReturn = () => { if (!disabled && !suspended) { if (completed) finishReturn(); else setConfirmReturn(true); } };
  return <section className={styles.map} data-boat-map data-fishing-stage={frame.stage} aria-label="Карта речной рыбалки">
    <FishingSceneCanvas frame={frame} className={styles.canvas} />
    <header className={styles.header}><div className={styles.location}><span>РЕЧНАЯ РЫБАЛКА</span><h2>{config.name}</h2><small>{completed ? <><Sailboat size={13} />Можно возвращаться домой</> : <><Clock3 size={13} /><span className={styles.returnLabel}>До возвращения</span><time>{worldCountdown(Math.max(0, Math.ceil((Date.parse(voyage.fishingUntil) - economy.now) / 1000)))}</time></>}</small></div>
      <div className={styles.headerActions}><span className={styles.counter}><FishingRod size={16} />{remaining}<small>забросов</small></span><span className={styles.counter}><Fish size={16} />{voyage.catches.length} / {voyage.maxCatches}<small>на борту</small></span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="К поляне, сохранить рыбалку"><X size={22} /></button></div></header>
    <div className={styles.tools}><button type="button" className={styles.tool} onClick={() => setShowCatch(value => !value)} aria-expanded={showCatch}><Fish size={16} />Улов · {voyage.catches.length}</button>
      <button type="button" className={styles.tool} data-fishing-action="album" onClick={() => setShowAlbum(true)} aria-haspopup="dialog"><BookOpen size={16} />Альбом рыбака</button>
      <button type="button" className={`${styles.tool} ${coachStyles.trigger}`} data-fishing-action="coach" onClick={coach.replay} aria-label="Повторить подсказки управления"><CircleHelp size={16} /><span>Подсказки</span></button>
      {process.env.NODE_ENV === "development" && economy.devAvailable && <button type="button" className={styles.tool} onClick={() => setShowDev(value => !value)} aria-expanded={showDev}>DEV</button>}</div>
    {showCatch && <aside className={styles.catchTray}><button type="button" className={styles.trayClose} onClick={() => setShowCatch(false)} aria-label="Закрыть улов"><X size={18} /></button><BoatCatchList state={state} boat={boat} /></aside>}
    {showDev && <aside className={styles.devTray}><button type="button" className={styles.trayClose} onClick={() => setShowDev(false)} aria-label="Закрыть DEV рыбалки"><X size={18} /></button><BoatDevControls economy={economy} compact /></aside>}
    {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
    {economy.uncertain && <div className={styles.recovery}><span>Проверяем последнее действие.</span><button type="button" disabled={economy.busy} onClick={() => economy.retry()}>Проверить результат</button></div>}
    <div className={styles.bottom}>
      <div className={styles.controls} data-control-stage={frame.stage} data-fishing-finished={completed || undefined}>
        {challenge && !completed ? <BoatReelGame owner={state.ownerPublicId} voyageId={voyage.id} challenge={challenge} now={economy.now} disabled={disabled || suspended}
          uncertain={economy.uncertain} coachView={coach.view} onCoachObservation={coach.observe} suspended={suspended || showCatch || showDev || showAlbum || confirmReturn} onVisualState={publishVisual} onSubmit={reel => send("submit_boat_cast", voyage.id, reel)} />
          : <div className={styles.waiting} key={landed ? `landed-${landed.castIndex}` : "ready"}>
            {landed ? <BoatCatchCard state={state} caught={landed} /> : completed ? <BoatFishingCompletion receipt={createBoatTripReceipt(state, voyage)} full={full} onShowCatch={() => setShowCatch(true)} /> : <><span className={styles.eyebrow}><Sailboat size={15} />Мохлик на речном плёсе</span><h3>Пора забросить удочку</h3><p className={!coach.view.completed ? coachStyles.prompt : undefined} data-fishing-coach={!coach.view.completed ? "cast" : undefined}>{boatCoachInstruction(coach.view, "waiting") ?? "Забросьте удочку. Следите за поплавком и удерживайте рыбу в зоне снасти."}</p></>}
          </div>}
        {(!challenge || expired) && usableCasts > 0 && <button type="button" className={styles.primary} data-fishing-action="cast" disabled={disabled || suspended} onClick={() => { if (!disabled && !suspended) send("begin_boat_cast", voyage.id); }}><FishingRod size={18} />Забросить удочку</button>}
        {completed && <button type="button" className={styles.primary} data-fishing-action="return" aria-label="Завершить рыбалку и вернуться домой" disabled={disabled || suspended} onClick={requestReturn}><Sailboat size={18} />Завершить и вернуться домой</button>}
        <div className={styles.bottomRow}><button type="button" className={styles.back} onClick={onClose}><ArrowLeft size={15} />К поляне</button><button type="button" className={`${styles.back} ${styles.albumShortcut}`} data-fishing-action="album-shortcut" onClick={() => setShowAlbum(true)} aria-haspopup="dialog"><BookOpen size={15} />Альбом</button><button type="button" className={`${styles.back} ${styles.coachShortcut}`} data-fishing-action="coach-shortcut" onClick={coach.replay} aria-label="Повторить подсказки управления"><CircleHelp size={15} /></button>{!completed && <button type="button" className={styles.back} data-fishing-action="return" disabled={disabled || suspended} onClick={requestReturn}>Вернуться с уловом</button>}</div>
      </div>
    </div>
    <Dialog.Root open={showAlbum} onOpenChange={setShowAlbum}><Dialog.Portal>
      <Dialog.Overlay className={styles.albumOverlay} />
      <Dialog.Content className={styles.albumDialog} data-boat-album-dialog onEscapeKeyDown={event => event.stopPropagation()}>
        <header className={styles.albumHeader}><div><Dialog.Title>Альбом рыбака</Dialog.Title><Dialog.Description>Виды, находки и личные рекорды.</Dialog.Description></div><button type="button" className={styles.close} onClick={() => setShowAlbum(false)} aria-label="Закрыть альбом рыбака"><X size={21} /></button></header>
        <div className={styles.albumBody}><BoatFishingAlbum state={state} /></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    <AlertDialog.Root open={confirmReturn && !completed} onOpenChange={setConfirmReturn}><AlertDialog.Portal>
      <AlertDialog.Overlay className={styles.confirmationOverlay} />
      <AlertDialog.Content className={styles.confirmation}>
        <AlertDialog.Title>Вернуться к причалу?</AlertDialog.Title><AlertDialog.Description>{liveChallenge ? "Текущая рыба уйдёт. " : ""}{usableCasts > 0 ? "Оставшиеся забросы закончатся. " : ""}Пойманная рыба останется на борту.</AlertDialog.Description>
        <div><AlertDialog.Cancel asChild><button type="button" className={styles.secondary}>Остаться</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className={styles.primary} data-fishing-action="confirm-return" disabled={disabled || suspended} onClick={event => { event.preventDefault(); finishReturn(); }}>Вернуться</button></AlertDialog.Action></div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </section>;
}
