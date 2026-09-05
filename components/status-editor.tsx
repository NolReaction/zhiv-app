"use client";

import { useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ApiError, updateMyStatus } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { normalizeUserStatus, MAX_STATUS_LENGTH } from "@/lib/user-status";
import type { MeResponse } from "@/lib/check-in-contract";
import styles from "./status-editor.module.css";

export function StatusEditor({ me, isOnline, onUpdated, onSessionLost }: {
  me: MeResponse; isOnline: boolean; onUpdated: (me: MeResponse) => void; onSessionLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; key: string } | null>(null);
  const normalized = normalizeUserStatus(draft);
  async function save() {
    if (saving || normalized === null || !isOnline) return;
    setSaving(true); setError(null);
    if (pending.current?.text !== normalized) pending.current = { text: normalized, key: createUuidV4() };
    try {
      onUpdated(await updateMyStatus(normalized, pending.current.key));
      pending.current = null; setOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError(cause instanceof Error ? cause.message : "Не удалось сохранить статус");
    } finally { setSaving(false); }
  }
  return <>
    <button type="button" className={styles.trigger} onClick={() => {
      setDraft(me.status?.text ?? ""); setError(null); setOpen(true);
    }} aria-label={me.status ? "Изменить статус" : "Добавить статус"}>
      <MessageCircle size={18} /><span>{me.status?.text || "Добавить статус"}</span>
    </button>
    <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
      <DialogContent className={styles.dialog}>
        <DialogHeader><DialogTitle>Мой статус</DialogTitle><DialogDescription>
          Напишите, чем заняты: гуляю, учусь, дома. Статус увидят те, кому вы разрешили показ. Он не заменяет отметку «Я живой».
        </DialogDescription></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label htmlFor="user-status">Статус</label>
          <input id="user-status" value={draft} onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_STATUS_LENGTH * 2} placeholder="Например, гуляю" autoComplete="off" disabled={saving}
            aria-describedby="status-hint" aria-invalid={normalized === null} />
          <p id="status-hint">{Array.from(draft).length}/{MAX_STATUS_LENGTH}. Оставьте поле пустым, чтобы убрать статус.</p>
          {!isOnline && <p role="status">Для сохранения нужен интернет. Текст останется в этом окне.</p>}
          {normalized === null && <p role="alert">До 120 символов, без управляющих символов.</p>}
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={saving || !isOnline || normalized === null}>{saving ? "Сохраняем…" : "Сохранить статус"}</button>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
