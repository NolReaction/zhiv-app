"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BOAT_HOOK_WINDOW_MS } from "@/features/economy/domain/boat-model";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, stepBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointKey, boatReelSubmission, changeBoatReelInput, readBoatReelCheckpoint, retainBoatReelCheckpoint, writeBoatReelCheckpoint } from "./boat-reel-checkpoint";
import { boatCastStage } from "./boat-cast-timing";

export type BoatReelControllerProps = { owner: string; voyageId: string; challenge: BoatChallenge; now: number; readClock?: () => number; ownCast?: boolean; suspended?: boolean;
  disabled: boolean; queued?: boolean; uncertain?: boolean; error?: string | null; onSubmit: (submission: BoatReelCommand) => boolean };
// Input drafts belong to this tab. The completed submission has its own durable outbox.
const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** A keyed attempt owns one fixed-step input trace, regardless of display refresh rate. */
export function useBoatReelController({ owner, voyageId, challenge: incomingChallenge, now, readClock, ownCast = false, disabled, suspended = false, queued = false, uncertain = false, error, onSubmit }: BoatReelControllerProps) {
  const [challenge] = useState(() => Object.freeze({ ...incomingChallenge }));
  const key = boatReelCheckpointKey(owner, voyageId, challenge.id);
  const [reel, setReel] = useState(() => initialBoatReel(challenge));
  const [held, setHeld] = useState(false), [ready, setReady] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false), [started, setStarted] = useState(false);
  const [missedBite, setMissedBite] = useState(false), [timedResult, setTimedResult] = useState(false);
  const manualHook = challenge.rulesVersion >= 6;
  const biteAt = Date.parse(challenge.biteAt ?? challenge.startedAt);
  const hookDeadline = biteAt + BOAT_HOOK_WINDOW_MS;
  const expiresAt = Date.parse(challenge.expiresAt);
  const [windowClosed, setWindowClosed] = useState(() => manualHook && now >= hookDeadline);
  const [delivery, setDelivery] = useState<"idle" | "sent" | "retry">("idle");
  const [castStage, setCastStage] = useState(() => boatCastStage(challenge, now));
  const runtime = useRef({ reel: initialBoatReel(challenge), inputs: [] as BoatReelInput[], held: false, reelStartedAt: null as number | null,
    missed: false, hookClosed: false, ready: false, expired: false, focused: true });
  const current = useRef({ now, observedAt: 0, wallAt: 0, readClock });
  const deliveryBlocked = disabled || queued || uncertain;
  const blocked = deliveryBlocked || suspended;
  const gates = useRef({ blocked, deliveryBlocked, ownCast });
  const submission = useRef(false);
  // A definitive response can arrive without a rendered busy frame. Keep its retry available
  // even when a later, unrelated server notice clears the error.
  if (delivery === "sent" && error && !disabled && !queued && !uncertain) setDelivery("retry");
  const waitingForConfirmation = queued || delivery === "sent" || uncertain && reel.status !== "active";
  const expired = !waitingForConfirmation && (deadlineReached || timedResult && now > expiresAt + 86_400_000);
  const playing = started && reel.status === "active" && !expired;
  useEffect(() => { current.current = { now, observedAt: performance.now(), wallAt: Date.now(), readClock }; }, [now, readClock]);
  const serverTime = useCallback(() => {
    const clock = current.current;
    const elapsed = performance.now() - clock.observedAt;
    // Some platforms stop the monotonic clock during system sleep.
    const wallElapsed = Date.now() - clock.wallAt;
    const estimate = clock.readClock?.() ?? clock.now + elapsed;
    return wallElapsed - elapsed > 1000 ? Math.max(estimate, clock.now + wallElapsed) : estimate;
  }, []);
  const save = useCallback(() => {
    const data = runtime.current;
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.reelStartedAt !== null, data.reelStartedAt ?? undefined);
  }, [key, challenge]);
  const canDeliverLate = useCallback((time: number) => {
    const data = runtime.current;
    return time <= expiresAt + 86_400_000 && (data.missed && gates.current.ownCast && hookDeadline <= expiresAt
      || data.reel.status !== "active" && data.reelStartedAt !== null && data.reelStartedAt + data.reel.tick * challenge.tickMs <= expiresAt);
  }, [challenge.tickMs, expiresAt, hookDeadline]);
  const advance = useCallback((time: number) => {
    const data = runtime.current;
    if (data.reelStartedAt === null || data.expired || data.reel.status !== "active") return;
    const target = Math.min(challenge.maxTicks, Math.floor((Math.min(time, expiresAt) - data.reelStartedAt) / challenge.tickMs));
    const before = data.reel.tick;
    while (data.reel.tick < target && data.reel.status === "active") data.reel = stepBoatReel(challenge, data.reel, data.held);
    if (data.reel.tick === before) return;
    setReel(data.reel);
    if (data.reel.status !== "active") { data.held = false; setHeld(false); setTimedResult(canDeliverLate(time)); }
    if (data.reel.status !== "active" || Math.floor(before / 20) !== Math.floor(data.reel.tick / 20)) save();
  }, [challenge, save, expiresAt, canDeliverLate]);
  const release = useCallback(() => {
    const data = runtime.current;
    if (!data.ready) return;
    advance(serverTime());
    if (data.held && data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
    data.held = false; setHeld(false);
    save();
  }, [advance, save, serverTime]);
  useEffect(() => {
    gates.current = { blocked, deliveryBlocked, ownCast };
    if (blocked) release();
  }, [blocked, deliveryBlocked, ownCast, release]);

  useEffect(() => {
    const data = runtime.current;
    retainBoatReelCheckpoint(storage(), owner, key);
    const restored = readBoatReelCheckpoint(storage(), key, challenge);
    data.reel = restored.reel; data.inputs = restored.inputs; data.held = false;
    const hooked = restored.reel.tick > 0 || Boolean(restored.hooked);
    // Old drafts contain the completed ticks only. Use the latest possible legal hook,
    // preserving the recorded inputs and counting the remaining time with the line released.
    data.reelStartedAt = hooked && (restored.reel.status === "active" || restored.reelStartedAt !== undefined) ? restored.reelStartedAt ?? (manualHook
      ? Math.max(biteAt, Math.min(hookDeadline, serverTime() - restored.reel.tick * challenge.tickMs)) : biteAt) : null;
    if (hooked && data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
    data.ready = true; data.expired = false; data.missed = false; data.hookClosed = false;
    data.focused = document.hasFocus?.() ?? true;
    setReel(data.reel); setStarted(hooked);
    let frame = 0, publishedStage = boatCastStage(challenge, serverTime());
    const blur = () => { data.focused = false; release(); };
    const focus = () => { data.focused = true; };
    const visibility = () => { if (document.hidden) release(); };
    const update = () => {
      const time = serverTime();
      const nextStage = boatCastStage(challenge, time);
      if (nextStage !== publishedStage) { publishedStage = nextStage; setCastStage(nextStage); }
      if (data.reelStartedAt === null && data.reel.status === "active" && nextStage === "bite") {
        if (!manualHook) {
          data.reelStartedAt = biteAt; setStarted(true); save();
        } else if (time >= hookDeadline && !data.hookClosed) {
          data.hookClosed = true; setWindowClosed(true);
          // Only the casting tab may discard a missed hook without an explicit action.
          if (gates.current.ownCast) { data.missed = true; setMissedBite(true); }
        }
      }
      advance(time);
      setTimedResult(canDeliverLate(time));
      if (time >= expiresAt && !canDeliverLate(time)) {
        data.expired = true; setDeadlineReached(true); release(); return;
      }
      if (!data.missed && data.reel.status === "active") frame = requestAnimationFrame(update);
    };
    update();
    setCastStage(publishedStage); setReady(true);
    window.addEventListener("blur", blur); window.addEventListener("focus", focus);
    window.addEventListener("pagehide", release); document.addEventListener("visibilitychange", visibility);
    document.addEventListener("freeze", release);
    return () => {
      cancelAnimationFrame(frame); release(); data.ready = false;
      window.removeEventListener("blur", blur); window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", release); document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("freeze", release);
    };
  }, [key, challenge, owner, advance, save, release, serverTime, biteAt, hookDeadline, expiresAt, canDeliverLate, manualHook]);

  const hookFish = () => {
    const data = runtime.current, time = serverTime();
    if (!manualHook || !data.ready || data.reelStartedAt !== null || data.missed || data.expired || expired || blocked || document.hidden
      || !data.focused || time < biteAt || time >= Math.min(hookDeadline, Date.parse(challenge.expiresAt))) return;
    data.reelStartedAt = time; setStarted(true); save();
  };
  const confirmMiss = () => {
    const data = runtime.current;
    if (!manualHook || !data.ready || !data.hookClosed || data.reelStartedAt !== null || data.missed || blocked || expired) return;
    data.missed = true; setMissedBite(true);
  };
  const changeHeld = (next: boolean) => {
    const data = runtime.current;
    if (!data.ready || data.reelStartedAt === null || gates.current.blocked || data.expired || expired || !data.focused || document.hidden) return;
    advance(serverTime());
    if (data.reel.status !== "active" || data.held === next) return;
    changeBoatReelInput(data.inputs, data.reel.tick, next); data.held = next; setHeld(next);
    save();
  };
  const submit = useCallback(() => {
    const data = runtime.current;
    const currentTime = serverTime();
    if (submission.current || gates.current.deliveryBlocked || !data.ready || data.expired || (!data.missed && data.reel.status === "active")) return;
    if (currentTime >= expiresAt && !canDeliverLate(currentTime)) {
      data.expired = true; setDeadlineReached(true); return;
    }
    // The guard also covers reentrant callbacks and Strict Mode's repeated effects.
    submission.current = true;
    save();
    let accepted = false;
    try { accepted = onSubmit(data.missed ? { challengeId: challenge.id, endTick: 0, inputs: [], missedBite: true } : boatReelSubmission(challenge, data.reel, data.inputs)); }
    catch { /* The verified trace remains available for retry after a local transport failure. */ }
    submission.current = accepted; setDelivery(accepted ? "sent" : "retry");
  }, [challenge, onSubmit, save, serverTime, expiresAt, canDeliverLate]);
  useEffect(() => {
    // Persist the verified trace to the external outbox before this view can unmount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready && (missedBite || reel.status !== "active") && delivery === "idle" && !deliveryBlocked && !expired) submit();
  }, [ready, reel.status, missedBite, delivery, deliveryBlocked, expired, submit]);
  useEffect(() => { if (delivery === "retry") submission.current = false; }, [delivery]);
  useEffect(() => {
    if (delivery !== "retry" || deliveryBlocked || expired) return;
    window.addEventListener("online", submit);
    return () => window.removeEventListener("online", submit);
  }, [delivery, deliveryBlocked, expired, submit]);
  const missedElsewhere = manualHook && windowClosed && !started && !missedBite;
  const status = waitingForConfirmation ? "Проверяем результат" : expired ? "Рыба ушла" : missedElsewhere ? "Время для подсечки прошло" : missedBite ? "Поклёвка пропущена" : reel.status === "caught" ? "Рыба у борта!" : reel.status === "escaped" ? "Рыба сорвалась" : playing ? "Рыба на крючке" : castStage === "casting" ? "Забрасываем удочку…" : castStage === "soaking" ? "Ждём поклёвку…" : "Поплавок нырнул";
  return { challenge, reel, playing, held, ready, expired, waitingForConfirmation, retryNeeded: delivery === "retry", status, castStage,
    changeHeld, submit, hookFish, missedBite, missedElsewhere, confirmMiss, awaitingHook: manualHook && !windowClosed && !started && !missedBite && castStage === "bite" };
}
