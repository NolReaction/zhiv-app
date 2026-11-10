"use client";

import { useEffect, useMemo, useRef } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
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
  const { reel, challenge, playing, held, ready, paused, expired, waitingForConfirmation, retryNeeded, togglePlay, changeHeld, submit,
    status, castStage, missedBite, missedElsewhere, confirmMiss, hookFish } = useBoatReelController({ ...props, suspended });
  const holdButton = useRef<HTMLButtonElement>(null);
  const resumeRequested = useRef(false);
  const input = useRef<string | number | null>(null);
  const blocked = !ready || suspended || props.disabled || waitingForConfirmation || expired || missedBite || missedElsewhere || reel.status !== "active";
  useEffect(() => { if (blocked || paused) input.current = null; }, [blocked, paused]);
  useEffect(() => {
    if (blocked || paused) return;
    if (playing && resumeRequested.current) {
      resumeRequested.current = false;
      holdButton.current?.focus({ preventScroll: true });
    } else focusBoatWaterIfIdle(holdButton.current);
  }, [blocked, paused, playing]);
  const stage: FishingSceneFrame["stage"] = waitingForConfirmation ? "pending" : expired ? "expired" : missedElsewhere ? "paused" : missedBite ? "escaped"
    : reel.status === "caught" ? "caught" : reel.status === "escaped" ? "escaped" : playing ? "reeling" : paused ? "paused" : castStage;
  const resistancePhase = boatReelResistancePhase(challenge, reel.tick);
  // Older attempts start automatically and still need one frame for the bite cue.
  const visualStage = waitingForConfirmation && reel.status !== "active" ? reel.status : playing && challenge.rulesVersion < 6 && reel.tick === 0 ? "bite" : stage;
  const visual = useMemo<BoatReelVisualState>(() => ({ challengeId: challenge.id, stage: visualStage, held, resistancePhase,
    reel: { bar: reel.bar, fish: reel.fish, progress: reel.progress, zoneWidth: challenge.zoneWidth, velocity: reel.velocity } }),
  [challenge.id, challenge.zoneWidth, visualStage, held, resistancePhase, reel.bar, reel.fish, reel.progress, reel.velocity]);
  useEffect(() => { onVisualState?.(visual); }, [onVisualState, visual]);
  useEffect(() => { onCoachObservation?.({ challengeId: challenge.id, stage, playing: playing && !suspended, held, tick: reel.tick, bar: reel.bar }); },
    [onCoachObservation, challenge.id, stage, playing, suspended, held, reel.tick, reel.bar]);
  const coachText = coachView ? boatCoachInstruction(coachView, stage) : null;
  const feedback = boatResistanceFeedback(resistancePhase, boatReelFeedback(reel, challenge.zoneWidth));
  const showMeter = !expired && !missedBite && !missedElsewhere && (playing || paused || reel.status !== "active");
  const begin = (source: string | number) => {
    if (blocked || paused || input.current !== null) return;
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
    : props.queued ? "Результат записан. Улов появится на борту после синхронизации."
    : "Проверяем улов. Рыба появится на борту после подтверждения."
    : expired ? "Время этого заброса истекло." : missedElsewhere ? "Время для подсечки прошло. Если вываживаете рыбу в другой вкладке, закончите попытку там."
    : missedBite ? "Рыба ушла." : reel.status === "caught" ? "Мохлик поднимает рыбу на борт…" : reel.status === "escaped" ? "Рыба сорвалась." : null;
  return <section className={gameStyles.attempt} data-boat-reel={challenge.id} data-reel-status={stage}
    data-reel-tick={reel.tick} data-reel-progress={reel.progress} aria-label="Вываживание рыбы">
    <span className={gameStyles.srOnly} role="status">{status}</span>
    {waterActive && <button type="button" ref={holdButton} className={waterStyles.surface}
      data-fishing-action={playing ? "hold" : "line"} aria-pressed={playing ? held : undefined}
      aria-label="Вода. Подсечка и вываживание" aria-keyshortcuts="Space Enter ArrowUp" disabled={blocked || paused}
      onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || blocked || paused || input.current !== null) return;
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
        if (event.detail !== 0 || blocked || paused || input.current !== null) return;
        if (playing) changeHeld(!held); else hookFish();
      }} />}
    {showMeter && <div className={gameStyles.instrument}>
      <BoatReelMeter reel={{ bar: reel.bar, fish: reel.fish, zoneWidth: challenge.zoneWidth }} held={held} paused={!playing || suspended} tickMs={challenge.tickMs} danger={feedback.urgent} />
      <div className={gameStyles.readout}>
        <div className={gameStyles.distance}><span>К борту</span><strong>{Math.floor(reel.progress / 100)}%</strong></div>
        <BoatReelProgress value={reel.progress} danger={feedback.urgent} playing={playing && !suspended} />
        {playing && feedback.phaseLabel && <small className={resistanceStyles.phase} data-resistance-phase={resistancePhase}>{feedback.phaseLabel}</small>}
        {waterActive && (playing ? <button type="button" className={gameStyles.toggle} data-fishing-action="pause" onClick={togglePlay} disabled={suspended} aria-label="Пауза"><Pause size={15} /></button>
          : paused && <button type="button" className={gameStyles.toggle} data-fishing-action="play" disabled={blocked} onClick={() => { resumeRequested.current = true; togglePlay(); }}><Play size={14} />Продолжить</button>)}
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
