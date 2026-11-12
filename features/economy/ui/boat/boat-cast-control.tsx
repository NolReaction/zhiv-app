"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FishingRod } from "lucide-react";
import { BOAT_CAST_CYCLE_MS, BOAT_CAST_GREEN_RADIUS, boatCastAim } from "@/features/economy/domain/boat-cast-aim";
import styles from "./boat-cast-control.module.css";
import { BOAT_CAST_MIN_HOLD_MS } from "./boat-cast-timing";
import { focusBoatWaterIfIdle } from "./boat-water-focus";

type CastGesture = { input: string; startedAt: number; dock?: string };

// Store both axes so the same feedback can reflow if the screen rotates after release.
function meterDock(event: PointerEvent<HTMLButtonElement>) {
  if (event.pointerType !== "touch" && event.pointerType !== "pen") return undefined;
  const water = event.currentTarget.getBoundingClientRect();
  const vertical = event.clientY - water.top >= water.height * 0.61 ? "upper" : "lower";
  const horizontal = event.clientX - water.left >= water.width / 2 ? "left" : "right";
  return `${vertical} ${horizontal}`;
}

function eventTime(timestamp?: number) {
  const now = performance.now();
  return timestamp != null && timestamp > 0 && timestamp <= now ? timestamp : now;
}

function CastMeter({ voyageId, castNumber, startedAt, dock }: { voyageId: string; castNumber: number; startedAt: number; dock?: string }) {
  const [aim, setAim] = useState(() => boatCastAim(voyageId, castNumber, performance.now() - startedAt));
  useEffect(() => {
    let frame = 0;
    const draw = (time: number) => {
      const next = boatCastAim(voyageId, castNumber, time - startedAt);
      setAim(previous => previous.marker === next.marker && previous.target === next.target ? previous : next);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [voyageId, castNumber, startedAt]);

  const position = {
    "--marker": aim.marker + "%", "--target": aim.target + "%", "--green-radius": BOAT_CAST_GREEN_RADIUS + "%",
  } as CSSProperties;
  return <span className={styles.meter} role="meter" aria-label="Точность заброса"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={aim.quality}
    data-meter-dock={dock} data-marker={aim.marker} data-target={aim.target} style={position}>
    <span className={styles.caption} aria-hidden="true">Точность заброса <b>{aim.quality}%</b></span>
    <span className={styles.track} aria-hidden="true"><i className={styles.window} /><i className={styles.needle} /></span>
  </span>;
}

type Props = {
  disabled: boolean;
  awaitingLanding?: boolean;
  voyageId: string;
  castNumber: number;
  onCast: (power: number, heldMs: number, quality: number, dock?: string) => void;
  onChargingChange?: (charging: boolean) => void;
};

export function BoatCastControl({ disabled, awaitingLanding = false, voyageId, castNumber, onCast, onChargingChange }: Props) {
  const water = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!disabled) focusBoatWaterIfIdle(water.current); }, [disabled]);
  const press = useRef<CastGesture | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useRef(onChargingChange);
  useEffect(() => { notify.current = onChargingChange; }, [onChargingChange]);
  const prepared = useRef<{ power: number; elapsed: number; quality: number; dock?: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const discard = useCallback(() => {
    if (!prepared.current) return;
    prepared.current = null;
    setWaiting(false);
  }, []);
  const [gesture, setGesture] = useState<CastGesture | null>(null);
  const cancel = useCallback(() => {
    if (!press.current) return;
    clearTimeout(armTimer.current);
    press.current = null;
    setGesture(null);
    notify.current?.(false);
  }, []);
  useEffect(() => {
    const abandon = () => { cancel(); discard(); };
    const hidden = () => { if (document.hidden) abandon(); };
    window.addEventListener("blur", abandon);
    window.addEventListener("pagehide", abandon);
    window.addEventListener("offline", abandon);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", abandon);
      window.removeEventListener("pagehide", abandon);
      window.removeEventListener("offline", abandon);
      document.removeEventListener("visibilitychange", hidden);
      abandon();
    };
  }, [cancel, discard, voyageId, castNumber, disabled]);
  useEffect(() => {
    if (disabled || awaitingLanding || !prepared.current) return;
    const cast = prepared.current;
    // The enclosing dialog releases its previous command latch in the same commit.
    // Unmounting or moving to a different receipt cancels this particular gesture.
    let active = true;
    queueMicrotask(() => {
      if (!active || prepared.current !== cast) return;
      discard();
      if (!document.hidden && (document.hasFocus?.() ?? true)) onCast(cast.power, cast.elapsed, cast.quality, cast.dock);
    });
    return () => { active = false; };
  }, [disabled, awaitingLanding, discard, onCast]);

  const start = (input: string, timestamp?: number, dock?: string) => {
    if (disabled || press.current || prepared.current) return;
    const active = { input, startedAt: eventTime(timestamp), dock };
    press.current = active;
    armTimer.current = setTimeout(() => {
      if (press.current !== active) return;
      setGesture(active);
      notify.current?.(true);
    }, Math.max(0, active.startedAt + BOAT_CAST_MIN_HOLD_MS - performance.now()));
  };
  const release = (input: string, timestamp?: number) => {
    const active = press.current;
    if (!active || active.input !== input) return;
    const duration = Math.floor(eventTime(timestamp) - active.startedAt);
    cancel();
    if (disabled || duration < BOAT_CAST_MIN_HOLD_MS) return;
    const elapsed = duration % BOAT_CAST_CYCLE_MS;
    const { power, quality } = boatCastAim(voyageId, castNumber, elapsed);
    if (awaitingLanding) {
      prepared.current = { power, elapsed, quality, dock: active.dock };
      setWaiting(true);
    } else onCast(power, elapsed, quality, active.dock);
  };
  const cancelPointer = (pointerId: number) => { if (press.current?.input === String(pointerId)) cancel(); };
  return <>
    <button type="button" ref={water} className={styles.surface} data-boat-water-control data-fishing-action="cast" disabled={disabled}
      aria-busy={waiting || undefined} aria-label={waiting ? "Замах готов" : "Удерживать для заброса. Отпустите, когда метка войдёт в зелёную зону"} aria-keyshortcuts="Space Enter"
      onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        start(String(event.pointerId), event.timeStamp, meterDock(event));
      }}
      onPointerUp={event => {
        if (!event.isPrimary) return;
        event.preventDefault();
        release(String(event.pointerId), event.timeStamp);
      }}
      onLostPointerCapture={event => cancelPointer(event.pointerId)}
      onPointerCancel={event => cancelPointer(event.pointerId)} onBlur={cancel}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        if (!event.repeat) start(event.key, event.timeStamp);
      }}
      onKeyUp={event => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        release(event.key, event.timeStamp);
      }}
      onClick={event => {
        if (event.detail !== 0 || disabled) return;
        if (press.current?.input === "activation") release("activation", event.timeStamp);
        else start("activation", event.timeStamp);
      }}>
      {!gesture && !disabled && <span className={styles.actionCue} data-fishing-cue="cast" aria-hidden="true">
        <FishingRod size={20} />{waiting ? "Замах готов" : "Удерживать для заброса"}
      </span>}
    </button>
    {gesture && !disabled && <CastMeter voyageId={voyageId} castNumber={castNumber} startedAt={gesture.startedAt} dock={gesture.dock} />}
  </>;
}
