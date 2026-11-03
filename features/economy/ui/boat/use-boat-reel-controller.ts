"use client";

import { useEffect, useRef, useState } from "react";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, stepBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointKey, boatReelSubmission, changeBoatReelInput, readBoatReelCheckpoint, retainBoatReelCheckpoint, writeBoatReelCheckpoint } from "./boat-reel-checkpoint";

export type BoatReelControllerProps = { owner: string; voyageId: string; challenge: BoatChallenge; now: number;
  disabled: boolean; uncertain?: boolean; onSubmit: (submission: BoatReelCommand) => boolean };
// Input drafts belong to this tab. A second tab must not overwrite an in-progress trace.
const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** Owns one immutable attempt. The caller MUST key its component by owner + voyage + challenge id.
 * Repainting or replaying local controls never awards fish; the server confirms the submitted trace. */
export function useBoatReelController({ owner, voyageId, challenge: incomingChallenge, now, disabled, uncertain = false, onSubmit }: BoatReelControllerProps) {
  // A server attempt is immutable. Background snapshots must not reset its local controls.
  const [challenge] = useState(() => Object.freeze({ ...incomingChallenge }));
  const key = boatReelCheckpointKey(owner, voyageId, challenge.id);
  const [reel, setReel] = useState(() => initialBoatReel(challenge));
  const [playing, setPlaying] = useState(false), [held, setHeld] = useState(false), [ready, setReady] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false), [submitted, setSubmitted] = useState(false);
  const runtime = useRef({ reel: initialBoatReel(challenge), inputs: [] as BoatReelInput[], held: false, playing: false, last: 0, remainder: 0, ready: false, expired: false });
  const current = useRef({ now, observedAt: 0 });
  const submission = useRef(false);
  const focusFrame = useRef<number | null>(null);
  const holdButton = useRef<HTMLButtonElement>(null), finishButton = useRef<HTMLButtonElement>(null);
  const waitingForConfirmation = disabled && (submitted || uncertain && reel.status !== "active");
  const expired = !waitingForConfirmation && (deadlineReached || now >= Date.parse(challenge.expiresAt));
  useEffect(() => { current.current = { now, observedAt: performance.now() }; }, [now]);
  useEffect(() => {
    if (!disabled && !uncertain && submission.current) {
      // A fast refusal can batch away the busy frame. An idle commit must remain retryable.
      submission.current = false; setSubmitted(false);
    }
  }, [disabled, uncertain, submitted]);
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
      if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
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
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
    data.playing = !data.playing; data.last = 0; data.remainder = 0; data.held = false;
    changeBoatReelInput(data.inputs, data.reel.tick, false);
    setPlaying(data.playing); setHeld(false);
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs);
    if (data.playing) focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null; if (data.playing) holdButton.current?.focus();
    });
  };
  const submit = () => {
    const data = runtime.current;
    const currentTime = current.current.now + Math.max(0, performance.now() - current.current.observedAt);
    if (submission.current || disabled || uncertain || expired || data.expired || currentTime >= Date.parse(challenge.expiresAt) || data.reel.status === "active") return;
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs);
    // Claim the local receipt before dispatch: another event can still hold this render's handler.
    submission.current = true;
    try {
      const accepted = onSubmit(boatReelSubmission(challenge, data.reel, data.inputs));
      submission.current = accepted; setSubmitted(accepted);
    } catch (error) {
      submission.current = false; throw error;
    }
  };
  const status = waitingForConfirmation ? "Проверяем результат" : expired ? "Рыба ушла" : reel.status === "caught" ? "Рыба у борта!" : reel.status === "escaped" ? "Рыба сорвалась" : playing ? "Удерживайте рыбу в зелёной зоне" : reel.tick ? "Вываживание на паузе" : "Есть поклёвка!";
  const seconds = expired ? 0 : Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000));
  return { challenge, reel, playing, held, ready, expired, waitingForConfirmation, seconds, status,
    holdButton, finishButton, changeHeld, togglePlay, submit };
}
