"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BOAT_HOOK_WINDOW_MS } from "@/features/economy/domain/boat-model";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, stepBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointKey, boatReelSubmission, changeBoatReelInput, readBoatReelCheckpoint, retainBoatReelCheckpoint, writeBoatReelCheckpoint } from "./boat-reel-checkpoint";
import { boatCastStage } from "./boat-cast-timing";

export type BoatReelControllerProps = { owner: string; voyageId: string; challenge: BoatChallenge; now: number; suspended?: boolean;
  disabled: boolean; queued?: boolean; uncertain?: boolean; error?: string | null; onSubmit: (submission: BoatReelCommand) => boolean };
// Input drafts belong to this tab. The completed submission has its own durable outbox.
const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** A keyed attempt owns one fixed-step input trace, regardless of display refresh rate. */
export function useBoatReelController({ owner, voyageId, challenge: incomingChallenge, now, disabled, suspended = false, queued = false, uncertain = false, error, onSubmit }: BoatReelControllerProps) {
  const [challenge] = useState(() => Object.freeze({ ...incomingChallenge }));
  const key = boatReelCheckpointKey(owner, voyageId, challenge.id);
  const [reel, setReel] = useState(() => initialBoatReel(challenge));
  const [playing, setPlaying] = useState(false), [held, setHeld] = useState(false), [ready, setReady] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false), [started, setStarted] = useState(false);
  const [missedBite, setMissedBite] = useState(false);
  const manualHook = challenge.rulesVersion >= 6;
  const biteAt = Date.parse(challenge.biteAt ?? challenge.startedAt);
  const [delivery, setDelivery] = useState<"idle" | "sent" | "retry">("idle");
  const [castStage, setCastStage] = useState(() => boatCastStage(challenge, now));
  const runtime = useRef({ reel: initialBoatReel(challenge), inputs: [] as BoatReelInput[], held: false, playing: false, started: false, missed: false,
    last: 0, remainder: 0, ready: false, expired: false });
  const current = useRef({ now, observedAt: 0 });
  const blocked = disabled || queued || uncertain || suspended;
  const gates = useRef({ blocked, suspended });
  const submission = useRef(false);
  const holdButton = useRef<HTMLButtonElement>(null);
  // A definitive response can arrive without a rendered busy frame. Keep its retry available
  // even when a later, unrelated server notice clears the error.
  if (delivery === "sent" && error && !disabled && !queued && !uncertain) setDelivery("retry");
  const waitingForConfirmation = queued || delivery === "sent" || uncertain && reel.status !== "active";
  const expired = !waitingForConfirmation && (deadlineReached || now >= Date.parse(challenge.expiresAt));
  useEffect(() => { current.current = { now, observedAt: performance.now() }; }, [now]);
  const pause = useCallback(() => {
    const data = runtime.current;
    data.playing = false; data.held = false; data.last = 0; data.remainder = 0;
    if (data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
    setPlaying(false); setHeld(false);
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.started);
  }, [key, challenge]);
  useEffect(() => {
    gates.current = { blocked, suspended };
    if (suspended && runtime.current.playing) pause();
  }, [blocked, suspended, pause]);
  useEffect(() => { if (playing && !suspended) holdButton.current?.focus({ preventScroll: true }); }, [playing, suspended]);

  useEffect(() => {
    const data = runtime.current;
    retainBoatReelCheckpoint(storage(), owner, key);
    const restored = readBoatReelCheckpoint(storage(), key, challenge);
    data.reel = restored.reel; data.inputs = restored.inputs; data.held = false; data.playing = false; data.started = restored.reel.tick > 0 || Boolean(restored.hooked);
    setStarted(data.started);
    data.last = 0; data.remainder = 0; data.ready = true; data.expired = false;
    if (data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
    let frame = 0, publishedTick = -1, publishedStage = boatCastStage(challenge, current.current.now);
    let focused = document.hasFocus?.() ?? true;
    const save = () => writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.started);
    const blur = () => { focused = false; pause(); };
    const focus = () => { focused = true; };
    const visibility = () => { if (document.hidden) pause(); };
    const update = (time: number) => {
      const currentTime = current.current.now + Math.max(0, time - current.current.observedAt);
      const nextStage = boatCastStage(challenge, currentTime);
      if (nextStage !== publishedStage) { publishedStage = nextStage; setCastStage(nextStage); }
      if (!data.expired && currentTime >= Date.parse(challenge.expiresAt)) {
        data.expired = true; setDeadlineReached(true); pause();
      }
      if (!data.started && !data.expired && data.reel.status === "active" && nextStage === "bite") {
        if (manualHook && currentTime >= biteAt + BOAT_HOOK_WINDOW_MS) {
          data.missed = true; setMissedBite(true);
        } else if (!manualHook && !gates.current.blocked && focused && !document.hidden) {
          data.started = true; data.playing = true; data.last = time; setStarted(true); setPlaying(true);
        }
      }
      if (data.playing) {
        // Discard time spent backgrounded, in a dialog, or on a suspended frame.
        const elapsed = data.last ? time - data.last : 0;
        if (elapsed > 500 || gates.current.suspended || document.hidden) pause();
        else {
          data.remainder += elapsed;
          while (data.remainder >= challenge.tickMs && data.reel.status === "active") {
            data.reel = stepBoatReel(challenge, data.reel, data.held);
            data.remainder -= challenge.tickMs;
          }
          if (data.reel.status !== "active") pause();
        }
      }
      data.last = time;
      if (publishedTick !== data.reel.tick) {
        publishedTick = data.reel.tick; setReel(data.reel); setReady(true);
        if (data.reel.tick % 20 === 0) save();
      }
      if (!data.expired && !data.missed && data.reel.status === "active") frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    window.addEventListener("blur", blur); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame); pause(); window.removeEventListener("blur", blur); window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key, challenge, owner, pause, biteAt, manualHook]);

  const hookFish = () => {
    const data = runtime.current;
    const time = performance.now(), currentTime = current.current.now + Math.max(0, time - current.current.observedAt);
    if (!manualHook || !data.ready || data.started || data.missed || data.expired || expired || blocked || document.hidden
      || currentTime < biteAt || currentTime >= Math.min(biteAt + BOAT_HOOK_WINDOW_MS, Date.parse(challenge.expiresAt))) return;
    data.started = true; data.playing = true; data.last = time;
    setStarted(true); setPlaying(true);
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, true);
  };
  const changeHeld = (next: boolean) => {
    const data = runtime.current;
    if (!data.ready || !data.playing || gates.current.suspended || data.expired || expired || data.reel.status !== "active") return;
    changeBoatReelInput(data.inputs, data.reel.tick, next); data.held = next; setHeld(next);
  };
  const togglePlay = () => {
    const data = runtime.current;
    const currentTime = current.current.now + Math.max(0, performance.now() - current.current.observedAt);
    if (!ready || !data.started || data.expired || expired || data.reel.status !== "active" || currentTime >= Date.parse(challenge.expiresAt)) return;
    if (!data.playing && (blocked || document.hidden)) return;
    data.playing = !data.playing; data.last = performance.now(); data.remainder = 0; data.held = false;
    changeBoatReelInput(data.inputs, data.reel.tick, false);
    setPlaying(data.playing); setHeld(false);
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.started);
  };
  const submit = useCallback(() => {
    const data = runtime.current;
    const currentTime = current.current.now + Math.max(0, performance.now() - current.current.observedAt);
    if (submission.current || gates.current.blocked || !data.ready || data.expired || (!data.missed && data.reel.status === "active")) return;
    if (currentTime >= Date.parse(challenge.expiresAt)) {
      data.expired = true; setDeadlineReached(true); return;
    }
    // The guard also covers reentrant callbacks and Strict Mode's repeated effects.
    submission.current = true;
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.started);
    let accepted = false;
    try { accepted = onSubmit(data.missed ? { challengeId: challenge.id, endTick: 0, inputs: [], missedBite: true } : boatReelSubmission(challenge, data.reel, data.inputs)); }
    catch { /* The verified trace remains available for retry after a local transport failure. */ }
    submission.current = accepted; setDelivery(accepted ? "sent" : "retry");
  }, [challenge, key, onSubmit]);
  useEffect(() => {
    if (ready && (missedBite || reel.status !== "active") && delivery === "idle" && !blocked && !expired) submit();
  }, [ready, reel.status, missedBite, delivery, blocked, expired, submit]);
  useEffect(() => { if (delivery === "retry") submission.current = false; }, [delivery]);
  useEffect(() => {
    if (delivery !== "retry" || blocked || expired) return;
    window.addEventListener("online", submit);
    return () => window.removeEventListener("online", submit);
  }, [delivery, blocked, expired, submit]);
  const status = waitingForConfirmation ? "Проверяем результат" : expired ? "Рыба ушла" : missedBite ? "Поклёвка пропущена" : reel.status === "caught" ? "Рыба у борта!" : reel.status === "escaped" ? "Рыба сорвалась" : playing ? "Рыба на крючке" : started ? "Вываживание на паузе" : castStage === "casting" ? "Забрасываем удочку…" : castStage === "soaking" ? "Ждём поклёвку…" : "Есть поклёвка!";
  return { challenge, reel, playing, held, ready, paused: started && !playing, expired, waitingForConfirmation, retryNeeded: delivery === "retry", status, castStage,
    holdButton, changeHeld, togglePlay, submit, hookFish, missedBite, awaitingHook: manualHook && !started && !missedBite && castStage === "bite" };
}
