"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { BOAT_CAST_CYCLE_MS, BOAT_CAST_GREEN_RADIUS, boatCastAim } from "@/features/economy/domain/boat-cast-aim";
import styles from "./boat-cast-control.module.css";
import { focusBoatWaterIfIdle } from "./boat-water-focus";

type CastGesture = { input: string; startedAt: number };

function eventTime(timestamp?: number) {
  const now = performance.now();
  return timestamp != null && timestamp > 0 && timestamp <= now ? timestamp : now;
}

function CastMeter({ voyageId, castNumber, startedAt }: { voyageId: string; castNumber: number; startedAt: number }) {
  const [aim, setAim] = useState(() => boatCastAim(voyageId, castNumber, 0));
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
    data-marker={aim.marker} data-target={aim.target} style={position}>
    <span className={styles.caption} aria-hidden="true">Точность заброса <b>{aim.quality}%</b></span>
    <span className={styles.track} aria-hidden="true"><i className={styles.window} /><i className={styles.needle} /></span>
  </span>;
}

type Props = {
  disabled: boolean;
  voyageId: string;
  castNumber: number;
  onCast: (power: number, heldMs: number, quality: number) => void;
  onChargingChange?: (charging: boolean) => void;
};

export function BoatCastControl({ disabled, voyageId, castNumber, onCast, onChargingChange }: Props) {
  const water = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!disabled) focusBoatWaterIfIdle(water.current); }, [disabled]);
  const press = useRef<CastGesture | null>(null);
  const notify = useRef(onChargingChange);
  useEffect(() => { notify.current = onChargingChange; }, [onChargingChange]);
  const [gesture, setGesture] = useState<CastGesture | null>(null);
  const cancel = useCallback(() => {
    if (!press.current) return;
    press.current = null;
    setGesture(null);
    notify.current?.(false);
  }, []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
      cancel();
    };
  }, [cancel, voyageId, castNumber, disabled]);

  const start = (input: string, timestamp?: number) => {
    if (disabled || press.current) return;
    press.current = { input, startedAt: eventTime(timestamp) };
    setGesture(press.current);
    notify.current?.(true);
  };
  const release = (input: string, timestamp?: number) => {
    const active = press.current;
    if (!active || active.input !== input) return;
    const elapsed = Math.max(0, Math.floor(eventTime(timestamp) - active.startedAt)) % BOAT_CAST_CYCLE_MS;
    cancel();
    if (disabled) return;
    const { power, quality } = boatCastAim(voyageId, castNumber, elapsed);
    onCast(power, elapsed, quality);
  };
  return <>
    <button type="button" ref={water} className={styles.surface} data-fishing-action="cast" disabled={disabled}
      aria-label="Вода. Удерживайте для замаха и отпустите для заброса" aria-keyshortcuts="Space Enter"
      onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        start(String(event.pointerId), event.timeStamp);
      }}
      onPointerUp={event => {
        if (!event.isPrimary) return;
        event.preventDefault();
        release(String(event.pointerId), event.timeStamp);
      }}
      onLostPointerCapture={event => { if (press.current?.input === String(event.pointerId)) cancel(); }}
      onPointerCancel={cancel} onBlur={cancel}
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
      }} />
    {gesture && !disabled && <CastMeter voyageId={voyageId} castNumber={castNumber} startedAt={gesture.startedAt} />}
  </>;
}
