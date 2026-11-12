"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import { useBoatReelController, type BoatReelControllerProps } from "./use-boat-reel-controller";
import { boatReelFeedback } from "./boat-reel-feedback";
import { boatReelResistancePhase } from "@/features/economy/domain/boat-reel";
import { boatResistanceFeedback } from "./boat-resistance-feedback";
import resistanceStyles from "./boat-resistance-feedback.module.css";
import { boatCoachInstruction, type BoatCoachView, type BoatCoachObservation } from "./boat-fishing-coach";
import { BoatReelProgress } from "./boat-reel-progress";
import { BoatReelMeter } from "./boat-reel-meter";
import styles from "./boat-fishing-map.module.css";
import gameStyles from "./boat-reel-game.module.css";
import waterStyles from "./boat-cast-control.module.css";
import { focusBoatWaterIfIdle } from "./boat-water-focus";

export type BoatReelVisualState = { challengeId: string; stage: FishingSceneFrame["stage"]; held: boolean;
  resistancePhase?: FishingSceneFrame["resistancePhase"];
  reel: NonNullable<FishingSceneFrame["reel"]> };
type Props = BoatReelControllerProps & { readClock?: () => number; coachView?: BoatCoachView; onCoachObservation?: (sample: BoatCoachObservation) => void; onVisualState?: (frame: BoatReelVisualState) => void; suspended?: boolean };

/** Input and verified replay stay independent of the replaceable scene renderer. */
export function BoatReelGame(props: Props) {
  return <BoatReelSession key={`${props.owner}.${props.voyageId}.${props.challenge.id}`} {...props} />;
}

function BoatReelSession({ onVisualState, suspended = false, coachView, onCoachObservation, ...props }: Props) {
  const { reel, challenge, playing, held, ready, expired, waitingForConfirmation, retryNeeded, changeHeld, submit,
    status, castStage, missedBite, missedElsewhere, confirmMiss, hookFish } = useBoatReelController({ ...props, suspended });
  const holdButton = useRef<HTMLButtonElement>(null);
  const input = useRef<string | number | null>(null);
  const blocked = !ready || suspended || waitingForConfirmation || expired || missedBite || missedElsewhere || reel.status !== "active";
  useEffect(() => {
    if (blocked) input.current = null;
    else focusBoatWaterIfIdle(holdButton.current);
  }, [blocked]);
  useEffect(() => {
    // A released touch or key in another tab will never send its up event to this button.
    const clearInput = () => { input.current = null; };
    const onVisibility = () => { if (document.hidden) clearInput(); };
    window.addEventListener("blur", clearInput);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", clearInput);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const stage: FishingSceneFrame["stage"] = !ready ? "pending" : waitingForConfirmation ? "pending" : expired || missedElsewhere ? "expired" : missedBite ? "escaped"
    : reel.status === "caught" ? "caught" : reel.status === "escaped" ? "escaped" : playing ? "reeling" : castStage;
  const resistancePhase = boatReelResistancePhase(challenge, reel.tick);
  // Older attempts start automatically and still need one frame for the bite cue.
  const visualStage = waitingForConfirmation && reel.status !== "active" ? reel.status : playing && challenge.rulesVersion < 6 && reel.tick === 0 ? "bite" : stage;
  const visual = useMemo<BoatReelVisualState>(() => ({ challengeId: challenge.id, stage: visualStage, held, resistancePhase,
    reel: { bar: reel.bar, fish: reel.fish, progress: reel.progress, zoneWidth: challenge.zoneWidth, velocity: reel.velocity } }),
  [challenge.id, challenge.zoneWidth, visualStage, held, resistancePhase, reel.bar, reel.fish, reel.progress, reel.velocity]);
  useEffect(() => { onVisualState?.(visual); }, [onVisualState, visual]);
  useEffect(() => {
    const canPractice = playing && !blocked && !document.hidden && (document.hasFocus?.() ?? true);
    onCoachObservation?.({ challengeId: challenge.id, stage, playing: canPractice, held, tick: reel.tick, bar: reel.bar });
  }, [onCoachObservation, challenge.id, stage, playing, blocked, held, reel.tick, reel.bar]);
  const coachText = coachView ? boatCoachInstruction(coachView, stage) : null;
  const feedback = boatResistanceFeedback(resistancePhase, boatReelFeedback(reel, challenge.zoneWidth));
  const showMeter = !expired && !missedBite && !missedElsewhere && (playing || reel.status !== "active");
  const begin = (source: string | number) => {
    if (blocked || input.current !== null) return;
    input.current = source;
    if (!playing) hookFish();
    changeHeld(true);
  };
  const end = (source: string | number | null) => {
    if (input.current !== source) return;
    input.current = null;
    changeHeld(false);
  };
  const waterActive = !expired && !missedBite && !missedElsewhere && !waitingForConfirmation && reel.status === "active";
  const deliveryMessage = waitingForConfirmation ? missedBite ? "Поклёвка пропущена. Сохраняем завершение попытки."
    : props.queued && props.uncertain ? "Результат записан. Улов появится на борту после синхронизации."
    : reel.status === "escaped" ? "Рыба сорвалась." : "Проверяем улов. Рыба появится на борту после подтверждения."
    : expired ? "Время этого заброса истекло." : missedElsewhere ? "Время для подсечки прошло. Если вываживаете рыбу в другой вкладке, закончите попытку там."
    : missedBite ? "Рыба ушла." : reel.status === "caught" ? "Мохлик поднимает рыбу на борт…" : reel.status === "escaped" ? "Рыба сорвалась." : null;
  return <section className={gameStyles.attempt} data-boat-reel={challenge.id} data-reel-status={stage}
    data-reel-tick={reel.tick} data-reel-progress={reel.progress} aria-label="Вываживание рыбы">
    <span className={gameStyles.srOnly} role="status">{status}</span>
    {waterActive && <button type="button" ref={holdButton} className={waterStyles.surface} data-boat-water-control
      data-fishing-action={playing ? "hold" : "line"} aria-pressed={playing ? held : undefined}
      aria-label={!playing ? "Вода. Подсечка и вываживание" : held ? "Ослабить снасть. Отпустите для спуска" : "Тянуть снасть. Удерживайте для подъёма"}
      aria-keyshortcuts="Space Enter ArrowUp" disabled={blocked}
      onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || blocked || input.current !== null) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        begin(event.pointerId);
      }}
      onPointerUp={event => end(event.pointerId)} onPointerCancel={event => end(event.pointerId)}
      onLostPointerCapture={event => end(event.pointerId)} onBlur={() => end(input.current)}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || ![" ", "Enter", "ArrowUp"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) begin(event.key);
      }}
      onKeyUp={event => {
        if (![" ", "Enter", "ArrowUp"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); end(event.key);
      }}
      onClick={event => {
        // Assistive switches may activate a button without sending pointer or key events.
        if (event.detail !== 0 || blocked || input.current !== null) return;
        if (playing) changeHeld(!held); else hookFish();
      }}>
      {playing && !blocked && <span className={waterStyles.actionCue} data-fishing-cue="reel" aria-hidden="true">
        {held ? <ArrowDown size={20} /> : <ArrowUp size={20} />}
        <span>{held ? "Ослабить снасть" : "Тянуть снасть"}<small>{held ? "Отпустите" : "Удерживайте"}</small></span>
      </span>}
    </button>}
    {showMeter && <div className={gameStyles.instrument}>
      <BoatReelMeter reel={{ bar: reel.bar, fish: reel.fish, zoneWidth: challenge.zoneWidth }} held={held} tickMs={challenge.tickMs} danger={feedback.urgent} />
      <div className={gameStyles.readout}>
        <div className={gameStyles.distance}><span>К борту</span><strong>{Math.floor(reel.progress / 100)}%</strong></div>
        <BoatReelProgress value={reel.progress} danger={feedback.urgent} playing={playing && !suspended} />
        {playing && feedback.phaseLabel && <small className={resistanceStyles.phase} data-resistance-phase={resistancePhase}>{feedback.phaseLabel}</small>}
      </div>
    </div>}
    {(deliveryMessage || coachText || retryNeeded || missedElsewhere) && <div className={gameStyles.message} data-with-meter={showMeter || undefined}>
      {deliveryMessage && <span role="status">{deliveryMessage}</span>}
      {coachText && waterActive && <span data-fishing-coach="control">{coachText}</span>}
      {!expired && missedElsewhere && <button type="button" className={styles.secondary} data-fishing-action="skip-bite"
        disabled={!ready || suspended || props.disabled} onClick={confirmMiss}>Завершить без улова</button>}
      {!expired && retryNeeded && <button type="button" className={styles.secondary} data-fishing-action="retry-landing"
        disabled={props.disabled || suspended} onClick={submit}><RotateCcw size={16} />Повторить отправку результата</button>}
    </div>}
  </section>;
}
