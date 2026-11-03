"use client";

import { useEffect, useMemo } from "react";
import { ArrowUp, Pause, Play, Send } from "lucide-react";
import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import { useBoatReelController, type BoatReelControllerProps } from "./use-boat-reel-controller";
import styles from "./boat-fishing-map.module.css";

export type BoatReelVisualState = { challengeId: string; stage: FishingSceneFrame["stage"]; held: boolean;
  reel: NonNullable<FishingSceneFrame["reel"]> };
type Props = BoatReelControllerProps & { onVisualState?: (frame: BoatReelVisualState) => void; suspended?: boolean };

/** Input and verified replay stay independent of the replaceable scene renderer. */
export function BoatReelGame(props: Props) {
  return <BoatReelSession key={`${props.owner}.${props.voyageId}.${props.challenge.id}`} {...props} />;
}

function BoatReelSession({ onVisualState, suspended = false, ...props }: Props) {
  const { reel, challenge, playing, held, ready, expired, waitingForConfirmation, togglePlay, changeHeld, submit,
    holdButton, finishButton, status, seconds } = useBoatReelController(props);
  useEffect(() => { if (suspended && playing) togglePlay(); }, [suspended, playing, togglePlay]);
  const stage: FishingSceneFrame["stage"] = waitingForConfirmation ? "pending" : expired ? "expired"
    : reel.status === "caught" ? "caught" : reel.status === "escaped" ? "escaped" : playing ? "reeling" : reel.tick ? "paused" : "bite";
  const visual = useMemo<BoatReelVisualState>(() => ({ challengeId: challenge.id, stage: waitingForConfirmation && reel.status !== "active" ? reel.status : stage, held,
    reel: { bar: reel.bar, fish: reel.fish, progress: reel.progress, zoneWidth: challenge.zoneWidth } }),
  [challenge.id, challenge.zoneWidth, stage, held, reel.status, waitingForConfirmation, reel.bar, reel.fish, reel.progress]);
  useEffect(() => { onVisualState?.(visual); }, [onVisualState, visual]);
  return <section className={styles.attempt} data-boat-reel={challenge.id} data-reel-status={stage}
    data-reel-tick={reel.tick} data-reel-progress={reel.progress} aria-label="Вываживание рыбы">
    <div className={styles.attemptHeading}><strong role="status">{status}</strong><span>{seconds} с</span></div>
    {!expired && <div className={styles.progressRow}><span>К лодке</span><progress value={reel.progress} max={10000} aria-label="Рыба на крючке" /><span>{Math.floor(reel.progress / 100)}%</span></div>}
    {waitingForConfirmation ? <p role="status">Проверяем улов. Рыба появится на борту после подтверждения.</p>
      : !expired && reel.status === "active" ? <>
        <div className={styles.reelControls}>{playing ? <>
          <button ref={holdButton} type="button" className={`${styles.primary} ${styles.hold}`} data-fishing-action="hold" aria-pressed={held} disabled={!ready}
            onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
            onPointerDown={event => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); changeHeld(true); }}
            onPointerUp={event => { if (!event.isPrimary) return; event.preventDefault(); changeHeld(false); }}
            onPointerCancel={() => changeHeld(false)} onLostPointerCapture={() => changeHeld(false)}
            onKeyDown={event => { if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
              if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) changeHeld(true); } }}
            onKeyUp={event => { if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); changeHeld(false); } }}
            onBlur={() => changeHeld(false)}><ArrowUp size={18} />{held ? "Тянем снасть" : "Удерживать"}</button>
          <button type="button" className={styles.secondary} data-fishing-action="pause" onClick={togglePlay} aria-label="Пауза"><Pause size={18} /></button>
        </> : <button type="button" className={`${styles.primary} ${styles.hold}`} data-fishing-action="play" disabled={!ready} onClick={togglePlay}><Play size={17} />{reel.tick ? "Продолжить" : "Начать вываживание"}</button>}</div>
        <p className={styles.hint}>Зажмите мышь, экран или пробел, чтобы поднять снасть. Отпустите, чтобы опустить.</p>
      </> : !expired ? <button ref={finishButton} type="button" className={styles.primary} data-fishing-action="submit" disabled={props.disabled} onClick={submit}><Send size={16} />{reel.status === "caught" ? "Поднять на борт" : "Продолжить рыбалку"}</button>
        : <p>Время этого заброса истекло. Оставшиеся забросы сохранены.</p>}
  </section>;
}
