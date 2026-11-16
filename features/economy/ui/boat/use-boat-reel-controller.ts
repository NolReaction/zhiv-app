"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clientJournalStorage, isStoragePromise } from "@/lib/client-journal-storage";
import { createNativeBoatReelCheckpoint, type NativeBoatReelCheckpoint } from "./native-boat-reel-checkpoint";
import { BOAT_HOOK_WINDOW_MS } from "@/features/economy/domain/boat-model";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, stepBoatReel } from "@/features/economy/domain/boat-reel";
import { boatReelCheckpointKey, boatReelSubmission, encodeBoatReelCheckpoint, type BoatReelCheckpoint, changeBoatReelInput, readBoatReelCheckpoint, retainBoatReelCheckpoint, writeBoatReelCheckpoint } from "./boat-reel-checkpoint";
import { boatCastStage } from "./boat-cast-timing";

export type BoatReelControllerProps = { owner: string; voyageId: string; challenge: BoatChallenge; now: number; readClock?: () => number; ownCast?: boolean; suspended?: boolean;
  disabled: boolean; queued?: boolean; uncertain?: boolean; error?: string | null; onSubmit: (submission: BoatReelCommand, outcome: "caught" | "escaped") => boolean | Promise<boolean> };
// Browser drafts belong to this tab; native drafts are committed to SQLite.
// The completed submission has its own durable economic outbox.
const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** A keyed attempt owns one fixed-step input trace, regardless of display refresh rate. */
export function useBoatReelController({ owner, voyageId, challenge: incomingChallenge, now, readClock, ownCast = false, disabled, suspended = false, queued = false, uncertain = false, error, onSubmit }: BoatReelControllerProps) {
  const [challenge] = useState(() => Object.freeze({ ...incomingChallenge }));
  const key = boatReelCheckpointKey(owner, voyageId, challenge.id);
  const [reel, setReel] = useState(() => initialBoatReel(challenge));
  const [storageError, setStorageError] = useState<string | null>(null);
  const persistence = useRef<NativeBoatReelCheckpoint | null>(null);
  const lifetime = useRef(0);
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
    live: false, failed: false, missed: false, hookClosed: false, ready: false, expired: false, focused: true });
  const current = useRef({ now, observedAt: 0, wallAt: 0, readClock });
  const deliveryBlocked = disabled || queued || uncertain;
  // Hooking and the fight are local. A different in-flight command can delay
  // delivery of the recorded result, but must never release the player's line.
  const blocked = queued || suspended;
  const gates = useRef({ blocked, deliveryBlocked, ownCast });
  const submission = useRef(false);
  // A definitive response can arrive without a rendered busy frame. Keep its retry available
  // even when a later, unrelated server notice clears the error.
  if (delivery === "sent" && error && !disabled && !queued && !uncertain) setDelivery("retry");
  const waitingForConfirmation = queued || delivery === "sent" || uncertain && reel.status !== "active";
  const expired = !waitingForConfirmation && (deadlineReached || timedResult && now > expiresAt + 86_400_000);
  const playing = !storageError && started && reel.status === "active" && !expired;
  useEffect(() => { current.current = { now, observedAt: performance.now(), wallAt: Date.now(), readClock }; }, [now, readClock]);
  const serverTime = useCallback(() => {
    const clock = current.current;
    const elapsed = performance.now() - clock.observedAt;
    // Some platforms stop the monotonic clock during system sleep.
    const wallElapsed = Date.now() - clock.wallAt;
    const estimate = clock.readClock?.() ?? clock.now + elapsed;
    return wallElapsed - elapsed > 1000 ? Math.max(estimate, clock.now + wallElapsed) : estimate;
  }, []);
  const failStorage = useCallback((epoch: number) => {
    if (epoch !== lifetime.current || !runtime.current.live) return;
    const data = runtime.current;
    data.failed = true; data.ready = false; data.held = false;
    setHeld(false); setReady(false);
    setStorageError("Не удалось подтвердить сохранение попытки. Откройте приложение заново, чтобы восстановить запись.");
  }, []);
  const save = useCallback((): boolean | Promise<boolean> => {
    const data = runtime.current, epoch = lifetime.current;
    if (!data.live || data.failed) return false;
    const session = persistence.current;
    if (session) {
      const raw = encodeBoatReelCheckpoint(challenge, data.reel, data.inputs, data.reelStartedAt !== null, data.reelStartedAt ?? undefined, data.missed);
      return session.write(raw).then(() => epoch === lifetime.current && data.live && !data.failed,
        () => { failStorage(epoch); return false; });
    }
    writeBoatReelCheckpoint(storage(), key, challenge, data.reel, data.inputs, data.reelStartedAt !== null, data.reelStartedAt ?? undefined);
    return true;
  }, [key, challenge, failStorage]);
  const canDeliverLate = useCallback((time: number) => {
    const data = runtime.current;
    return time <= expiresAt + 86_400_000 && (data.missed && gates.current.ownCast && hookDeadline <= expiresAt
      || data.reel.status !== "active" && data.reelStartedAt !== null && data.reelStartedAt + data.reel.tick * challenge.tickMs <= expiresAt);
  }, [challenge.tickMs, expiresAt, hookDeadline]);
  const submitAction = useRef(onSubmit);
  useLayoutEffect(() => { submitAction.current = onSubmit; }, [onSubmit]);
  const submit = useCallback(() => {
    const data = runtime.current, epoch = lifetime.current;
    const currentTime = serverTime();
    if (submission.current || !data.ready || data.failed || data.expired || (!data.missed && data.reel.status === "active")) return;
    if (currentTime >= expiresAt && !canDeliverLate(currentTime)) {
      data.expired = true; setDeadlineReached(true); return;
    }
    const saved = save();
    if (gates.current.deliveryBlocked) return;
    // The guard spans both SQLite acknowledgement and the economic outbox handoff.
    submission.current = true;
    const active = () => epoch === lifetime.current && data.live && !data.failed;
    const finish = (accepted: boolean) => {
      if (!active()) return;
      submission.current = accepted; setDelivery(accepted ? "sent" : "retry");
    };
    const deliver = (committed: boolean) => {
      if (!active() || !committed) return;
      if (gates.current.deliveryBlocked) { submission.current = false; return; }
      try {
        const trace = data.missed ? { challengeId: challenge.id, endTick: 0, inputs: [], missedBite: true as const }
          : boatReelSubmission(challenge, data.reel, data.inputs);
        const accepted = submitAction.current(trace, !data.missed && data.reel.status === "caught" ? "caught" : "escaped");
        if (isStoragePromise(accepted)) {
          void accepted.then(finish, () => {
            // A rejected native acknowledgement may already have committed. Restore
            // its durable receipt instead of manufacturing a replacement request.
            if (persistence.current) failStorage(epoch); else finish(false);
          });
        } else finish(accepted);
      } catch { if (persistence.current) failStorage(epoch); else finish(false); }
    };
    if (isStoragePromise(saved)) void saved.then(deliver); else deliver(saved);
  }, [challenge, save, serverTime, expiresAt, canDeliverLate, failStorage]);
  const advance = useCallback((time: number) => {
    const data = runtime.current;
    if (!data.ready || data.failed || data.reelStartedAt === null || data.expired || data.reel.status !== "active") return;
    const target = Math.min(challenge.maxTicks, Math.floor((Math.min(time, expiresAt) - data.reelStartedAt) / challenge.tickMs));
    const before = data.reel.tick;
    while (data.reel.tick < target && data.reel.status === "active") data.reel = stepBoatReel(challenge, data.reel, data.held);
    if (data.reel.tick === before) return;
    setReel(data.reel);
    if (data.reel.status !== "active") {
      data.held = false; setHeld(false); setTimedResult(canDeliverLate(time));
      // pagehide can advance the last tick without giving React another render.
      // Save the draft even when delivery is blocked, then hand off the exact trace now.
      submit();
    } else if (Math.floor(before / 20) !== Math.floor(data.reel.tick / 20)) save();
  }, [challenge, save, expiresAt, canDeliverLate, submit]);
  const release = useCallback(() => {
    const data = runtime.current;
    if (!data.ready) return;
    advance(serverTime());
    if (data.reel.status !== "active") return;
    if (data.held) changeBoatReelInput(data.inputs, data.reel.tick, false);
    data.held = false; setHeld(false);
    save();
  }, [advance, save, serverTime]);
  useEffect(() => {
    gates.current = { blocked, deliveryBlocked, ownCast };
    if (blocked) release();
  }, [blocked, deliveryBlocked, ownCast, release]);

  useEffect(() => {
    const data = runtime.current, epoch = ++lifetime.current;
    data.live = true; data.ready = false; data.failed = false;
    submission.current = false;
    let frame = 0, listening = false, session: NativeBoatReelCheckpoint | null = null;
    const active = () => epoch === lifetime.current && data.live;
    const blur = () => { data.focused = false; release(); };
    const focus = () => { data.focused = true; };
    const visibility = () => { if (document.hidden) release(); };
    const restore = (restored: BoatReelCheckpoint) => {
      if (!active()) return;
      data.reel = restored.reel; data.inputs = restored.inputs; data.held = false;
      const hooked = restored.reel.tick > 0 || Boolean(restored.hooked);
      // Resume away time with released input, preserving completed simulation ticks.
      data.reelStartedAt = hooked && (restored.reel.status === "active" || restored.reelStartedAt !== undefined) ? restored.reelStartedAt ?? (manualHook
        ? Math.max(biteAt, Math.min(hookDeadline, serverTime() - restored.reel.tick * challenge.tickMs)) : biteAt) : null;
      if (hooked && data.reel.status === "active") changeBoatReelInput(data.inputs, data.reel.tick, false);
      data.expired = false; data.missed = Boolean(restored.missedBite); data.hookClosed = data.missed;
      data.focused = document.hasFocus?.() ?? true;
      const start = () => {
        if (!active() || data.failed) return;
        data.ready = true;
        setStorageError(null); setReel(data.reel); setStarted(hooked); setHeld(false);
        setMissedBite(data.missed); setDelivery("idle");
        let publishedStage = boatCastStage(challenge, serverTime());
        const update = () => {
          if (!active() || !data.ready || data.failed) return;
          const time = serverTime();
          const nextStage = boatCastStage(challenge, time);
          if (nextStage !== publishedStage) { publishedStage = nextStage; setCastStage(nextStage); }
          if (data.reelStartedAt === null && data.reel.status === "active" && nextStage === "bite") {
            if (!manualHook) {
              data.reelStartedAt = biteAt; setStarted(true); save();
            } else if (time >= hookDeadline && !data.hookClosed) {
              data.hookClosed = true; setWindowClosed(true);
              if (gates.current.ownCast) { data.missed = true; setMissedBite(true); save(); }
            }
          }
          advance(time);
          setTimedResult(canDeliverLate(time));
          if (time >= expiresAt && !canDeliverLate(time)) {
            data.expired = true; setDeadlineReached(true); release(); return;
          }
          if (!data.missed && data.reel.status === "active") frame = requestAnimationFrame(update);
        };
        if (data.missed || data.reel.status !== "active") submit();
        update();
        setCastStage(publishedStage); setReady(true);
        listening = true;
        window.addEventListener("blur", blur); window.addEventListener("focus", focus);
        window.addEventListener("pagehide", release); document.addEventListener("visibilitychange", visibility);
        document.addEventListener("freeze", release);
      };
      // Native restoration includes the released-input checkpoint before readiness.
      if (session) {
        const raw = encodeBoatReelCheckpoint(challenge, data.reel, data.inputs, data.reelStartedAt !== null, data.reelStartedAt ?? undefined, data.missed);
        void session.write(raw).then(start, () => failStorage(epoch));
      } else start();
    };
    try {
      const native = clientJournalStorage(owner);
      if (native) {
        session = createNativeBoatReelCheckpoint(native, owner, key, challenge, storage());
        persistence.current = session;
        void session.ready.then(restore, () => failStorage(epoch));
      } else {
        persistence.current = null;
        retainBoatReelCheckpoint(storage(), owner, key);
        restore(readBoatReelCheckpoint(storage(), key, challenge));
      }
    } catch { queueMicrotask(() => failStorage(epoch)); }
    return () => {
      cancelAnimationFrame(frame);
      if (data.ready) release();
      data.ready = false; data.live = false; session?.close();
      if (listening) {
        window.removeEventListener("blur", blur); window.removeEventListener("focus", focus);
        window.removeEventListener("pagehide", release); document.removeEventListener("visibilitychange", visibility);
        document.removeEventListener("freeze", release);
      }
    };
  }, [key, challenge, owner, advance, save, release, serverTime, biteAt, hookDeadline, expiresAt, canDeliverLate, manualHook, submit, failStorage]);

  const hookFish = () => {
    const data = runtime.current, time = serverTime();
    if (!manualHook || !data.ready || data.reelStartedAt !== null || data.missed || data.expired || expired || blocked || document.hidden
      || !data.focused || time < biteAt || time >= Math.min(hookDeadline, Date.parse(challenge.expiresAt))) return;
    data.reelStartedAt = time; setStarted(true); save();
  };
  const confirmMiss = () => {
    const data = runtime.current;
    if (!manualHook || !data.ready || !data.hookClosed || data.reelStartedAt !== null || data.missed || blocked || expired) return;
    data.missed = true; setMissedBite(true); save();
  };
  const changeHeld = (next: boolean) => {
    const data = runtime.current;
    if (!data.ready || data.reelStartedAt === null || gates.current.blocked || data.expired || expired || !data.focused || document.hidden) return;
    advance(serverTime());
    if (data.reel.status !== "active" || data.held === next) return;
    changeBoatReelInput(data.inputs, data.reel.tick, next); data.held = next; setHeld(next);
    save();
  };
  useEffect(() => {
    // Resume a blocked terminal handoff and settle a missed bite without another input event.
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
  const status = storageError ?? (waitingForConfirmation ? missedBite ? "Поклёвка пропущена" : reel.status === "caught" ? "Рыба поймана" : reel.status === "escaped" ? "Рыба сорвалась" : "Попытка завершена" : expired ? "Рыба ушла" : missedElsewhere ? "Время для подсечки прошло" : missedBite ? "Поклёвка пропущена" : reel.status === "caught" ? "Рыба у борта!" : reel.status === "escaped" ? "Рыба сорвалась" : playing ? "Рыба на крючке" : castStage === "casting" ? "Забрасываем удочку…" : castStage === "soaking" ? "Ждём поклёвку…" : "Поплавок нырнул");
  return { storageError, challenge, reel, playing, held, ready, expired, waitingForConfirmation, retryNeeded: delivery === "retry", status, castStage,
    changeHeld, submit, hookFish, missedBite, missedElsewhere, confirmMiss, awaitingHook: manualHook && !windowClosed && !started && !missedBite && castStage === "bite" };
}
