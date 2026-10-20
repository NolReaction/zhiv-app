"use client";

import { useState } from "react";
import { Ghost, MapPin, ShieldCheck } from "lucide-react";
import type { PeopleResponse } from "@/lib/check-in-contract";
import { personDisplayName } from "@/lib/person-nickname";
import type { EarthSharingDuration, EarthSharingPrecision } from "@/lib/earth-sharing-contract";
import type { useEarthSharing } from "./use-earth-sharing";
import styles from "./earth-sharing-panel.module.css";

export type EarthSharingHandle = ReturnType<typeof useEarthSharing>;
export type EarthSharingChoices = { recipientCircleIds: string[]; precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };

export function sharingSummary(sharing: Pick<EarthSharingHandle, "settings" | "pendingGhost" | "publishing" | "lastPublishedAt">) {
  if (sharing.pendingGhost) return "Останавливаем передачу…";
  if (!sharing.settings) return "Доступ к геопозиции";
  if (sharing.settings.mode === "GHOST") return "Режим призрака";
  if (sharing.settings.mode === "OFF") return "Только я";
  return sharing.publishing ? sharing.lastPublishedAt ? `Делюсь · ${sharing.settings.recipientCircleIds.length}` : "Ожидаем GPS" : "Обновление на паузе";
}

export function EarthSharingPanel({ sharing, people, peopleLoading, online, onShare, onGhost, onOff }: {
  sharing: EarthSharingHandle; people: PeopleResponse | null; peopleLoading: boolean; online: boolean;
  onShare: (choices: EarthSharingChoices) => Promise<void>; onGhost: () => void; onOff: () => void;
}) {
  const settings = sharing.settings;
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(() => ({ revision: settings?.revision ?? null,
    recipientCircleIds: settings?.recipientCircleIds ?? [], precision: settings?.precision ?? "APPROXIMATE" as EarthSharingPrecision,
    durationMinutes: 60 as EarthSharingDuration }));
  if (settings && draft.revision !== settings.revision) setDraft({ revision: settings.revision,
    recipientCircleIds: settings.recipientCircleIds, precision: settings.precision, durationMinutes: 60 });
  const selected = new Set(draft.recipientCircleIds);
  const friends = people?.people ?? [];
  const known = new Set(friends.map(person => person.circleId));
  const chosen = draft.recipientCircleIds.filter(id => known.has(id));
  const search = query.trim().toLocaleLowerCase("ru-RU");
  const matching = friends.filter(person => !search || personDisplayName(person).toLocaleLowerCase("ru-RU").includes(search));
  const displayed = matching.slice(0, 100);
  const active = settings?.mode === "SHARING";
  const busy = sharing.saving;

  return <div className={styles.panel}>
    <section className={styles.status} aria-labelledby="earth-sharing-status">
      <div><Ghost size={20} aria-hidden="true" /><strong id="earth-sharing-status">{sharingSummary(sharing)}</strong></div>
      <p>Разрешение браузера и доступ друзей — разные настройки. Кнопка «Найти себя» сама по себе не открывает друзьям вашу геопозицию.</p>
      {sharing.pendingGhost && <p role="status" className={styles.pending}>{sharing.pendingPrivacyMode === "OFF"
        ? "Отправка на этом устройстве остановлена. Удаление точки и доступа на сервере ещё не подтверждено. Без сети последняя точка может оставаться до 24 часов после обновления, в пределах выбранного срока доступа."
        : "Отправка на этом устройстве остановлена. Режим призрака на сервере ещё не подтверждён. Последняя точка остаётся у ранее выбранных близких в пределах срока доступа, максимум на 24 часа после обновления."}</p>}
      {active && !sharing.pendingGhost && <>
        <p>{sharing.publishing ? "Позиция обновляется, пока открыта карта." : "Доступ настроен, но GPS сейчас не публикуется. Для возобновления подтвердите настройки ниже."}</p>
        {settings.sharingUntil && <p>Доступ до {new Date(settings.sharingUntil).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</p>}
      </>}
      <button className={styles.ghostButton} type="button" onClick={onGhost}><Ghost size={17} aria-hidden="true" />Включить режим призрака</button>
      <p className={styles.quiet}>Без уведомлений и статуса призрака для друзей. Они видят последнюю геопозицию и время её обновления, как при отсутствии сети. Точка сохраняется до 24 часов после обновления, в пределах выбранного срока доступа. GPS и передача автоматически не возобновляются.</p>
    </section>

    {sharing.error && <p className={styles.error} role="status">{sharing.error}<button type="button" disabled={!online || busy} onClick={sharing.refresh}>Обновить настройки</button></p>}
    {sharing.loading && !settings && <p role="status">Проверяем доступ к геопозиции…</p>}

    <form onSubmit={event => {
      event.preventDefault();
      if (!settings || !online || busy || chosen.length === 0) return;
      void onShare({ recipientCircleIds: chosen, precision: draft.precision, durationMinutes: draft.durationMinutes });
    }}>
      <fieldset disabled={busy}>
        <legend>Кому разрешить</legend>
        <p>Только выбранным близким. Новые друзья не получают доступ автоматически. Выбор применится после подтверждения ниже.</p>
        {peopleLoading && !people && <p role="status">Загружаем близких…</p>}
        {friends.length > 0 ? <>
          {friends.length > 8 && <label className={styles.search}>Найти близкого<input type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" /></label>}
          <div className={styles.recipients}>
            {displayed.map(person => <label key={person.circleId}>
              <input type="checkbox" checked={selected.has(person.circleId)} disabled={!selected.has(person.circleId) && chosen.length >= 100}
                onChange={event => {
                  const checked = event.target.checked;
                  setDraft(value => ({ ...value, recipientCircleIds: checked
                    ? [...value.recipientCircleIds.filter(id => id !== person.circleId), person.circleId]
                    : value.recipientCircleIds.filter(id => id !== person.circleId) }));
                }} />
              <span>{personDisplayName(person)}</span>
            </label>)}
          </div>
          {matching.length > displayed.length && <p>Показаны первые 100. Уточните поиск.</p>}
          {matching.length === 0 && <p>Никого не нашли.</p>}
        </> : !peopleLoading && <p>Сначала добавьте близких в разделе «Люди».</p>}
      </fieldset>

      <fieldset disabled={busy} className={styles.precision}>
        <legend>Точность</legend>
        <label><input type="radio" name="earth-sharing-precision" value="APPROXIMATE" checked={draft.precision === "APPROXIMATE"}
          onChange={() => setDraft(value => ({ ...value, precision: "APPROXIMATE" }))} /><span><strong>Примерный район</strong><small>Округляем координаты до отправки. Область около 1,5 км или шире при слабом GPS.</small></span></label>
        <label><input type="radio" name="earth-sharing-precision" value="PRECISE" checked={draft.precision === "PRECISE"}
          onChange={() => setDraft(value => ({ ...value, precision: "PRECISE" }))} /><span><strong>Точная геопозиция</strong><small>С точностью, которую определяет устройство.</small></span></label>
      </fieldset>

      <label className={styles.duration}>На сколько
        <select value={draft.durationMinutes === null ? "forever" : String(draft.durationMinutes)} disabled={busy}
          onChange={event => setDraft(value => ({ ...value, durationMinutes: event.target.value === "forever" ? null : Number(event.target.value) as 60 | 480 }))}>
          <option value="60">На 1 час</option><option value="480">На 8 часов</option><option value="forever">Пока не выключу</option>
        </select>
      </label>
      <p className={styles.explanation}><ShieldCheck size={16} aria-hidden="true" />Храним только последнюю точку, без маршрута и истории. В фоне GPS не работает. Последняя геопозиция доступна до 24 часов после обновления, но не дольше выбранного срока. Полностью убрать её можно кнопкой выключения доступа.</p>
      <button className={styles.shareButton} type="submit" disabled={!settings || !online || busy || sharing.pendingGhost || chosen.length === 0}>
        <MapPin size={17} aria-hidden="true" />{busy ? "Сохраняем…" : active ? "Подтвердить и обновлять позицию" : "Разрешить выбранным и включить GPS"}
      </button>
      {!online && <p role="status">Для включения доступа нужна сеть. Скрыться можно и без неё.</p>}
    </form>
    {(settings?.recipientCircleIds.length ?? 0) > 0 && <button className={styles.removeButton} type="button" onClick={onOff}>Выключить доступ и удалить разрешения</button>}
  </div>;
}
