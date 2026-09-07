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

const STATUS_PRESETS = ["Дома", "Гуляю", "Учусь", "На работе", "В дороге", "В зале", "Отдыхаю", "Сплю"] as const;

const DURATION_OPTIONS = [[60, "1 час"], [120, "2 часа"], [240, "4 часа"], [480, "8 часов"], [1440, "24 часа"]] as const;

export function StatusEditor({ me, nowMs, isOnline, onUpdated, onSessionLost }: {
  me: MeResponse; nowMs: number; isOnline: boolean; onUpdated: (me: MeResponse) => void; onSessionLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const currentStatus = activeUserStatus(me.status, nowMs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; duration: number | null; key: string } | null>(null);
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
      pending.current = null; setOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError(cause instanceof Error ? cause.message : "Не удалось сохранить статус");
    } finally { setSaving(false); }
  }
  return <>
    <button type="button" className={styles.trigger} onClick={() => {
      setDraft(currentStatus?.text ?? "");
      const existingDuration = currentStatus?.expiresAt ? Math.round((Date.parse(currentStatus.expiresAt) - Date.parse(currentStatus.updatedAt)) / 60_000) : null;
      setDuration(validStatusDuration(existingDuration) ? existingDuration ?? null : null);
      setError(null); setOpen(true);
    }} aria-label={currentStatus ? "Изменить статус" : "Добавить статус"}>
      <MessageCircle size={18} /><span>{currentStatus?.text || "Добавить статус"}</span>
    </button>
    <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
      <DialogContent className={styles.dialog}>
        <DialogHeader><DialogTitle>Мой статус</DialogTitle><DialogDescription>
          Выберите готовый вариант или напишите свой. Статус увидят те, кому вы разрешили показ. Он не заменяет отметку «Я живой».
        </DialogDescription></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label htmlFor="user-status">Статус</label>
          <input id="user-status" value={draft} onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_STATUS_LENGTH * 2} placeholder="Например, гуляю" autoComplete="off" disabled={saving}
            aria-describedby="status-hint" aria-invalid={normalized === null} />
          <p id="status-hint">{Array.from(draft).length}/{MAX_STATUS_LENGTH}. Оставьте поле пустым, чтобы убрать статус.</p>
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
          {normalized === null && <p role="alert">До 120 символов, без управляющих символов.</p>}
          <TransientNotice message={error} kind="error" />
          <button type="submit" disabled={saving || !isOnline || normalized === null}>{saving ? "Сохраняем…" : "Сохранить статус"}</button>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
