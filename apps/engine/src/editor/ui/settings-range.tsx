"use client";

import { useEffect, useRef, useState } from "react";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Transaction = { beginSettingsEdit: () => unknown; commitSettingsEdit: () => unknown; cancelSettingsEdit: () => unknown };
const rangeKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function SettingsRange({ label, value, min, max, step = 1, unit = "", controller, change }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; controller: Transaction | null; change: (value: number) => void }) {
  const active = useRef(false);
  useEffect(() => {
    const blur = () => { active.current = false; controller?.cancelSettingsEdit(); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [controller]);
  function begin() { if (!active.current && controller) { controller.beginSettingsEdit(); active.current = true; } }
  function finish() { if (active.current) { active.current = false; controller?.commitSettingsEdit(); } }
  function cancel() { if (active.current) { active.current = false; controller?.cancelSettingsEdit(); } }
  return <label className={styles.settingRange}><span>{label}<strong>{Math.round(value * 100) / 100}{unit}</strong></span><input type="range" autoComplete="off" aria-label={label} min={min} max={max} step={step} value={value} disabled={!controller} onPointerDown={event => { begin(); event.currentTarget.setPointerCapture(event.pointerId); }} onChange={event => change(Number(event.target.value))} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} onBlur={cancel} onKeyDownCapture={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } else if (rangeKeys.has(event.key)) begin(); }} onKeyUp={event => { if (rangeKeys.has(event.key)) finish(); }} /></label>;
}

type ColorProps = { label: string; value: string; change: (value: string) => void };
export function SettingsColor(props: ColorProps) { return <ColorDraft key={props.value} {...props} />; }

function ColorDraft({ label, value, change }: ColorProps) {
  const [draft, setDraft] = useState(value);
  const valid = /^#[\da-f]{6}$/i.test(draft), dirty = draft.toLowerCase() !== value.toLowerCase();
  function apply() { if (valid && dirty) change(draft.toLowerCase()); }
  return <div className={styles.settingColor}><span>{label}</span><div className={styles.colorControls}><input type="color" aria-label={label} value={valid ? draft : value} autoComplete="off" title="Выбери цвет, затем нажми «Применить»" onChange={event => setDraft(event.target.value)} /><input type="text" data-editor-color-field aria-label={label + ": код"} value={draft} maxLength={7} spellCheck={false} autoComplete="off" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); apply(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(value); } }} /><EditorButton type="button" aria-label={"Применить " + label.toLowerCase()} disabled={!valid || !dirty} onClick={apply}>Применить</EditorButton></div></div>;
}
