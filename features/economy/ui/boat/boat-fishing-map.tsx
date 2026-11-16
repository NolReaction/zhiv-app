"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";
import { ArrowLeft, BookOpen, CircleHelp, Clock3, Fish, FishingRod, Sailboat, X } from "lucide-react";
import type { BoatChallenge } from "@/features/economy/domain/boat-model";
import { boatConfig, boatModules, boatState } from "@/features/economy/domain/boat-fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { createBoatCastCheckpoint } from "./boat-cast-checkpoint";
import { BoatCastControl } from "./boat-cast-control";
import castStyles from "./boat-cast-control.module.css";
import { BoatCountdown } from "./boat-countdown";
import { BoatDevControls } from "@/features/economy/dev/boat-dev-controls";
import { BOAT_CAST_RESULT_MS, boatCastStage } from "./boat-cast-timing";
import { BoatCatchList } from "./boat-panels";
import { BoatCatchCard, BoatLocalCatchCard } from "./boat-catch-card";
import { BoatFishingCompletion } from "./boat-fishing-completion";
import { createBoatTripReceipt } from "./boat-trip-summary-data";
import { BoatFishingAlbum } from "./boat-fishing-album";
import { boatCatchPresentation, boatCatchSize } from "./boat-catch-presentation";
import { BoatReelGame, type BoatReelVisualState } from "./boat-reel-game";
import { FishingSceneCanvas } from "./scene/fishing-scene-canvas";
import { useBoatFishingCoach } from "./use-boat-fishing-coach";
import { BoatFishingCourse } from "./boat-fishing-course";
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
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog);
  const serverVoyage = boat.voyage!, voyage = economy.localBoatVoyage ?? serverVoyage;
  const challenge = voyage.challenge;
  const coach = useBoatFishingCoach(state.ownerPublicId);
  const [stageSample, setStageSample] = useState<Pick<BoatReelVisualState, "challengeId" | "stage"> | null>(null);
  const [recentLanding, setRecentLanding] = useState<{ index: number; at: number; preview?: BoatChallenge["landingPreview"]; rarity?: BoatChallenge["fishRarity"] } | null>(() => {
    const issued = serverVoyage.challenge;
    return issued && economy.pendingBoatCastId === issued.id && economy.pendingBoatOutcome === "caught"
      ? { index: serverVoyage.castsUsed - 1, at: economy.now, preview: issued.landingPreview, rarity: issued.fishRarity } : null;
  });
  const [feed] = useState(createRiverFeed);
  const [castAim] = useState(() => createBoatCastCheckpoint(state.ownerPublicId, voyage.id));
  const castPower = castAim.power(voyage.castsUsed, challenge?.id);
  useEffect(() => { castAim.confirm(voyage.castsUsed, challenge?.id); }, [castAim, voyage.castsUsed, challenge?.id]);
  const [aiming, setAiming] = useState(false);
  const [releasedCast, setReleasedCast] = useState<{ voyageId: string; number: number; quality: number; dock?: string } | null>(null);
  useEffect(() => {
    if (!releasedCast) return;
    const timeout = setTimeout(() => setReleasedCast(current => current === releasedCast ? null : current), BOAT_CAST_RESULT_MS);
    return () => clearTimeout(timeout);
  }, [releasedCast]);
  const [showHints, setShowHints] = useState(false);
  const [courseForCast, setCourseForCast] = useState<number | null>(null);
  const river = useRef<HTMLElement>(null);
  const waterSurface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const water = waterSurface.current;
    if (!water) return;
    // WebKit opens its edit menu from native touchstart, even when pointerdown
    // canceled selection. Keep this listener alive while a held reel resolves.
    const preventCallout = (event: Event) => {
      const target = event.target as Element;
      if (!target.closest?.("button:not([data-boat-water-control])")) event.preventDefault();
    };
    const events = ["touchstart", "touchend", "contextmenu", "selectstart"] as const;
    for (const type of events) water.addEventListener(type, preventCallout, { capture: true, passive: false });
    return () => {
      for (const type of events) water.removeEventListener(type, preventCallout, true);
    };
  }, []);
  const [missedCast, setMissedCast] = useState<string | null>(null);
  const [showAlbum, setShowAlbum] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false), [showCatch, setShowCatch] = useState(false), [showDev, setShowDev] = useState(false);
  const covered = suspended || showCatch || showDev || showAlbum || confirmReturn;
  const publishVisual = useCallback((next: BoatReelVisualState) => {
    if (feed.publish(next)) {
      setStageSample({ challengeId: next.challengeId, stage: next.stage });
    }
  }, [feed, setStageSample]);
  const remaining = Math.max(0, voyage.maxCasts - voyage.castsUsed);
  const queued = Boolean(challenge && economy.pendingBoatCastId === challenge.id);
  const expired = challenge && !queued && economy.now >= Date.parse(challenge.expiresAt)
    && stageSample?.challengeId === challenge.id && stageSample.stage === "expired";
  const liveChallenge = Boolean(challenge && !expired);
  const full = voyage.catches.length >= voyage.maxCatches;
  const usableCasts = full ? 0 : remaining;
  // Keep the same cast control across this landing's ACK. A foreign result, an
  // uncertain delivery or a different revision replaces it and drops the gesture.
  const confirmedLanding = economy.lastBoatLanding?.revision === state.revision ? economy.lastBoatLanding.challengeId : undefined;
  const localStage = stageSample?.challengeId === challenge?.id ? stageSample?.stage : undefined;
  const landedStage = missedCast && missedCast === challenge?.id ? "escaped"
    : localStage === "caught" || localStage === "escaped" ? localStage : undefined;
  const serverChallenge = serverVoyage.challenge;
  const sameCast = challenge?.id === serverChallenge?.id;
  const recordedCatch = Boolean(serverChallenge && economy.pendingBoatCastId === serverChallenge.id && economy.pendingBoatOutcome === "caught");
  const localCatch = Boolean(challenge && landedStage === "caught" && !expired && !economy.error);
  const preparedCount = economy.localBoatCatches ?? 0;
  const pendingCount = preparedCount + Number(recordedCatch) + Number(localCatch && !(recordedCatch && sameCast));
  const displayedCount = Math.min(voyage.maxCatches, serverVoyage.catches.length + pendingCount);
  const pendingLanding = economy.busy && !economy.uncertain && !economy.error && economy.directActionsAvailable !== false
    && economy.snapshotConfirmed && (queued && (voyage.catches.length + 1 < voyage.maxCatches || landedStage === "escaped") || !challenge)
    ? economy.pendingBoatCastId : undefined;
  const followup = pendingLanding ?? (!challenge ? confirmedLanding : undefined);
  const preparedCast = economy.preparedBoatCastAvailable === true;
  const preparedFight = Boolean(challenge && economy.preparedBoatChallengeId === challenge.id);
  const awaitingLanding = !preparedCast && Boolean(pendingLanding || !challenge && confirmedLanding && economy.busy && !economy.syncPending);
  const completed = !liveChallenge && usableCasts === 0 && pendingCount === 0 && !economy.preparedBoatPending;
  const canStudy = !liveChallenge && !disabled && !covered && !aiming && !releasedCast && !completed;
  const courseOpen = canStudy && courseForCast === voyage.castsUsed;
  const controlsSuspended = covered || courseOpen;
  const offerCourse = coach.offerCourse;
  useEffect(() => {
    if (!canStudy || voyage.castsUsed !== 0) return;
    const frame = requestAnimationFrame(() => {
      if (offerCourse()) setCourseForCast(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [canStudy, voyage.castsUsed, offerCourse]);
  const lastCatch = voyage.catches.at(-1);
  const lastPresentation = lastCatch ? boatCatchPresentation(state, lastCatch) : undefined;
  const lastIndex = voyage.castsUsed - 1;
  const recent = recentLanding?.index === lastIndex ? recentLanding : null;
  const effectiveCaughtAt = recent && lastCatch?.castIndex === recent.index && recent.preview ? recent.at : lastCatch ? Date.parse(lastCatch.caughtAt) : 0;
  const landed = !challenge && lastCatch && lastCatch.castIndex === lastIndex && economy.now >= effectiveCaughtAt && economy.now - effectiveCaughtAt < (lastPresentation?.revealMs ?? 3500) ? lastCatch : undefined;
  const showLocal = !landed && !economy.error && (localCatch || recordedCatch && serverVoyage.castsUsed === voyage.castsUsed || preparedCount > 0 && recent)
    && (!recent || economy.now - recent.at < 3500);
  const caughtChallenge = localCatch ? challenge : recordedCatch && serverVoyage.castsUsed === voyage.castsUsed ? serverChallenge : undefined;
  const localPreview = caughtChallenge?.landingPreview ?? recent?.preview;

  const ownRelease = releasedCast?.voyageId === voyage.id && releasedCast.number === voyage.castsUsed + (liveChallenge ? 0 : 1) ? releasedCast : null;
  const revealVisible = !aiming && (!ownRelease || localCatch || recordedCatch && sameCast);
  const shownFish = revealVisible ? landed ?? (showLocal ? localPreview : undefined) : undefined;
  const fishRarity = shownFish ? state.catalog.fishing?.fish.find(fish => fish.itemId === shownFish.fishId)?.rarity : undefined;
  const sizeScale = shownFish ? boatCatchSize(shownFish.weightGrams, config.weights[shownFish.fishId]).sizeScale : undefined;
  const stage = shownFish ? "landed" : challenge ? queued ? landedStage ?? "pending" : expired ? "expired" : localStage ?? boatCastStage(challenge, economy.now) : "waiting";
  const localDisabled = suspended || !preparedFight && (economy.busy || economy.uncertain || (economy.pendingProductionCount ?? 0) > 0);
  const frame = useMemo<FishingSceneFrame>(() => ({ stage, castPower, aiming: aiming && !controlsSuspended, sceneKey: voyage.id, castKey: challenge?.id, resistance: challenge?.resistance,
    ambience: { now: economy.now, timeZone }, biteLeadSeconds: challenge ? Math.max(0, (Date.parse(challenge.biteAt ?? challenge.startedAt) - economy.now) / 1000) : undefined,
    fishSizeScale: sizeScale, catchKey: shownFish ? `${state.ownerPublicId}.${voyage.id}.${lastIndex}` : undefined,
    fishRarity, fishId: shownFish?.fishId, held: false, boat: { repaired: true, upgrades: boat.upgrades, modules: boatModules(boat) }, rodId: voyage.loadout.rodId, appearance }),
  [stage, castPower, aiming, controlsSuspended, challenge, economy.now, timeZone, state.ownerPublicId, voyage.id, lastIndex, shownFish, sizeScale, fishRarity, boat, voyage.loadout.rodId, appearance]);
  const toggleHints = () => {
    if (canStudy) {
      offerCourse();
      setCourseForCast(voyage.castsUsed);
    } else {
      if (!showHints) coach.replay();
      setShowHints(!showHints);
    }
  };
  const closeCourse = (practice: boolean) => {
    if (practice) coach.replay();
    setShowHints(practice);
    setCourseForCast(null);
  };
  const returnLocked = disabled || suspended || Boolean(economy.preparedBoatPending);
  const finishReturn = () => { if (!returnLocked && send("return_boat", voyage.id)) setConfirmReturn(false); };
  const requestReturn = () => { if (!returnLocked) { if (completed) finishReturn(); else setConfirmReturn(true); } };
  return <section ref={river} className={styles.map} data-boat-map data-fishing-stage={frame.stage}
    data-water-input={!controlsSuspended && !completed || undefined} data-local-reveal={revealVisible && (showLocal || landed && recent?.preview) ? true : undefined} aria-label="Карта речной рыбалки">
    <RiverScene base={frame} owner={state.ownerPublicId} voyageId={voyage.id} count={displayedCount} feed={feed} suspended={controlsSuspended} />
    <header className={styles.header}><div className={styles.location}><span>РЕЧНАЯ РЫБАЛКА</span><h2>{config.name}</h2><small>{completed ? <><Sailboat size={13} />Можно возвращаться домой</> : <><Clock3 size={13} /><span className={styles.returnLabel}>До возвращения</span><BoatCountdown until={Date.parse(voyage.fishingUntil)} now={economy.now} readClock={economy.readServerNow} /></>}</small></div>
      <div className={styles.headerActions}><span className={styles.counter}><FishingRod size={16} />{remaining}<small>забросов</small></span><span className={styles.counter} data-pending-fish={pendingCount || undefined} aria-label={pendingCount ? `Улов: ${displayedCount}. Сохраняется: ${pendingCount}` : undefined}><Fish size={16} />{displayedCount} / {voyage.maxCatches}<small>на борту</small></span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть рыбалку и вернуться к поляне"><X size={22} /></button></div></header>
    <div className={styles.tools}><button type="button" className={styles.tool} onClick={() => setShowCatch(value => !value)} aria-expanded={showCatch}><Fish size={16} />Улов · {displayedCount}</button>
      <button type="button" className={styles.tool} data-fishing-action="album" onClick={() => setShowAlbum(true)} aria-haspopup="dialog"><BookOpen size={16} />Альбом рыбака</button>
      <button type="button" className={`${styles.tool} ${coachStyles.trigger}`} data-fishing-action="coach" onClick={toggleHints} aria-haspopup={canStudy ? "dialog" : undefined} aria-pressed={canStudy ? undefined : showHints} aria-label="Подсказки управления"><CircleHelp size={16} /><span>Подсказки</span></button>
      {process.env.NODE_ENV === "development" && economy.devAvailable && <button type="button" className={styles.tool} onClick={() => setShowDev(value => !value)} aria-expanded={showDev}>DEV</button>}</div>
    {showCatch && <aside className={styles.catchTray}><button type="button" className={styles.trayClose} onClick={() => setShowCatch(false)} aria-label="Закрыть улов"><X size={18} /></button><BoatCatchList state={state} boat={boat} />
      {pendingCount > 0 && <div data-pending-cargo>{pendingCount === 1 && recordedCatch && serverChallenge?.landingPreview
        ? <BoatLocalCatchCard state={state} preview={serverChallenge.landingPreview} /> : `Сохраняем пойманную рыбу · ${pendingCount}`}</div>}</aside>}
    {showDev && <aside className={styles.devTray}><button type="button" className={styles.trayClose} onClick={() => setShowDev(false)} aria-label="Закрыть DEV рыбалки"><X size={18} /></button><BoatDevControls economy={economy} compact /></aside>}
    {economy.error && !economy.pendingBoatCastId && <p className={styles.error} role="alert">{economy.error}</p>}
    {economy.uncertain && !economy.pendingBoatCastId && <div className={styles.recovery}><span>Проверяем последнее действие.</span><button type="button" disabled={economy.busy} onClick={() => economy.retry()}>Проверить результат</button></div>}
    <div className={styles.waterSurface} data-boat-water ref={waterSurface}>
      {challenge && <BoatReelGame owner={state.ownerPublicId} voyageId={voyage.id} challenge={challenge} ownCast={preparedFight || castAim.owns(voyage.castsUsed, challenge.id)} now={economy.now} readClock={economy.readServerNow} disabled={localDisabled}
        queued={queued} uncertain={!preparedFight && economy.uncertain} error={economy.error} coachView={showHints ? coach.view : undefined} onCoachObservation={showHints ? coach.observe : undefined}
        suspended={controlsSuspended} onVisualState={publishVisual} onSubmit={(reel, outcome) => {
          const sent = send("submit_boat_cast", voyage.id, { ...reel, deferred: true });
          if (sent && outcome === "caught") {
            const at = economy.readServerNow?.() ?? economy.now;
            setRecentLanding(previous => previous?.index === lastIndex ? previous : { index: lastIndex, at, preview: challenge.landingPreview, rarity: challenge.fishRarity });
          }
          if (sent && reel.missedBite) setMissedCast(reel.challengeId);
          return sent;
        }} />}
      {(!challenge || expired || pendingLanding || preparedCast && queued) && usableCasts > 0 && displayedCount < voyage.maxCatches && <BoatCastControl key={followup ?? voyage.castsUsed}
        voyageId={voyage.id} castNumber={voyage.castsUsed + 1} awaitingLanding={awaitingLanding}
        disabled={controlsSuspended || !preparedCast && (disabled && !awaitingLanding || Boolean(economy.preparedBoatPending))}
        onChargingChange={setAiming} onCast={(power, heldMs, quality, dock) => {
          if (send("begin_boat_cast", voyage.id, { castHeldMs: heldMs })) {
            castAim.release(voyage.castsUsed + 1, power);
            setReleasedCast({ voyageId: voyage.id, number: voyage.castsUsed + 1, quality, dock });
            setMissedCast(null);
          }
        }} />}
    </div>
    {ownRelease && !controlsSuspended && !aiming && !economy.error && (!liveChallenge || stage === "casting" || stage === "soaking") &&
      <span className={castStyles.meter} role="status" data-cast-result={ownRelease.quality} data-meter-dock={ownRelease.dock}>
        <span className={castStyles.caption}>Точность заброса <b>{ownRelease.quality}%</b></span>
      </span>}
    <div className={styles.bottom}>
      <div className={styles.controls} data-control-stage={frame.stage} data-fishing-finished={completed || undefined}>
        {revealVisible && (landed ? <BoatCatchCard state={state} caught={landed} /> : showLocal ? <BoatLocalCatchCard state={state} preview={localPreview} rarity={caughtChallenge?.fishRarity ?? recent?.rarity} /> : null)}
        {completed && <>
          {!landed && <BoatFishingCompletion receipt={createBoatTripReceipt(state, voyage)} full={full} onShowCatch={() => setShowCatch(true)} />}
          <button type="button" className={styles.primary} data-fishing-action="return" aria-label="Завершить рыбалку и вернуться домой" disabled={returnLocked} onClick={requestReturn}><Sailboat size={18} />Завершить и вернуться домой</button>
        </>}
        {!challenge && economy.preparedBoatPending && !preparedCast && !covered && !showLocal && <span className={styles.riverNotice} role="status">
          {displayedCount >= voyage.maxCatches ? "Ящик полон." : "Подготовленные забросы закончились."} Результат сохранён на устройстве. Можно вернуться к поляне.
        </span>}
        {!challenge && !completed && missedCast && <span className={styles.riverNotice} role="status">Рыба ушла</span>}
        {showHints && !aiming && !ownRelease && !coach.view.completed && !challenge && !completed && <p className={styles.riverHint} data-fishing-coach="cast">{boatCoachInstruction(coach.view, "waiting")}</p>}
        <div className={styles.bottomRow}><button type="button" className={styles.back} onClick={onClose}><ArrowLeft size={15} />К поляне</button><button type="button" className={`${styles.back} ${styles.albumShortcut}`} data-fishing-action="album-shortcut" onClick={() => setShowAlbum(true)} aria-haspopup="dialog"><BookOpen size={15} />Альбом</button><button type="button" className={`${styles.back} ${styles.coachShortcut}`} data-fishing-action="coach-shortcut" onClick={toggleHints} aria-haspopup={canStudy ? "dialog" : undefined} aria-pressed={canStudy ? undefined : showHints} aria-label="Подсказки управления"><CircleHelp size={15} /></button>{!completed && <button type="button" className={styles.back} data-fishing-action="return" disabled={returnLocked} onClick={requestReturn}>Вернуться с уловом</button>}</div>
      </div>
    </div>
    <BoatFishingCourse open={courseOpen} river={river} onClose={closeCourse} />
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
        <div><AlertDialog.Cancel asChild><button type="button" className={styles.secondary}>Остаться</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className={styles.primary} data-fishing-action="confirm-return" disabled={returnLocked} onClick={event => { event.preventDefault(); finishReturn(); }}>Вернуться</button></AlertDialog.Action></div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </section>;
}

function createRiverFeed() {
  let latest: BoatReelVisualState | null = null;
  let listener: ((sample: BoatReelVisualState) => void) | null = null;
  return {
    publish(next: BoatReelVisualState) {
      const stageChanged = latest?.challengeId !== next.challengeId || latest.stage !== next.stage;
      latest = next;
      listener?.(next);
      return stageChanged;
    },
    read: () => latest,
    subscribe(notify: (sample: BoatReelVisualState) => void) {
      listener = notify;
      if (latest) notify(latest);
      return () => { listener = null; };
    },
  };
}

/** Only the rendering/audio bridge subscribes at reel speed. Header, timers, overlays
 * and inventory stay on the normal snapshot clock throughout a pull. */
function RiverScene({ base, feed, owner, voyageId, count, suspended }: { base: FishingSceneFrame;
  feed: ReturnType<typeof createRiverFeed>;
  owner: string; voyageId: string; count: number; suspended: boolean }) {
  const [sample, setSample] = useState(feed.read);
  useEffect(() => feed.subscribe(setSample), [feed]);
  const visual = sample?.challengeId === base.castKey && base.stage !== "expired" ? sample : null;
  const frame = useMemo<FishingSceneFrame>(() => ({ ...base, held: visual?.held ?? false, resistancePhase: visual?.resistancePhase,
    reel: visual && !["casting", "soaking"].includes(visual.stage) ? visual.reel : undefined }), [base, visual]);
  useFishingAudio({ ownerPublicId: owner, voyageId, stage: frame.stage, castKey: frame.castKey, held: frame.held,
    progress: frame.reel?.progress ?? 0, inZone: Boolean(frame.reel && Math.abs(frame.reel.bar - frame.reel.fish) <= frame.reel.zoneWidth / 2),
    caughtCount: count, ambience: frame.ambience, suspended });
  return <FishingSceneCanvas frame={frame} className={styles.canvas} />;
}
