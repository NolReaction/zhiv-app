"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Fish, Pause, Play, Send } from "lucide-react";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, stepBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointKey, boatReelSubmission, changeBoatReelInput, readBoatReelCheckpoint, retainBoatReelCheckpoint, writeBoatReelCheckpoint } from "./boat-reel-checkpoint";
import styles from "./boat-fishing.module.css";

type Props = { owner: string; voyageId: string; challenge: BoatChallenge; now: number; disabled: boolean; uncertain?: boolean; onSubmit: (submission: BoatReelCommand) => boolean };
// Input drafts belong to this tab. A second tab must not overwrite an in-progress trace.
const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** Rendering and input sampling never award fish. Only the confirmed server result does. */
export function BoatReelGame(props: Props) {
  return <BoatReelSession key={`${props.owner}.${props.voyageId}.${props.challenge.id}`} {...props} />;
}

function BoatReelSession({ owner, voyageId, challenge: incomingChallenge, now, disabled, uncertain = false, onSubmit }: Props) {
  // A server attempt is immutable. Background snapshots must not reset its local controls.
  const [challenge] = useState(incomingChallenge);
  const key = boatReelCheckpointKey(owner, voyageId, challenge.id);
  const [reel, setReel] = useState(() => initialBoatReel(challenge));
  const [playing, setPlaying] = useState(false), [held, setHeld] = useState(false), [ready, setReady] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false), [submitted, setSubmitted] = useState(false);
  const runtime = useRef({ reel: initialBoatReel(challenge), inputs: [] as BoatReelInput[], held: false, playing: false, last: 0, remainder: 0, ready: false, expired: false });
  const current = useRef({ now, observedAt: 0 });
  const holdButton = useRef<HTMLButtonElement>(null), finishButton = useRef<HTMLButtonElement>(null);
  const waitingForConfirmation = disabled && (submitted || uncertain && reel.status !== "active");
  const expired = !waitingForConfirmation && (deadlineReached || now >= Date.parse(challenge.expiresAt));
  useEffect(() => { current.current = { now, observedAt: performance.now() }; }, [now]);
  useEffect(() => { if (reel.status !== "active" && !expired && !waitingForConfirmation) finishButton.current?.focus(); }, [reel.status, expired, waitingForConfirmation]);

  useEffect(() => {
    const data = runtime.current;
    retainBoatReelCheckpoint(storage(), owner, key);
    const restored = readBoatReelCheckpoint(storage(), key, challenge);
    data.reel = restored.reel; data.inputs = restored.inputs; data.held = false; data.playing = false;
    data.last = 0; data.remainder = 0; data.ready = true; data.expired = false;
    if (data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
    let frame = 0, publishedTick = -1;
    const save = () => writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs);
    const pause = () => {
      data.playing = false; data.held = false; data.last = 0; data.remainder = 0;
      if (data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
      setPlaying(false); setHeld(false); save();
    };
    const visibility = () => { if (document.hidden) pause(); };
    const update = (time: number) => {
      const currentTime = current.current.now + Math.max(0, time - current.current.observedAt);
      if (!data.expired && currentTime >= Date.parse(challenge.expiresAt)) {
        data.expired = true; setDeadlineReached(true); pause();
      }
      if (data.playing && !data.expired) {
        // Long suspended frames pause instead of inventing missed player inputs.
        const elapsed = data.last ? time - data.last : 0;
        if (elapsed > 500) pause();
        else {
          data.remainder += elapsed;
          while (data.remainder >= challenge.tickMs && data.reel.status === "active") {
            data.reel = stepBoatReel(challenge, data.reel, data.held);
            data.remainder -= challenge.tickMs;
          }
          if (data.reel.status !== "active") pause();
        }
      } else if (data.playing) pause();
      data.last = time;
      if (publishedTick !== data.reel.tick) {
        publishedTick = data.reel.tick; setReel(data.reel); setReady(true);
        if (data.reel.tick % 20 === 0) save();
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    window.addEventListener("blur", pause); document.addEventListener("visibilitychange", visibility);
    return () => { cancelAnimationFrame(frame); pause(); window.removeEventListener("blur", pause); document.removeEventListener("visibilitychange", visibility); };
  }, [key, challenge, owner]);

  const changeHeld = (next: boolean) => {
    const data = runtime.current;
    if (!data.ready || !data.playing || data.expired || expired || data.reel.status !== "active") return;
    changeBoatReelInput(data.inputs, data.reel.tick, next); data.held = next; setHeld(next);
  };
  const togglePlay = () => {
    const data = runtime.current;
    if (!ready || data.expired || expired || data.reel.status !== "active") return;
    data.playing = !data.playing; data.last = 0; data.remainder = 0; data.held = false;
    changeBoatReelInput(data.inputs, data.reel.tick, false);
    setPlaying(data.playing); setHeld(false);
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs);
    if (data.playing) requestAnimationFrame(() => holdButton.current?.focus());
  };
  const submit = () => {
    const data = runtime.current;
    const currentTime = current.current.now + Math.max(0, performance.now() - current.current.observedAt);
    if (disabled || expired || data.expired || currentTime >= Date.parse(challenge.expiresAt) || data.reel.status === "active") return;
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs);
    setSubmitted(onSubmit(boatReelSubmission(challenge, data.reel, data.inputs)));
  };
  const status = waitingForConfirmation ? "Проверяем результат" : expired ? "Рыба ушла" : reel.status === "caught" ? "Рыба у борта!" : reel.status === "escaped" ? "Рыба сорвалась" : playing ? "Удерживайте рыбу в зелёной зоне" : reel.tick ? "Вываживание на паузе" : "Есть поклёвка!";
  const seconds = expired ? 0 : Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000));
  return <section className={styles.game} data-boat-reel={challenge.id} data-reel-status={waitingForConfirmation ? "pending" : expired ? "expired" : reel.status} aria-label="Вываживание рыбы">
    <div className={styles.gameHeader}><strong role="status">{status}</strong><span>{seconds} с</span></div>
    {!expired && <><div className={styles.gameStage} aria-hidden="true">
      <div className={styles.gameWater}><Fish /><p>{expired ? "Этот заброс завершён. Можно попробовать следующий." : reel.status === "caught" ? "Осталось поднять улов на борт." : reel.status === "escaped" ? "Следующая поклёвка ещё впереди." : "Зажмите, чтобы поднять зону. Отпустите, чтобы опустить."}</p></div>
      <div className={styles.reelTrack}><span className={styles.reelZone} style={{ bottom: `${(reel.bar - challenge.zoneWidth / 2) / 100}%`, height: `${challenge.zoneWidth / 100}%` }} /><span className={styles.reelFish} style={{ bottom: `${reel.fish / 100}%` }}><Fish size={35} /></span></div>
    </div>
    <div className={styles.gameProgress}><span>У берега</span><progress className={styles.progress} value={reel.progress} max={10000} aria-label="Рыба на крючке" /><span>У борта</span></div></>}
    {waitingForConfirmation ? <p className={styles.note} role="status">Улов появится на борту после подтверждения.</p> : !expired && reel.status === "active" ? <>
      <div className={styles.reelControls}>{playing ? <>
      <button ref={holdButton} type="button" className={`${styles.primary} ${styles.hold}`} aria-pressed={held} disabled={!ready || !playing}
        onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
        onPointerDown={event => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); changeHeld(true); }}
        onPointerUp={event => { event.preventDefault(); changeHeld(false); }} onPointerCancel={() => changeHeld(false)} onLostPointerCapture={() => changeHeld(false)}
        onKeyDown={event => { if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) changeHeld(true); } }}
        onKeyUp={event => { if ([" ", "ArrowUp", "Enter"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); changeHeld(false); } }} onBlur={() => changeHeld(false)}><ArrowUp size={18} />{held ? "Поднимаем" : "Удерживать"}</button>
      <button type="button" className={styles.secondary} onClick={togglePlay} aria-label="Пауза"><Pause size={18} /></button>
      </> : <button type="button" className={`${styles.primary} ${styles.hold}`} disabled={!ready} onClick={togglePlay}><Play size={17} />{reel.tick ? "Продолжить" : "Начать вываживание"}</button>}</div>
      <p className={styles.gameHint}>Мышь, касание или пробел. Рыба ждёт не дольше двух минут.</p>
    </> : !expired ? <button ref={finishButton} type="button" className={styles.primary} disabled={disabled} onClick={submit}><Send size={16} />{reel.status === "caught" ? "Поднять на борт" : "Продолжить рыбалку"}</button> : <p className={styles.note}>Время этого заброса истекло. Оставшиеся забросы сохранены.</p>}
  </section>;
}
