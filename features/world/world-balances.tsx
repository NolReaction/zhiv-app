"use client";

import { useEffect, useRef, useState } from "react";
import { Gem, Sparkles, Trees } from "lucide-react";
import type { WorldResources } from "./model";
import styles from "./world.module.css";

const resources = [
  { key: "sparks", label: "Искры", Icon: Sparkles },
  { key: "wood", label: "Древесина", Icon: Trees },
  { key: "stone", label: "Камень", Icon: Gem },
] as const;

export function resourceCountAt(from: number, target: number, progress: number) {
  if (target <= from) return target;
  return Math.min(target, Math.floor(from + (target - from) * (1 - (1 - Math.max(0, Math.min(1, progress))) ** 3)));
}

/** Animate confirmed balances only; prices and commands always use server totals. */
export function WorldBalances({ value }: { value: WorldResources }) {
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  const previousTarget = useRef(value);
  const { sparks, wood, stone } = value;
  useEffect(() => {
    const target = { sparks, wood, stone };
    const previous = previousTarget.current;
    previousTarget.current = target;
    const from = { sparks: sparks < previous.sparks ? sparks : current.current.sparks,
      wood: wood < previous.wood ? wood : current.current.wood,
      stone: stone < previous.stone ? stone : current.current.stone };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, start: number | null = null;
    function show(next: WorldResources) { current.current = next; setDisplay(next); }
    function settle() { cancelAnimationFrame(frame); frame = 0; show(target); }
    function tick(now: number) {
      start ??= now;
      const progress = Math.min(1, (now - start) / 850);
      show({ sparks: resourceCountAt(from.sparks, sparks, progress), wood: resourceCountAt(from.wood, wood, progress), stone: resourceCountAt(from.stone, stone, progress) });
      if (progress < 1) frame = requestAnimationFrame(tick);
    }
    const change = () => { if (document.hidden || media.matches) settle(); };
    if (document.hidden || media.matches || resources.every(({ key }) => target[key] <= from[key])) settle();
    else {
      show({ sparks: Math.min(from.sparks, sparks), wood: Math.min(from.wood, wood), stone: Math.min(from.stone, stone) });
      frame = requestAnimationFrame(tick);
    }
    document.addEventListener("visibilitychange", change); media.addEventListener("change", change);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", change); media.removeEventListener("change", change); };
  }, [sparks, wood, stone]);
  return <div className={styles.balances} aria-label="Ресурсы в аккаунте">
    {resources.map(({ key, label, Icon }) => <span key={key}>
      <Icon size={17} aria-hidden /><strong aria-hidden>{display[key].toLocaleString("ru-RU")}</strong>
      <span className={styles.sr}>{label}: {value[key].toLocaleString("ru-RU")}</span>
    </span>)}
  </div>;
}
