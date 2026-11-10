"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FishingRod } from "lucide-react";
import styles from "./boat-fishing-map.module.css";
import { boatCastPower } from "./boat-cast-timing";

export function BoatCastControl({ disabled, onCast }: { disabled: boolean; onCast: (power: number) => void }) {
  const press = useRef<{ input: string; at: number } | null>(null);
  const [power, setPower] = useState<number | null>(null);
  const cancel = useCallback(() => { press.current = null; setPower(null); }, []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", hidden); };
  }, [cancel]);
  const charging = power !== null;
  useEffect(() => {
    if (disabled) press.current = null;
    if (!charging) return;
    let frame = 0;
    const update = (time: number) => {
      if (!press.current) { setPower(null); return; }
      const value = boatCastPower(time - press.current.at);
      setPower(value);
      if (value < 100) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [charging, disabled]);
  const start = (input: string) => {
    if (disabled || press.current) return;
    press.current = { input, at: performance.now() };
    setPower(boatCastPower(0));
  };
  const release = (input: string) => {
    const active = press.current;
    if (!active || active.input !== input) return;
    cancel();
    if (!disabled) onCast(boatCastPower(performance.now() - active.at));
  };
  return <button type="button" className={`${styles.primary} ${styles.castControl}`} data-fishing-action="cast"
    aria-label="Забросить удочку. Удерживайте для выбора силы, отпустите для заброса." disabled={disabled}
    onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      start(String(event.pointerId));
    }}
    onPointerUp={event => { if (event.isPrimary) { event.preventDefault(); release(String(event.pointerId)); } }}
    onLostPointerCapture={event => { if (press.current?.input === String(event.pointerId)) cancel(); }}
    onPointerCancel={cancel} onBlur={cancel}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault(); if (!event.repeat) start(event.key);
    }}
    onKeyUp={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); release(event.key); } }}
    onClick={event => { if (event.detail === 0 && !disabled && !press.current) onCast(boatCastPower(0)); }}>
    <FishingRod size={18} /><span>{power === null ? "Забросить удочку" : `Отпустите · ${power}%`}</span>
    {power !== null && <i className={styles.castPower} aria-hidden="true" style={{ transform: `scaleX(${power / 100})` }} />}
  </button>;
}
