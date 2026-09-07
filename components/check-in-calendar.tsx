"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check, Flame, RefreshCw } from "lucide-react";
import { ru } from "react-day-picker/locale";
import { Calendar } from "./ui/calendar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { ApiError, getCheckInCalendar } from "@/lib/check-in-api";
import type { CheckInCalendarResponse, DailyStreak } from "@/lib/check-in-contract";
import { calendarCountLabel, calendarDate, calendarDateKey } from "@/lib/check-in-calendar";
import { formatDayCount } from "@/lib/daily-streak";
import styles from "./check-in-calendar.module.css";

export function CheckInCalendar({ open, onOpenChange, streak, lastCheckInAt, onSessionLost, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; streak: DailyStreak;
  lastCheckInAt: string | null; onSessionLost: () => void; returnFocus: () => void;
}) {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<CheckInCalendarResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [loadedCheckInAt, setLoadedCheckInAt] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    // The timeout remains bounded even though this request is also abortable on close.
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    void getCheckInCalendar(month, controller.signal).then(result => {
      if (!active) return;
      setData(result);
      setLoadedCheckInAt(lastCheckInAt);
      setError("");
      setSelected(previous => previous?.startsWith(`${result.month}-`) ? previous
        : result.today.startsWith(`${result.month}-`) ? result.today : `${result.month}-01`);
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) { onOpenChange(false); onSessionLost(); }
      else setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить отметки. Проверьте соединение и повторите.");
    }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [open, month, reload, lastCheckInAt, onOpenChange, onSessionLost]);

  const visible = data && (!month || data.month === month) ? data : null;
  const counts = new Map(visible?.days.map(day => [day.date, day.count]) ?? []);
  const selectedCount = selected ? counts.get(selected) ?? 0 : 0;
  const pending = loading || !visible || loadedCheckInAt !== lastCheckInAt;
  const displayedMonth = month ?? data?.month;
  const changeMonth = (next: string | null) => { setLoading(true); setError(""); setMonth(next); };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); setLoading(true); setError(""); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle className={styles.title}><CalendarDays size={22} aria-hidden="true" /> Мои отметки</DialogTitle>
        <DialogDescription>Дни, в которые вы отмечались. Этот календарь виден только вам.</DialogDescription>
      </DialogHeader>
      <div className={styles.streak}><Flame size={20} aria-hidden="true" /><strong>{formatDayCount(streak.currentDays)} подряд</strong><span>Лучшая серия · {formatDayCount(streak.longestDays)}</span></div>
      {!data ? error ? <div className={styles.message} role="status"><p>{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); setReload(value => value + 1); }}><RefreshCw size={18} aria-hidden="true" /> Повторить</button></div>
        : <div className={styles.loading} role="status"><CalendarDays size={28} aria-hidden="true" /><span>Загружаем календарь…</span></div>
        : <div className={styles.monthContent}>
          <Calendar className={styles.calendar} locale={ru} timeZone="UTC" mode="single" required
            weekStartsOn={1} fixedWeeks showOutsideDays={false}
            today={calendarDate(data.today)} month={calendarDate(displayedMonth!)}
            startMonth={calendarDate(data.firstMonth)} endMonth={calendarDate(data.today.slice(0, 7))}
            selected={selected?.startsWith(`${displayedMonth}-`) ? calendarDate(selected) : undefined}
            onSelect={date => setSelected(date ? calendarDateKey(date) : null)}
            onMonthChange={date => changeMonth(calendarDateKey(date).slice(0, 7))}
            disabled={{ after: calendarDate(data.today) }}
            modifiers={{ marked: !pending && !error && visible ? visible.days.map(day => calendarDate(day.date)) : [] }}
            modifiersClassNames={{ marked: styles.marked }}
            labels={{ labelDayButton: (date, modifiers) => `${date.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}${modifiers.today ? ", сегодня" : ""}, ${error ? "отметки не загружены" : pending ? "загружаем отметки" : calendarCountLabel(counts.get(calendarDateKey(date)) ?? 0)}` }}
          />
          <div className={styles.monthSummary} key={displayedMonth}>
          {error ? <div className={styles.message} role="status"><p>{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); setReload(value => value + 1); }}><RefreshCw size={18} aria-hidden="true" /> Повторить</button></div>
            : pending ? <p className={styles.monthTotal} role="status">Загружаем отметки…</p> : <>
            <div className={styles.dayDetail} role="status" aria-live="polite">
              <span>{selected ? calendarDate(selected).toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }) : "Выберите день"}</span>
              <strong>{selectedCount > 0 ? <><Check size={17} aria-hidden="true" /> {calendarCountLabel(selectedCount)}</> : "Нет отметок"}</strong>
            </div>
            <p className={styles.monthTotal}>{visible!.days.length ? `${calendarCountLabel(visible!.days.reduce((sum, day) => sum + day.count, 0))} за месяц` : "В этом месяце вы ещё не отмечались"}</p>
          </>}
          </div>
          {displayedMonth !== data.today.slice(0, 7) && <button type="button" className={styles.todayButton} onClick={() => changeMonth(null)}>К текущему месяцу</button>}
        </div>}
      <p className={styles.hint}>Серия продолжается, если между отметками не больше 24 часов. Дни показаны по времени, сохранённому при отметке.</p>
    </DialogContent>
  </Dialog>;
}
