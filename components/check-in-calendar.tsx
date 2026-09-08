"use client";

import { useEffect, useState } from "react";
import { GAME_ITEMS, type GameItemId } from "@/lib/game-rewards";
import { CalendarDays, Check, ChevronDown, Flame, Gift, RefreshCw } from "lucide-react";
import { ru } from "react-day-picker/locale";
import { Calendar } from "./ui/calendar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { ApiError, getCheckInCalendar } from "@/lib/check-in-api";
import type { CheckInCalendarResponse, DailyStreak } from "@/lib/check-in-contract";
import { calendarCountLabel, calendarDate, calendarDateKey, calendarRefreshDelay, calendarRewardForecast } from "@/lib/check-in-calendar";
import { formatDayCount } from "@/lib/daily-streak";
import styles from "./check-in-calendar.module.css";

export function CheckInCalendar({ open, onOpenChange, streak, lastCheckInAt, timeZone, onSessionLost, returnFocus, items = [] }: {
  items?: readonly GameItemId[];
  open: boolean; onOpenChange: (open: boolean) => void; streak: DailyStreak;
  lastCheckInAt: string | null; timeZone: string; onSessionLost: () => void; returnFocus: () => void;
}) {
  const ownedKey = items.join(",");
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
      const rewards = calendarRewardForecast(result, ownedKey.split(",") as GameItemId[], streak.longestDays);
      const lastMonth = [result.lastMonth, ...rewards.map(item => item.date.slice(0, 7))].sort().at(-1)!;
      if (result.month < result.firstMonth || result.month > lastMonth) {
        setMonth(result.month < result.firstMonth ? result.firstMonth : lastMonth);
        return;
      }
      setData(result);
      setLoadedCheckInAt(lastCheckInAt);
      setError("");
      setSelected(previous => previous?.startsWith(`${result.month}-`)
        && (previous <= result.today || result.days.some(day => day.date === previous) || rewards.some(item => item.date === previous)) ? previous
        : result.today.startsWith(`${result.month}-`) ? result.today : result.days[0]?.date ?? rewards.find(item => item.date.startsWith(`${result.month}-`))?.date ?? (result.month < result.today.slice(0, 7) ? `${result.month}-01` : null));
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) { onOpenChange(false); onSessionLost(); }
      else setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить отметки. Проверьте соединение и повторите.");
    }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [open, month, reload, lastCheckInAt, timeZone, ownedKey, streak.longestDays, streak.renewBy, onOpenChange, onSessionLost]);

  useEffect(() => {
    if (!open || !data) return;
    const refresh = () => {
      if (document.hidden) return;
      setLoading(true); setError(""); setReload(value => value + 1);
    };
    const timer = window.setTimeout(refresh, calendarRefreshDelay(data.serverTime, data.nextDayAt));
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [open, data]);

  const visible = data && (!month || data.month === month) ? data : null;
  const counts = new Map(visible?.days.map(day => [day.date, day.count]) ?? []);
  const selectedCount = selected ? counts.get(selected) ?? 0 : 0;
  const pending = loading || !visible || loadedCheckInAt !== lastCheckInAt || data?.timeZone !== timeZone;
  const rewards = data ? calendarRewardForecast(data, items, streak.longestDays) : [];
  const rewardDates = new Set(rewards.map(item => item.date));
  const lastMonth = data ? [data.lastMonth, ...rewards.map(item => item.date.slice(0, 7))].sort().at(-1)! : null;
  const selectedRewards = rewards.filter(item => item.date === selected);
  const displayedMonth = month ?? data?.month;
  const changeMonth = (next: string | null) => { setLoading(true); setError(""); setMonth(next); };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); setLoading(true); setError(""); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle className={styles.title}><CalendarDays size={22} aria-hidden="true" /> Мои отметки</DialogTitle>
        <DialogDescription>Ваш личный календарь отметок.</DialogDescription>
      </DialogHeader>
      <div className={styles.streak}><Flame size={20} aria-hidden="true" /><strong>{formatDayCount(streak.currentDays)} подряд</strong><span>Лучшая серия · {formatDayCount(streak.longestDays)}</span>
        {streak.isActive && streak.renewBy && <p className={styles.renewal}>Продлите до {new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(Date.parse(streak.renewBy))}</p>}
      </div>
      <Collapsible className={styles.rewards}>
        <CollapsibleTrigger className={styles.rewardsTrigger}><Gift size={17} aria-hidden="true" /> Подарки Мохлику <ChevronDown size={17} aria-hidden="true" /></CollapsibleTrigger>
        <CollapsibleContent className={styles.rewardsContent}>
        <p>За 3, 7, 14 и 30 дней подряд. Полученные предметы остаются навсегда.</p>
        <ol>{GAME_ITEMS.map(item => {
          const earned = streak.longestDays >= item.days || items.includes(item.id);
          const remaining = Math.max(0, item.days - (streak.isActive ? streak.currentDays : 0));
          const forecast = rewards.find(reward => reward.id === item.id);
          return <li key={item.id} data-earned={earned || undefined}>
            <span className={styles.rewardDay}>{earned ? <Check size={16} aria-hidden="true" /> : <Gift size={16} aria-hidden="true" />} {item.days}-й день</span>
            <strong>{item.title}</strong><small>{earned ? "Получено" : forecast ? forecast.due ? "При следующей отметке" : calendarDate(forecast.date).toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }) : `Ещё ${formatDayCount(remaining)} в серии`}</small>
          </li>;
        })}</ol>
        <p>{data?.streakStartedAt ? "Даты рассчитаны при сохранении серии." : "Даты рассчитаны, если начать серию сегодня."} Для получения подарка нужна отметка.</p>
        </CollapsibleContent>
      </Collapsible>
      {!data ? error ? <div className={styles.message} role="status"><p>{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); setReload(value => value + 1); }}><RefreshCw size={18} aria-hidden="true" /> Повторить</button></div>
        : <div className={styles.loading} role="status"><CalendarDays size={28} aria-hidden="true" /><span>Загружаем календарь…</span></div>
        : <div className={styles.monthContent}>
          <Calendar className={styles.calendar} locale={ru} timeZone="UTC" mode="single" required
            weekStartsOn={1} showOutsideDays={false}
            today={calendarDate(data.today)} month={calendarDate(displayedMonth!)}
            startMonth={calendarDate(data.firstMonth)} endMonth={calendarDate(lastMonth!)}
            selected={selected?.startsWith(`${displayedMonth}-`) ? calendarDate(selected) : undefined}
            onSelect={date => setSelected(date ? calendarDateKey(date) : null)}
            onMonthChange={date => changeMonth(calendarDateKey(date).slice(0, 7))}
            disabled={date => calendarDateKey(date) > data.today && (pending || error !== "" || (!counts.has(calendarDateKey(date)) && !rewardDates.has(calendarDateKey(date))))}
            modifiers={{ marked: !pending && !error && visible ? visible.days.map(day => calendarDate(day.date)) : [], reward: !pending && !error ? [...rewardDates].map(calendarDate) : [] }}
            modifiersClassNames={{ marked: styles.marked, reward: styles.rewardDate }}
            labels={{ labelDayButton: (date, modifiers) => `${date.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}${modifiers.today ? ", сегодня" : ""}, ${error ? "отметки не загружены" : pending ? "загружаем отметки" : calendarCountLabel(counts.get(calendarDateKey(date)) ?? 0)}${!pending && !error && modifiers.reward ? `, ожидаемый подарок: ${rewards.filter(item => item.date === calendarDateKey(date)).map(item => item.title).join(", ")}` : ""}` }}
          />
          {!pending && !error && rewards.length > 0 && <p className={styles.rewardLegend}><span aria-hidden="true" />Обведены дни подарков {data.streakStartedAt ? "при сохранении серии" : "при начале серии сегодня"}.</p>}
          <div className={styles.monthSummary} key={displayedMonth}>
          {error ? <div className={styles.message} role="status"><p>{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); setReload(value => value + 1); }}><RefreshCw size={18} aria-hidden="true" /> Повторить</button></div>
            : pending ? <p className={styles.monthTotal} role="status">Загружаем отметки…</p> : <>
            <div className={styles.dayDetail} role="status" aria-live="polite">
              <span>{selected ? calendarDate(selected).toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }) : "Выберите день"}</span>
              <strong>{selectedCount > 0 ? <><Check size={17} aria-hidden="true" /> {calendarCountLabel(selectedCount)}</> : "Нет отметок"}</strong>
            </div>
            {selectedRewards.map(item => <p key={item.id} className={styles.selectedGift}><Gift size={16} aria-hidden="true" /><span>{item.title} · {item.due ? "при следующей отметке" : item.active ? "при сохранении серии" : "если начать серию сегодня"}</span></p>)}
            <p className={styles.monthTotal}>{visible!.days.length ? `Дней с отметками за месяц: ${visible!.days.length}` : "В этом месяце ещё нет отметок"}</p>
          </>}
          </div>
          {displayedMonth !== data.today.slice(0, 7) && <button type="button" className={styles.todayButton} onClick={() => changeMonth(null)}>К текущему месяцу</button>}
        </div>}
      <details className={styles.hint}>
        <summary>Как считается серия?</summary>
        <p>Первая отметка — день 1. Отметка через 24 часа от начала серии даёт день 2, через 48 часов — день 3, и так далее. Между соседними отметками должно быть не больше 24 часов. Поэтому число дней серии может отличаться от отмеченных дат.</p>
        <p>Серия считается по времени сервера. Перевод часов и смена часового пояса её не увеличивают.</p>
      </details>
      <p className={styles.timeZone}>Часовой пояс: {timeZone.replaceAll("_", " ")}. Прежние даты сохраняются.</p>
    </DialogContent>
  </Dialog>;
}
