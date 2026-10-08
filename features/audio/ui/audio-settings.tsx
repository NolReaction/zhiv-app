"use client";

import { useId, useState } from "react";
import { Volume2, VolumeX, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { AudioBus, AudioDiagnostics, AudioSettingsPatch } from "@/features/audio/domain/types";
import { AUDIO_BUSES } from "@/features/audio/domain/types";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "./audio-lifecycle";
import { useAudioDiagnostics } from "./use-audio-diagnostics";
import styles from "./audio-settings.module.css";

export const AUDIO_BUS_LABELS: Record<AudioBus, string> = {
  music: "Музыка", ambience: "Лес и погода", world: "Постройки и действия", characters: "Голоса героев", ui: "Интерфейс",
};

function VolumeSlider({ id, label, value, onChange }: {
  id: string; label: string; value: number; onChange: (volume: number) => void;
}) {
  const percent = Math.round(value * 100);
  return <label className={styles.volume} htmlFor={id}>
    <span>{label}<output htmlFor={id} aria-hidden="true">{percent}%</output></span>
    <input id={id} type="range" min={0} max={100} step={1} value={percent} aria-valuetext={`${percent}%`}
      onChange={event => onChange(Number(event.currentTarget.value) / 100)} />
  </label>;
}

/** Kept separate from the dialog so settings can be verified without a browser audio device. */
export function AudioSettingsControls({ id, diagnostics, busy, feedback, onChange, onEnable, onResume }: {
  id: string; diagnostics: AudioDiagnostics; busy: boolean; feedback: string;
  onChange: (patch: AudioSettingsPatch) => void; onEnable: () => void; onResume: () => void;
}) {
  const { settings, state } = diagnostics;
  const needsResume = settings.enabled && (state === "suspended" || state === "locked");
  return <div className={styles.controls}>
    <div className={styles.masterSwitch}>
      <span><strong>Звуки игры</strong><small>{settings.enabled ? "Включены" : "Выключены"}</small></span>
      <button type="button" role="switch" aria-checked={settings.enabled} aria-label="Звуки игры"
        className={styles.switch} disabled={busy || state === "unavailable"}
        onClick={() => settings.enabled ? onChange({ enabled: false }) : onEnable()}>
        <span aria-hidden="true" />
      </button>
    </div>
    <p className={styles.hint}>Громкость сохраняется на этом устройстве. В фоне игра звучать не будет.</p>
    <VolumeSlider id={`${id}-master`} label="Общая громкость" value={settings.master} onChange={master => onChange({ master })} />
    <fieldset className={styles.buses}>
      <legend>Что слышно в игре</legend>
      {AUDIO_BUSES.map(bus => <VolumeSlider key={bus} id={`${id}-${bus}`} label={AUDIO_BUS_LABELS[bus]}
        value={settings.buses[bus]} onChange={volume => onChange({ buses: { [bus]: volume } })} />)}
    </fieldset>
    {needsResume && <button type="button" className={styles.resume} onClick={onResume} disabled={busy}>Продолжить воспроизведение</button>}
    <p className={styles.feedback} role="status">{state === "unavailable" ? "Этот браузер не поддерживает воспроизведение звуков игры." : feedback}</p>
  </div>;
}

export function AudioSettingsButton({ label = false, className }: { label?: boolean; className?: string }) {
  const diagnostics = useAudioDiagnostics();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const id = useId();
  const Icon = diagnostics.settings.enabled ? Volume2 : VolumeX;
  function changeOpen(next: boolean) {
    if (next !== open) playUiCue(getAudioRuntime(), next ? "ui.open" : "ui.close");
    setOpen(next);
  }
  async function enable() {
    const runtime = getAudioRuntime();
    setBusy(true);
    runtime.setSettings({ enabled: true });
    try {
      const ready = await runtime.unlock();
      setFeedback(ready ? "Звуки включены" : "Нажмите «Продолжить воспроизведение», чтобы разрешить звук.");
    } catch {
      setFeedback("Не удалось включить звук. Попробуйте ещё раз.");
    } finally { setBusy(false); }
  }
  return <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
    <DialogPrimitive.Trigger asChild>
      <button type="button" className={className ?? styles.trigger} aria-label="Настройки звука" title="Настройки звука">
        <Icon size={19} aria-hidden="true" />{label && <span>Звук</span>}
      </button>
    </DialogPrimitive.Trigger>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles.overlay} data-audio-settings-overlay />
      <DialogPrimitive.Content className={styles.dialog} data-audio-settings
        onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => event.stopPropagation()}>
        <header className={styles.header}>
          <div><DialogPrimitive.Title>Звуки леса</DialogPrimitive.Title>
            <DialogPrimitive.Description>Настройте музыку, окружение и голоса героев.</DialogPrimitive.Description></div>
          <DialogPrimitive.Close asChild><button type="button" className={styles.close} aria-label="Закрыть настройки звука" data-audio-settings-close><X size={20} aria-hidden="true" /></button></DialogPrimitive.Close>
        </header>
        <AudioSettingsControls id={id} diagnostics={diagnostics} busy={busy} feedback={feedback}
          onChange={patch => { getAudioRuntime().setSettings(patch); setFeedback(patch.enabled === false ? "Звуки выключены" : ""); }}
          onEnable={() => void enable()} onResume={() => void enable()} />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
