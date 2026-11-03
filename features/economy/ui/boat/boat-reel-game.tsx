"use client";

import { useEffect, useMemo } from "react";
import { ArrowDown, ArrowUp, Check, Pause, Play, Send } from "lucide-react";
import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import { useBoatReelController, type BoatReelControllerProps } from "./use-boat-reel-controller";
import { boatReelFeedback } from "./boat-reel-feedback";
import { boatReelResistancePhase } from "@/features/economy/domain/boat-reel";
import { boatResistanceFeedback } from "./boat-resistance-feedback";
import resistanceStyles from "./boat-resistance-feedback.module.css";
import { boatCoachInstruction, type BoatCoachView, type BoatCoachObservation } from "./boat-fishing-coach";
import coachStyles from "./boat-fishing-coach.module.css";
import { BoatReelProgress } from "./boat-reel-progress";
import { BoatReelMeter } from "./boat-reel-meter";
import styles from "./boat-fishing-map.module.css";
import gameStyles from "./boat-reel-game.module.css";

export type BoatReelVisualState = { challengeId: string; stage: FishingSceneFrame["stage"]; held: boolean;
  resistancePhase?: FishingSceneFrame["resistancePhase"];
  reel: NonNullable<FishingSceneFrame["reel"]> };
type Props = BoatReelControllerProps & { coachView?: BoatCoachView; onCoachObservation?: (sample: BoatCoachObservation) => void; onVisualState?: (frame: BoatReelVisualState) => void; suspended?: boolean };

/** Input and verified replay stay independent of the replaceable scene renderer. */
export function BoatReelGame(props: Props) {
  return <BoatReelSession key={`${props.owner}.${props.voyageId}.${props.challenge.id}`} {...props} />;
}

function BoatReelSession({ onVisualState, suspended = false, coachView, onCoachObservation, ...props }: Props) {
  const { reel, challenge, playing, held, ready, expired, waitingForConfirmation, togglePlay, changeHeld, submit,
    holdButton, finishButton, status, seconds, castStage } = useBoatReelController(props);
  useEffect(() => { if (suspended && playing) togglePlay(); }, [suspended, playing, togglePlay]);
  const stage: FishingSceneFrame["stage"] = waitingForConfirmation ? "pending" : expired ? "expired"
    : reel.status === "caught" ? "caught" : reel.status === "escaped" ? "escaped" : playing ? "reeling" : reel.tick ? "paused" : castStage;
  const resistancePhase = boatReelResistancePhase(challenge, reel.tick);
  const visual = useMemo<BoatReelVisualState>(() => ({ challengeId: challenge.id, stage: waitingForConfirmation && reel.status !== "active" ? reel.status : stage, held, resistancePhase,
    reel: { bar: reel.bar, fish: reel.fish, progress: reel.progress, zoneWidth: challenge.zoneWidth, velocity: reel.velocity } }),
  [challenge.id, challenge.zoneWidth, stage, held, resistancePhase, reel.status, waitingForConfirmation, reel.bar, reel.fish, reel.progress, reel.velocity]);
  useEffect(() => { onVisualState?.(visual); }, [onVisualState, visual]);
  useEffect(() => { onCoachObservation?.({ challengeId: challenge.id, stage, playing: playing && !suspended, held, tick: reel.tick, bar: reel.bar }); },
    [onCoachObservation, challenge.id, stage, playing, suspended, held, reel.tick, reel.bar]);
  const coachText = coachView ? boatCoachInstruction(coachView, stage, reel.tick) : null;
  const heading = playing ? "Рыба на крючке" : status;
  const feedback = boatResistanceFeedback(resistancePhase, boatReelFeedback(reel, challenge.zoneWidth));
  const controlCoachText = feedback.inZone && !feedback.urgent ? coachText : null;
  const FeedbackIcon = feedback.inZone ? Check : feedback.direction === "lift" ? ArrowUp : ArrowDown;
  const showMeter = !expired && castStage === "bite";
  const action = waitingForConfirmation ? <p role="status" className={gameStyles.instruction}>Проверяем улов. Рыба появится на борту после подтверждения.</p>
    : !expired && reel.status === "active" && castStage !== "bite" ? <p className={styles.waitingBite} role="status">{coachText ?? (castStage === "casting" ? "Поплавок летит к воде." : "Снасть в воде. Следите за поплавком — подсечка появится при поклёвке.")}</p>
    : !expired && reel.status === "active" ? <>
      {!playing && <p className={`${gameStyles.instruction} ${coachText ? coachStyles.prompt : ""}`} data-fishing-coach={coachText ? "strike" : undefined}>{coachText ?? "Держите метку рыбы в зелёной зоне. Зажмите — зона вверх, отпустите — вниз."}</p>}
      <div className={`${gameStyles.actions} ${!playing ? gameStyles.single : ""}`}>{playing ? <>
        <button ref={holdButton} type="button" className={`${styles.primary} ${styles.hold} ${gameStyles.input}`} data-fishing-action="hold" aria-pressed={held} aria-label="Удерживать снасть: зажмите — вверх, отпустите — вниз" disabled={!ready || suspended}
          onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
          onPointerDown={event => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); changeHeld(true); }}
          onPointerUp={event => { if (!event.isPrimary) return; event.preventDefault(); changeHeld(false); }}
          onPointerCancel={() => changeHeld(false)} onLostPointerCapture={() => changeHeld(false)}
          onKeyDown={event => { if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
            if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) changeHeld(true); } }}
          onKeyUp={event => { if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); changeHeld(false); } }}
          onBlur={() => changeHeld(false)}><span className={styles.holdGlyph} aria-hidden="true">{held ? <ArrowUp size={18} /> : <ArrowDown size={18} />}</span><span>{held ? "Тянем · вверх" : "Зажмите · вверх"}</span><span className={styles.holdTrail} aria-hidden="true"><i /><i /><i /></span></button>
        <button type="button" className={`${styles.secondary} ${gameStyles.pause}`} data-fishing-action="pause" onClick={togglePlay} disabled={suspended} aria-label="Пауза"><Pause size={18} /></button>
      </> : <button type="button" className={`${styles.primary} ${styles.hold} ${gameStyles.input}`} data-fishing-action="play" disabled={!ready || suspended} onClick={togglePlay}><Play size={17} />{reel.tick ? "Продолжить" : challenge.biteAt ? "Подсечь" : "Начать вываживание"}</button>}</div>
    </> : !expired ? <div className={gameStyles.terminal}><button ref={finishButton} type="button" className={styles.primary} data-fishing-action="submit" disabled={props.disabled} onClick={submit}><Send size={16} />{reel.status === "caught" ? "Поднять на борт" : "Продолжить рыбалку"}</button></div>
      : <p>Время этого заброса истекло. Оставшиеся забросы сохранены.</p>;
  return <section className={`${styles.attempt} ${gameStyles.attempt}`} data-boat-reel={challenge.id} data-reel-status={stage}
    data-reel-tick={reel.tick} data-reel-progress={reel.progress} aria-label="Вываживание рыбы">
    <div className={`${styles.attemptHeading} ${gameStyles.heading}`}><strong role="status"><span className={styles.phaseMark} data-phase={stage} aria-hidden="true"><span /></span>{heading}</strong><span className={resistanceStyles.clock}>{playing && feedback.phaseLabel && <span className={resistanceStyles.phase} data-resistance-phase={resistancePhase}>{feedback.phaseLabel}</span>}<span>{seconds} с</span></span></div>
    {showMeter ? <div className={gameStyles.body}>
      <BoatReelMeter reel={{ bar: reel.bar, fish: reel.fish, zoneWidth: challenge.zoneWidth }} held={held} paused={!playing || suspended} danger={feedback.urgent} />
      <div className={gameStyles.actionPanel}>
        <div className={gameStyles.progress} data-feedback={feedback.mood}><span>К борту</span><BoatReelProgress value={reel.progress} danger={feedback.urgent} playing={playing && !suspended} /><span>{Math.floor(reel.progress / 100)}%</span></div>
        {playing && !expired && <div className={gameStyles.feedback} data-feedback={feedback.mood}>
          <FeedbackIcon size={19} aria-hidden="true" /><strong>{feedback.title}</strong><span className={`${coachStyles.promptHost} ${controlCoachText ? coachStyles.prompt : ""}`} key={controlCoachText ?? "normal-feedback"} data-fishing-coach={controlCoachText ? "control" : undefined}>{controlCoachText ?? feedback.instruction}{coachView?.justCompleted && <i className={coachStyles.mastered} aria-hidden="true">Отлично! Управление освоено.</i>}</span>
        </div>}
        {action}
      </div>
    </div> : <div className={gameStyles.idle}>{action}</div>}
  </section>;
}
