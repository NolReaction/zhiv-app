"use client";

import { useMemo, useRef, useState } from "react";
import { ApiError, updateMyTimeZone } from "@/lib/check-in-api";
import type { MeResponse } from "@/lib/check-in-contract";
import { deviceTimeZone, timeZoneOptions } from "@/lib/time-zone";
import { createUuidV4 } from "@/lib/browser-uuid";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import styles from "./profile-view.module.css";

export function TimeZoneSetting({ me, isOnline, onUpdated, onSessionLost }: {
  me: MeResponse; isOnline: boolean; onUpdated: (value: MeResponse) => void; onSessionLost: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<{ zone: string; key: string } | null>(null);
  const zone = draft ?? me.profile.timeZone;
  const options = useMemo(() => timeZoneOptions(zone), [zone]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !isOnline || zone === me.profile.timeZone) return;
    setPending(true); setMessage("");
    if (request.current?.zone !== zone) request.current = { zone, key: createUuidV4() };
    try {
      const result = await updateMyTimeZone(zone, request.current.key);
      onUpdated(result); setDraft(null); request.current = null;
      setMessage("Часовой пояс сохранён");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else setMessage(error instanceof Error ? error.message : "Не удалось сохранить часовой пояс");
    } finally { setPending(false); }
  }

  return <form className={styles.timeZoneForm} onSubmit={event => void save(event)}>
    <label htmlFor="profile-time-zone">Часовой пояс календаря</label>
    <NativeSelect id="profile-time-zone" value={zone} disabled={pending} onChange={event => { setDraft(event.target.value); setMessage(""); }}>
      {options.map(value => <NativeSelectOption key={value} value={value}>{value.replaceAll("_", " ")}</NativeSelectOption>)}
    </NativeSelect>
    <div className={styles.timeZoneActions}>
      <button type="button" disabled={pending} onClick={() => { setDraft(deviceTimeZone()); setMessage(""); }}>Как на устройстве</button>
      <button type="submit" disabled={pending || !isOnline || zone === me.profile.timeZone}>{pending ? "Сохраняем…" : "Сохранить"}</button>
    </div>
    <p>Применяется к новым отметкам. Прежние даты и серия сохраняются.</p>
    {message && <p role="status">{message}</p>}
  </form>;
}
