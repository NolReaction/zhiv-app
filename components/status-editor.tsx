"use client";

import { TransientNotice } from "./app-notifications";
import { useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ApiError, updateMyStatus } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { normalizeUserStatus, MAX_STATUS_LENGTH, activeUserStatus, validStatusDuration } from "@/lib/user-status";
import type { MeResponse } from "@/lib/check-in-contract";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./status-editor.module.css";
import glass from "./glass-dialog.module.css";
import action from "./glass-action.module.css";

const STATUS_PRESETS = ["Дома", "Гуляю", "Учусь", "На работе", "В дороге", "В зале", "Отдыхаю", "Сплю"] as const;

const DURATION_OPTIONS = [[60, "1 час"], [120, "2 часа"], [240, "4 часа"], [480, "8 часов"], [1440, "24 часа"]] as const;

export function StatusEditor({ me, nowMs, isOnline, onUpdated, onSessionLost, onOpenChange }: {
  me: MeResponse; nowMs: number; isOnline: boolean; onUpdated: (me: MeResponse) => void; onSessionLost: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  function changeOpen(value: boolean) { setOpen(value); onOpenChange?.(value); }
  const [draft, setDraft] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const currentStatus = activeUserStatus(me.status, nowMs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; duration: number | null; key: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const normalized = normalizeUserStatus(draft);
  async function save() {
    if (saving || normalized === null || !isOnline) return;
    setSaving(true); setError(null);
    const savedDuration = normalized ? duration : null;
    if (!pending.current || pending.current.text !== normalized || pending.current.duration !== savedDuration) {
      pending.current = { text: normalized, duration: savedDuration, key: createUuidV4() };
    }
    try {
      onUpdated(await updateMyStatus(normalized, pending.current.key, savedDuration));
      pending.current = null; changeOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError(cause instanceof Error ? cause.message : "Не удалось сохранить статус");
    } finally { setSaving(false); }
  }
  return <>
    <button ref={trigger} type="button" className={`${action.button} ${styles.trigger}`} onClick={() => {
      setDraft(currentStatus?.text ?? "");
      const existingDuration = currentStatus?.expiresAt ? Math.round((Date.parse(currentStatus.expiresAt) - Date.parse(currentStatus.updatedAt)) / 60_000) : null;
      setDuration(validStatusDuration(existingDuration) ? existingDuration ?? null : null);
      setError(null); changeOpen(true);
    }} aria-label={currentStatus ? "Изменить статус" : "Добавить статус"}>
      <MessageCircle size={20} aria-hidden="true" /><span>{currentStatus?.text || "Добавить статус"}</span>
    </button>
    <Dialog open={open} onOpenChange={(value) => { if (!saving) changeOpen(value); }}>
      <DialogContent className={`${glass.dialog} ${styles.dialog}`}
        onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
        <DialogHeader><DialogTitle ref={heading} tabIndex={-1} className={glass.title}><MessageCircle size={22} aria-hidden="true" />Мой статус</DialogTitle><DialogDescription>
          Выберите вариант или напишите свой. Статус виден тем, кому разрешён показ ваших отметок.
        </DialogDescription></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label htmlFor="user-status">Статус</label>
          <input id="user-status" value={draft} onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_STATUS_LENGTH * 2} placeholder="Например, гуляю" autoComplete="off" disabled={saving}
            aria-describedby="status-hint" aria-invalid={normalized === null} />
          <p id="status-hint" className={styles.hint}><span data-invalid={normalized === null}>{Array.from(draft).length}/{MAX_STATUS_LENGTH}</span>Пустое поле убирает статус.</p>
          <fieldset className={styles.presets} disabled={saving}>
            <legend>Быстрый выбор</legend>
            <div>
              {STATUS_PRESETS.map((status) => (
                <button key={status} type="button" aria-pressed={normalized === status}
                  onClick={() => { setDraft(status); setError(null); }}>
                  {status}
                </button>
              ))}
            </div>
          </fieldset>
          <div className={styles.durationRow}>
            <label htmlFor="status-duration">Срок статуса</label>
            <Select value={duration === null ? "none" : String(duration)} disabled={saving}
              onValueChange={value => { setDuration(value === "none" ? null : Number(value)); setError(null); }}>
              <SelectTrigger id="status-duration" className={styles.durationTrigger}><SelectValue /></SelectTrigger>
              <SelectContent className={styles.durationMenu} position="popper">
                <SelectItem value="none">Без ограничения</SelectItem>
                {DURATION_OPTIONS.map(([minutes, label]) => <SelectItem key={minutes} value={String(minutes)}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!isOnline && <p role="status">Для сохранения нужен интернет. Текст останется в этом окне.</p>}
          {normalized === null && <p role="alert">Сократите статус до {MAX_STATUS_LENGTH} символов и уберите управляющие символы.</p>}
          <TransientNotice message={error} kind="error" />
          <button type="submit" disabled={saving || !isOnline || normalized === null}>{saving ? "Сохраняем…" : "Сохранить статус"}</button>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
