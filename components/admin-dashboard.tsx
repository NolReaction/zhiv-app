"use client";

import Link from "next/link";
import { AdminRewardsDialog } from "./admin-rewards-dialog";
import { GAME_ITEMS, GAME_ACHIEVEMENTS } from "@/lib/game-rewards";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleAlert,
  Clock3, Cpu, Database, Gift, HeartPulse, LayoutDashboard, LoaderCircle,
  LogOut, Search, Server, ShieldCheck, ShieldX, Terminal, Trophy, Users,
} from "lucide-react";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  getAdminAccess, getAdminAudit, getAdminMonitoring, getAdminOverview, getAdminUsers,
  revokeAdminSessions,
  type AdminAccess, type AdminAudit, type AdminMonitoring, type AdminOverview,
  type AdminUser, type AdminUsers,
} from "@/lib/admin-api";
import styles from "./admin-dashboard.module.css";

type AdminTab = "overview" | "users" | "monitoring" | "audit";
type UserSort = "created" | "activity" | "taps";
type AccessStatus = "loading" | "allowed" | "signed-out" | "forbidden" | "error";
type Snapshot<T> = { key: string; value: T };
type Revocation = { target: AdminUser; requestId: string | null; confirmation: string; reason: string };

const PAGE_SIZE = 25;
const REFRESH_MS = 30_000;
const numberFormatter = new Intl.NumberFormat("ru-RU");
const decimalFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const chartColors = { checkIns: "#b9d99c", activeUsers: "#7fb8e6", registrations: "#d9bd79" };
const chartTooltipStyle = {
  background: "#20251f", border: "1px solid #46513e", borderRadius: 12,
  color: "#f1f4eb", fontSize: 14,
};

function count(value: number | null | undefined) {
  return value == null ? "—" : numberFormatter.format(value);
}
function decimal(value: number | null | undefined) {
  return value == null ? "—" : decimalFormatter.format(value);
}
function percent(value: number | null | undefined) {
  return value == null ? "—" : `${decimalFormatter.format(value)}%`;
}
function bytes(value: number | null | undefined) {
  if (value == null) return "—";
  if (value < 1024) return `${count(value)} Б`;
  const units = ["КиБ", "МиБ", "ГиБ", "ТиБ"];
  let result = value / 1024;
  let unit = 0;
  while (result >= 1024 && unit < units.length - 1) { result /= 1024; unit += 1; }
  return `${decimal(result)} ${units[unit]}`;
}
function time(value: string | null | undefined, full = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC", day: "2-digit", month: "short", ...(full ? { year: "numeric" as const } : {}),
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}
function chartDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" })
    .format(new Date(`${value}T00:00:00Z`));
}
function chartTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })
    .format(new Date(value));
}
function isAccessError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "Не удалось получить данные. Проверьте соединение и повторите запрос.";
}

function Metric({ label, value, note, icon, tone }: {
  label: string; value: ReactNode; note?: ReactNode; icon?: ReactNode; tone?: "warning" | "good";
}) {
  return (
    <div className={styles.metric} data-tone={tone}>
      <div className={styles.metricLabel}>{label}{icon}</div>
      <strong className={styles.metricValue}>{value}</strong>
      {note != null && <div className={styles.metricNote}>{note}</div>}
    </div>
  );
}
function SectionHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className={styles.sectionHeading}><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
function Pagination({ total, offset, busy, onChange }: {
  total: number; offset: number; busy: boolean; onChange: (offset: number) => void;
}) {
  return (
    <div className={styles.pagination}>
      <span>{total === 0 ? "Нет записей" : `${count(offset + 1)}–${count(Math.min(offset + PAGE_SIZE, total))} из ${count(total)}`}</span>
      <div>
        <button type="button" className={styles.iconButton} aria-label="Предыдущая страница"
          disabled={offset === 0 || busy} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={20} /></button>
        <button type="button" className={styles.iconButton} aria-label="Следующая страница"
          disabled={offset + PAGE_SIZE >= total || busy} onClick={() => onChange(offset + PAGE_SIZE)}><ChevronRight size={20} /></button>
      </div>
    </div>
  );
}

function Overview({ data, days }: { data: AdminOverview; days: number }) {
  const retention = [
    { label: "На следующий день", code: "D1", ...data.retention.day1 },
    { label: "Через 7 дней", code: "D7", ...data.retention.day7 },
  ];
  return (
    <div className={styles.stack}>
      <div className={styles.metricGrid}>
        <Metric label="Пользователи" value={count(data.totals.users)} note={`+${count(data.newUsersPeriod)} за ${days} дн.`} icon={<Users size={18} />} />
        <Metric label="Отмечались за 24 часа" value={count(data.active.last24Hours)} note="Уникальные пользователи" icon={<HeartPulse size={18} />} />
        <Metric label="Отмечались за 7 дней" value={count(data.active.last7Days)} note={`${count(data.active.last30Days)} за 30 дней`} icon={<Activity size={18} />} />
        <Metric label="Отметки за период" value={count(data.checkInsPeriod)} note={`${count(data.totals.checkIns)} за всё время`} icon={<Check size={18} />} />
      </div>
      <div className={styles.overviewGrid}>
        <section className={styles.panel}>
          <SectionHeading title="Активность по дням" description="Отметки, уникальные пользователи и регистрации · UTC" />
          {data.daily.length === 0 ? <Empty>За этот период ещё нет данных.</Empty> : <>
            <div className={styles.chart} role="img" aria-label="График отметок, активных пользователей и регистраций. Точные значения доступны в таблице ниже.">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.daily} margin={{ top: 8, right: 12, left: -16, bottom: 4 }} accessibilityLayer>
                  <CartesianGrid stroke="#323a2f" strokeDasharray="3 5" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={chartDate} stroke="#a3af9c" tick={{ fontSize: 14 }} minTickGap={40} tickLine={false} axisLine={false} />
                  <YAxis stroke="#a3af9c" tick={{ fontSize: 14 }} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={chartTooltipStyle} labelFormatter={value => chartDate(String(value))} />
                  <Legend wrapperStyle={{ fontSize: 14, paddingTop: 12 }} />
                  <Line type="monotone" dataKey="checkIns" name="Отметки" stroke={chartColors.checkIns} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="activeUsers" name="Отмечались" stroke={chartColors.activeUsers} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="registrations" name="Регистрации" stroke={chartColors.registrations} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <details className={styles.details}><summary>Значения по дням</summary><Table>
              <TableHeader><TableRow><TableHead>Дата, UTC</TableHead><TableHead>Отметки</TableHead><TableHead>Отмечались</TableHead><TableHead>Регистрации</TableHead></TableRow></TableHeader>
              <TableBody>{data.daily.map(day => <TableRow key={day.date}><TableCell>{day.date}</TableCell><TableCell>{count(day.checkIns)}</TableCell><TableCell>{count(day.activeUsers)}</TableCell><TableCell>{count(day.registrations)}</TableCell></TableRow>)}</TableBody>
            </Table></details>
          </>}
          <p className={styles.footnote}>Активность здесь — сохранённая отметка. Простое открытие приложения не учитывается.</p>
        </section>
        <section className={styles.panel}>
          <SectionHeading title="Возвращаются к отметкам" description="После регистрации · D1 / D7" />
          <div className={styles.retentionList}>{retention.map(item => <div className={styles.retention} key={item.code}>
            <div><span className={styles.retentionCode}>{item.code}</span><span>{item.label}</span></div>
            <strong>{item.rate == null ? "—" : percent(item.rate)}</strong>
            <p>{count(item.returned)} из {count(item.eligible)} пользователей, для которых уже наступил этот день</p>
          </div>)}</div>
          <p className={styles.footnote}>Дни считаются по UTC. Пустое значение означает, что подходящей группы пользователей пока нет.</p>
        </section>
      </div>
      <div className={styles.twoColumns}>
        <section className={styles.panel}>
          <SectionHeading title="Игровой процесс" description={`Месяц ${data.game.month} · подтверждённые результаты`} />
          <div className={styles.statList}>
            <div><span>Тапы за месяц</span><strong>{count(data.game.taps)}</strong></div>
            <div><span>Игроки за месяц</span><strong>{count(data.game.participants)}</strong></div>
            <div><span>Лучшая серия</span><strong>×{count(data.game.bestSeries)}</strong></div>
            <div><span>Открытые достижения</span><strong>{count(data.game.achievements)}</strong></div>
            <div><span>Тапы за всё время</span><strong>{count(data.totals.lifetimeTaps)}</strong></div>
          </div>
        </section>
        <section className={styles.panel}>
          <SectionHeading title="Сообщество и база" description="Текущее состояние приложения" />
          <div className={styles.statList}>
            <div><span>Дружеские связи</span><strong>{count(data.totals.connections)}</strong></div>
            <div><span>Группы</span><strong>{count(data.totals.groups)}</strong></div>
            <div><span>Активные сеансы входа</span><strong>{count(data.services.activeSessions)}</strong></div>
            <div><span>База данных</span><strong className={data.services.databaseReady ? styles.good : styles.warning}>{data.services.databaseReady ? "Доступна" : "Недоступна"}</strong></div>
            <div><span>Размер / подключения БД</span><strong>{bytes(data.services.databaseBytes)} / {count(data.services.databaseConnections)}</strong></div>
          </div>
        </section>
      </div>
    </div>
  );
}

function UsersTable({ data, access, busy, onPage, onRevoke, onRewards }: {
  data: AdminUsers; access: AdminAccess; busy: boolean; onPage: (offset: number) => void; onRevoke: (user: AdminUser) => void; onRewards: (user: AdminUser) => void;
}) {
  return <section className={styles.panel}>
    <SectionHeading title="Пользователи приложения" description="Поиск по имени или ID. Сеансы можно завершить без удаления аккаунта." />
    {data.users.length === 0 ? <Empty>Пользователи не найдены. Попробуйте другое имя или ID.</Empty> : <Table className={styles.userTable}>
      <TableHeader><TableRow><TableHead>Пользователь</TableHead><TableHead>Последняя отметка</TableHead><TableHead>Отметки / друзья</TableHead><TableHead>Игра</TableHead><TableHead>Сеансы</TableHead><TableHead><span className={styles.srOnly}>Действия</span></TableHead></TableRow></TableHeader>
      <TableBody>{data.users.map(user => <TableRow key={user.publicId}>
        <TableCell><div className={styles.userIdentity}><strong>{user.displayName}</strong>{user.isAdmin && <span className={styles.adminBadge}>Админ</span>}</div><code>{user.publicId}</code><small>Создан {time(user.createdAt, true)}</small></TableCell>
        <TableCell>{user.lastCheckInAt ? time(user.lastCheckInAt) : "Ещё не отмечался"}<small>UTC</small></TableCell>
        <TableCell><strong>{count(user.checkInCount)}</strong> отметок<small>{count(user.friendCount)} друзей</small></TableCell>
        <TableCell><strong>{count(user.lifetimeTaps)}</strong> тапов<small>Месяц {count(user.monthlyTaps)} · рекорд ×{count(user.bestSeries)}</small><small>{user.leaderboardOptIn ? "Участвует в рейтинге" : "Рейтинг скрыт"}</small></TableCell>
        <TableCell><strong>{count(user.activeSessions)}</strong><small>{user.loginMethods.length ? user.loginMethods.join(" · ") : "Нет привязанных способов"}</small></TableCell>
        <TableCell><button type="button" className={styles.textButton} disabled={busy} onClick={() => onRewards(user)}><Gift size={16} />Награды</button>{!user.isAdmin && user.publicId !== access.publicId ? <button type="button" className={styles.dangerLink} disabled={user.activeSessions === 0 || busy} onClick={() => onRevoke(user)}><LogOut size={16} />Завершить сеансы</button> : <span className={styles.muted}>Защищённый аккаунт</span>}</TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <Pagination total={data.total} offset={data.offset} busy={busy} onChange={onPage} />
  </section>;
}

function ServerChart({ title, description, samples, metrics, unit }: {
  title: string; description: string; samples: AdminMonitoring["samples"];
  metrics: { key: string; name: string; color: string }[]; unit?: string;
}) {
  return <section className={styles.panel}>
    <SectionHeading title={title} description={description} />
    {!samples.length ? <Empty>Точки графика ещё не получены.</Empty> : <div className={styles.chart} role="img" aria-label={`${title}. ${description}`}>
      <ResponsiveContainer width="100%" height="100%"><LineChart data={samples} margin={{ top: 8, right: 12, left: -12, bottom: 4 }} accessibilityLayer>
        <CartesianGrid stroke="#323a2f" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="at" tickFormatter={chartTime} stroke="#a3af9c" tick={{ fontSize: 14 }} minTickGap={40} tickLine={false} axisLine={false} />
        <YAxis stroke="#a3af9c" tick={{ fontSize: 14 }} tickLine={false} axisLine={false} unit={unit} />
        <Tooltip contentStyle={chartTooltipStyle} labelFormatter={value => `${chartTime(String(value))} UTC`} />
        <Legend wrapperStyle={{ fontSize: 14, paddingTop: 12 }} />
        {metrics.map(metric => <Line key={metric.key} type="monotone" dataKey={metric.key} name={metric.name} stroke={metric.color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer>
    </div>}
  </section>;
}

function Monitoring({ data }: { data: AdminMonitoring }) {
  const summary = data.summary;
  return <div className={styles.stack}>
    {!data.configured ? <div className={styles.notice}><CircleAlert size={20} /><div><strong>Мониторинг ещё не подключён</strong><p>Включите сбор метрик по инструкции развёртывания. Статистика приложения доступна во вкладке «Обзор».</p></div></div>
      : !data.available ? <div className={styles.notice} role="status"><CircleAlert size={20} /><div><strong>Нет связи со сборщиком метрик</strong><p>{data.error || "Проверьте состояние службы мониторинга на сервере."}</p></div></div> : null}
    {data.alerts.length > 0 && <section className={styles.panel}>
      <SectionHeading title="Требует внимания" description="Текущие сигналы мониторинга" />
      <div className={styles.alertList}>{data.alerts.map(alert => <div key={`${alert.name}-${alert.activeAt}`} className={styles.alertItem} data-severity={alert.severity}>
        <CircleAlert size={20} /><div><strong>{alert.summary || alert.name}</strong><p>{alert.severity === "critical" ? "Критический" : "Предупреждение"} · {alert.state === "firing" ? "Условие подтверждено" : "Проверяем длительность"}</p><small>{alert.name}{alert.activeAt ? ` · с ${time(alert.activeAt)} UTC` : ""}</small></div>
      </div>)}</div>
    </section>}
    <div className={styles.healthStrip} aria-label="Состояние служб">{data.health.map(service => <span className={styles.healthItem} data-status={service.status} key={service.name}><span className={styles.healthDot} />{service.name}<strong>{service.status === "up" ? "Доступен" : service.status === "down" ? "Недоступен" : "Нет данных"}</strong></span>)}{!data.health.length && <span className={styles.muted}>Состояние служб пока неизвестно</span>}</div>
    <div className={styles.metricGrid}>
      <Metric label="Процессор сервера" value={percent(summary.cpuPercent)} note={`Нагрузка за 1 мин.: ${decimal(summary.load1)}`} icon={<Cpu size={18} />} tone={summary.cpuPercent != null && summary.cpuPercent >= 85 ? "warning" : undefined} />
      <Metric label="Память сервера" value={bytes(summary.memoryUsedBytes)} note={`Из ${bytes(summary.memoryTotalBytes)}`} icon={<Server size={18} />} />
      <Metric label="Диск сервера" value={bytes(summary.diskUsedBytes)} note={`Из ${bytes(summary.diskTotalBytes)}`} icon={<Database size={18} />} />
      <Metric label="Время ответа p95" value={summary.p95LatencyMs == null ? "—" : `${decimal(summary.p95LatencyMs)} мс`} note="95% запросов API быстрее" icon={<Clock3 size={18} />} />
    </div>
    <div className={styles.metricGrid}>
      <Metric label="Запросы API" value={decimal(summary.requestRate)} note="Запросов в секунду" />
      <Metric label="Ошибки API" value={decimal(summary.errorRate)} note="Ошибок HTTP 5xx в секунду" tone={summary.errorRate != null && summary.errorRate > 0 ? "warning" : undefined} />
      <Metric label="Принятые тапы" value={decimal(summary.gameAcceptedRate)} note="Тапов в секунду" icon={<Check size={18} />} />
      <Metric label="Отклонённые тапы" value={decimal(summary.gameRejectedRate)} note="Тапов в секунду" icon={<Trophy size={18} />} tone={summary.gameRejectedRate != null && summary.gameRejectedRate > 0 ? "warning" : undefined} />
    </div>
    <div className={styles.twoColumns}>
      <ServerChart title="CPU и память" description="Последние 60 минут · проценты · UTC" samples={data.samples} unit="%" metrics={[{ key: "cpuPercent", name: "CPU", color: "#b9d99c" }, { key: "memoryPercent", name: "Память", color: "#7fb8e6" }]} />
      <ServerChart title="Трафик API" description="Последние 60 минут · запросы в секунду · UTC" samples={data.samples} metrics={[{ key: "requestRate", name: "Запросы/с", color: "#b9d99c" }, { key: "errorRate", name: "Ошибки/с", color: "#e9b77f" }]} />
    </div>
    <ServerChart title="Скорость API · p95" description="Последние 60 минут · миллисекунды · UTC" samples={data.samples} metrics={[{ key: "p95LatencyMs", name: "p95, мс", color: "#7fb8e6" }]} />
    <p className={styles.footnote}>Пропуски означают отсутствие измерений. Нулевая нагрузка отображается только когда сборщик действительно вернул ноль.</p>
  </div>;
}

function Audit({ data, busy, onPage }: { data: AdminAudit; busy: boolean; onPage: (offset: number) => void }) {
  return <section className={styles.panel}>
    <SectionHeading title="Журнал действий" description="Выдача наград и завершение сеансов · кто, когда и почему · UTC" />
    {!data.events.length ? <Empty>Действий администратора пока нет.</Empty> : <Table className={styles.auditTable}>
      <TableHeader><TableRow><TableHead>Время / операция</TableHead><TableHead>Администратор</TableHead><TableHead>Пользователь</TableHead><TableHead>Причина</TableHead><TableHead>Результат</TableHead></TableRow></TableHeader>
      <TableBody>{data.events.map(event => <TableRow key={event.requestId}>
        <TableCell>{time(event.createdAt, true)}<small>{event.action === "revoke_sessions" ? "Завершение сеансов" : event.action === "grant_item" ? "Выдача предмета" : "Выдача достижения"}</small><code className={styles.requestId}>{event.requestId}</code></TableCell>
        <TableCell><code>{event.actorPublicId}</code></TableCell><TableCell><code>{event.targetPublicId}</code></TableCell>
        <TableCell className={styles.reasonCell}>{event.reason}</TableCell><TableCell>{event.action === "revoke_sessions" ? `${count(event.affectedSessions)} сеансов` : <>{[...GAME_ITEMS, ...GAME_ACHIEVEMENTS].find(item => item.id === event.rewardId)?.title ?? event.rewardId}<small>{event.granted ? "Выдано" : "Уже было получено"}</small></>}</TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <Pagination total={data.total} offset={data.offset} busy={busy} onChange={onPage} />
  </section>;
}

export function AdminDashboard() {
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("loading");
  const [tab, setTab] = useState<AdminTab>("overview");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<UserSort>("created");
  const [usersOffset, setUsersOffset] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Snapshot<AdminOverview> | null>(null);
  const [users, setUsers] = useState<Snapshot<AdminUsers> | null>(null);
  const [monitoring, setMonitoring] = useState<Snapshot<AdminMonitoring> | null>(null);
  const [audit, setAudit] = useState<Snapshot<AdminAudit> | null>(null);
  const [rewardTarget, setRewardTarget] = useState<AdminUser | null>(null);
  const [revocation, setRevocation] = useState<Revocation | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionReceipt, setActionReceipt] = useState<string | null>(null);
  const rewardTrigger = useRef<HTMLElement | null>(null);
  const ownerRef = useRef<string | null>(null);
  const actionBusyRef = useRef(false);
  const actionControllerRef = useRef<AbortController | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  const clearData = useCallback(() => {
    setOverview(null); setUsers(null); setMonitoring(null); setAudit(null);
    setQueryInput(""); setQuery(""); setUsersOffset(0); setAuditOffset(0);
    setRevocation(null); setRewardTarget(null); setActionError(null); setActionReceipt(null);
    actionControllerRef.current?.abort();
    actionBusyRef.current = false;
    setActionBusy(false);
  }, []);
  const closeAccess = useCallback((error: ApiError) => {
    requestControllerRef.current?.abort();
    ownerRef.current = null;
    setAccess(null); clearData(); setLoadError(null); setLoading(false);
    setAccessStatus(error.status === 401 ? "signed-out" : "forbidden");
  }, [clearData]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(queryInput.trim()); setUsersOffset(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    let active = true;
    let busy = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (!active || busy || document.visibilityState !== "visible") return;
      busy = true;
      controller = new AbortController();
      requestControllerRef.current = controller;
      const signal = controller.signal;
      // Defer state updates until after the effect has installed its cleanup.
      await Promise.resolve();
      if (!active) { busy = false; return; }
      setLoading(true);
      try {
        const identity = await getAdminAccess(signal);
        if (!active || signal.aborted) return;
        if (ownerRef.current !== identity.publicId) {
          clearData();
          ownerRef.current = identity.publicId;
        }
        setAccess(identity); setAccessStatus("allowed");
        if (tab === "overview") {
          const value = await getAdminOverview(days, signal);
          if (active && !signal.aborted) setOverview({ key: String(days), value });
        } else if (tab === "users") {
          const value = await getAdminUsers({ q: query, sort, offset: usersOffset, limit: PAGE_SIZE }, signal);
          if (active && !signal.aborted) setUsers({ key: JSON.stringify([query, sort, usersOffset]), value });
        } else if (tab === "monitoring") {
          const value = await getAdminMonitoring(signal);
          if (active && !signal.aborted) setMonitoring({ key: "monitoring", value });
        } else {
          const value = await getAdminAudit({ offset: auditOffset, limit: PAGE_SIZE }, signal);
          if (active && !signal.aborted) setAudit({ key: String(auditOffset), value });
        }
        if (active && !signal.aborted) setLoadError(null);
      } catch (error) {
        if (!active || signal.aborted) return;
        if (isAccessError(error)) closeAccess(error);
        else {
          setLoadError(errorMessage(error));
          if (!ownerRef.current) setAccessStatus("error");
        }
      } finally {
        busy = false;
        if (active && !signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false; controller?.abort(); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tab, days, query, sort, usersOffset, auditOffset, refreshVersion, clearData, closeAccess]);

  useEffect(() => () => { actionControllerRef.current?.abort(); }, []);

  const requestRefresh = () => setRefreshVersion(value => value + 1);
  const startRevocation = (target: AdminUser) => {
    setActionError(null); setActionReceipt(null);
    setRevocation({ target, requestId: null, confirmation: "", reason: "" });
  };
  const submitRevocation = async () => {
    if (!revocation || !access || actionBusyRef.current || revocation.confirmation.trim() !== revocation.target.publicId
      || revocation.reason.trim().length < 8 || revocation.reason.trim().length > 240) return;
    const requestId = revocation.requestId ?? createUuidV4();
    const body = { requestId, confirmationPublicId: revocation.confirmation.trim(), reason: revocation.reason.trim() };
    setRevocation({ ...revocation, requestId });
    actionBusyRef.current = true; setActionBusy(true); setActionError(null);
    const controller = new AbortController();
    actionControllerRef.current = controller;
    try {
      const identity = await getAdminAccess(controller.signal);
      if (controller.signal.aborted) return;
      if (identity.publicId !== access.publicId) {
        clearData(); setAccess(null); setAccessStatus("loading"); ownerRef.current = null; requestRefresh(); return;
      }
      const receipt = await revokeAdminSessions(revocation.target.publicId, body, controller.signal);
      if (controller.signal.aborted) return;
      setActionReceipt(`Сеансы пользователя ${revocation.target.displayName} завершены: ${count(receipt.affectedSessions)}. Он сможет войти снова.`);
      setRevocation(null); requestRefresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAccessError(error)) closeAccess(error);
      else setActionError(errorMessage(error));
    } finally {
      if (actionControllerRef.current === controller) {
        actionBusyRef.current = false; setActionBusy(false);
      }
    }
  };

  const overviewData = overview?.key === String(days) ? overview.value : null;
  const usersData = users?.key === JSON.stringify([query, sort, usersOffset]) ? users.value : null;
  const auditData = audit?.key === String(auditOffset) ? audit.value : null;
  const currentData = tab === "overview" ? overviewData : tab === "users" ? usersData : tab === "monitoring" ? monitoring?.value : auditData;
  const currentTime = currentData?.serverTime;
  const validConfirmation = Boolean(revocation && revocation.confirmation.trim() === revocation.target.publicId && revocation.reason.trim().length >= 8 && revocation.reason.trim().length <= 240);

  if (accessStatus !== "allowed" || !access) return (
    <main className={styles.shell}><div className={styles.accessGate}>
      <Link href="/" className={styles.backLink}><ArrowLeft size={18} />В приложение</Link>
      <div className={styles.gateIcon}>{accessStatus === "loading" ? <LoaderCircle className={styles.spin} size={28} /> : accessStatus === "error" ? <CircleAlert size={28} /> : <ShieldX size={28} />}</div>
      <p className={styles.eyebrow}>Я живой / Управление</p>
      <h1>{accessStatus === "loading" ? "Проверяем доступ" : accessStatus === "signed-out" ? "Войдите в свой аккаунт" : accessStatus === "forbidden" ? "Доступ закрыт" : "Панель временно недоступна"}</h1>
      <p>{accessStatus === "loading" ? "Подключаемся к панели управления…" : accessStatus === "signed-out" ? "Откройте приложение, войдите в аккаунт администратора и вернитесь на /admin в этом же браузере." : accessStatus === "forbidden" ? "У этого аккаунта нет прав на просмотр панели управления." : loadError}</p>
      <div className={styles.gateActions}>{accessStatus === "signed-out" && <Link className={styles.primaryButton} href="/">Открыть приложение<ArrowUpRight size={18} /></Link>}{accessStatus !== "loading" && <button type="button" className={styles.button} onClick={requestRefresh}><Activity size={18} />Проверить снова</button>}</div>
    </div></main>
  );

  return (
    <main className={styles.shell}>
      <div className={styles.workspace}>
        <header className={styles.header}>
          <div><Link className={styles.brand} href="/">Я живой <span>/ Управление</span></Link><p><ShieldCheck size={15} />Закрытая панель<span className={styles.headerDivider}>·</span>{access.displayName}</p></div>
          <Link href="/" className={styles.backLink}><ArrowLeft size={17} />В приложение</Link>
        </header>
        <Tabs value={tab} onValueChange={value => setTab(value as AdminTab)} className={styles.tabs}>
          <div className={styles.toolbar}>
            <TabsList className={styles.tabList} aria-label="Разделы управления">
              <TabsTrigger className={styles.tab} value="overview"><LayoutDashboard size={18} />Обзор</TabsTrigger>
              <TabsTrigger className={styles.tab} value="users"><Users size={18} />Пользователи</TabsTrigger>
              <TabsTrigger className={styles.tab} value="monitoring"><Server size={18} />Сервер</TabsTrigger>
              <TabsTrigger className={styles.tab} value="audit"><Terminal size={18} />Журнал</TabsTrigger>
            </TabsList>
            <div className={styles.refreshGroup}><span className={styles.updated}>{currentTime ? `Снимок ${time(currentTime)} UTC` : "Ожидаем данные"}</span><button type="button" className={styles.iconButton} onClick={requestRefresh} disabled={loading} aria-label="Обновить данные">{loading ? <LoaderCircle size={19} className={styles.spin} /> : <Activity size={19} />}</button></div>
          </div>
          <div className={styles.viewHeading}><div><h1>{tab === "overview" ? "Состояние приложения" : tab === "users" ? "Пользователи" : tab === "monitoring" ? "Нагрузка и доступность" : "Действия администраторов"}</h1><p>{tab === "overview" ? "Рост, отметки и возвращаемость" : tab === "users" ? "Аккаунты, прогресс и управление сеансами" : tab === "monitoring" ? "Измерения сервера и API" : "История выдачи наград и управления сеансами"}</p></div>
            {tab === "overview" && <label className={styles.selectLabel}><span>Период</span><select value={days} onChange={event => setDays(Number(event.target.value) as 7 | 30 | 90)} className={styles.select}><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option></select></label>}
          </div>
          {loadError && <div className={styles.notice} role="status"><CircleAlert size={20} /><div><strong>{currentData ? "Данные не обновились" : "Не удалось загрузить раздел"}</strong><p>{loadError}{currentData ? " Показан последний успешный снимок." : ""}</p></div><button className={styles.button} type="button" onClick={requestRefresh} disabled={loading}>Повторить</button></div>}
          {actionReceipt && <div className={styles.successNotice} role="status"><Check size={20} /><span>{actionReceipt}</span><button type="button" className={styles.textButton} onClick={() => setActionReceipt(null)}>Скрыть</button></div>}
          <TabsContent value="overview" className={styles.tabContent}>{overviewData ? <Overview data={overviewData} days={days} /> : <Empty>{loading ? "Загружаем статистику…" : "Статистика пока не загружена."}</Empty>}</TabsContent>
          <TabsContent value="users" className={styles.tabContent}>
            <div className={styles.searchToolbar}><label className={styles.search}><Search size={19} /><span className={styles.srOnly}>Поиск пользователя по имени или ID</span><input type="search" value={queryInput} onChange={event => setQueryInput(event.target.value)} placeholder="Имя или ID пользователя" maxLength={100} autoComplete="off" /></label><label className={styles.selectLabel}><span>Сортировка</span><select className={styles.select} value={sort} onChange={event => { setSort(event.target.value as UserSort); setUsersOffset(0); }}><option value="created">Сначала новые</option><option value="activity">По последней отметке</option><option value="taps">По числу тапов</option></select></label></div>
            {usersData ? <UsersTable data={usersData} access={access} busy={loading || actionBusy} onPage={setUsersOffset} onRevoke={startRevocation} onRewards={target => { rewardTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRewardTarget(target); }} /> : <Empty>{loading ? "Ищем пользователей…" : "Список пока не загружен."}</Empty>}
          </TabsContent>
          <TabsContent value="monitoring" className={styles.tabContent}>{monitoring ? <Monitoring data={monitoring.value} /> : <Empty>{loading ? "Получаем метрики сервера…" : "Метрики пока не загружены."}</Empty>}</TabsContent>
          <TabsContent value="audit" className={styles.tabContent}>{auditData ? <Audit data={auditData} busy={loading} onPage={setAuditOffset} /> : <Empty>{loading ? "Загружаем журнал…" : "Журнал пока не загружен."}</Empty>}</TabsContent>
          <footer className={styles.footer}><span><span className={styles.liveDot} />Автообновление каждые 30 секунд, пока вкладка видна</span><span>Время и периоды — UTC</span></footer>
        </Tabs>
      </div>
      {rewardTarget && <AdminRewardsDialog key={rewardTarget.publicId} target={rewardTarget} actorPublicId={access.publicId}
        onClose={() => setRewardTarget(null)} onAccessLost={closeAccess}
        returnFocus={() => { if (rewardTrigger.current?.isConnected) rewardTrigger.current.focus(); }}
        onGranted={message => { setActionReceipt(message); requestRefresh(); }} />}
      <AlertDialog open={revocation !== null} onOpenChange={open => { if (!open && !actionBusy) { setRevocation(null); setActionError(null); } }}>
        <AlertDialogContent className={styles.confirmDialog} onEscapeKeyDown={event => { if (actionBusy) event.preventDefault(); }}>
          <AlertDialogHeader><AlertDialogTitle>Завершить все сеансы?</AlertDialogTitle><AlertDialogDescription>Пользователь {revocation?.target.displayName} выйдет из аккаунта на всех устройствах. Его данные сохранятся, и он сможет войти снова. Это действие попадёт в журнал.</AlertDialogDescription></AlertDialogHeader>
          <label className={styles.field}>Введите ID пользователя<code>{revocation?.target.publicId}</code><input value={revocation?.confirmation ?? ""} onChange={event => setRevocation(current => current ? { ...current, confirmation: event.target.value, requestId: null } : current)} autoComplete="off" spellCheck={false} disabled={actionBusy || revocation?.requestId != null} /></label>
          <label className={styles.field}>Причина завершения сеансов<textarea value={revocation?.reason ?? ""} onChange={event => setRevocation(current => current ? { ...current, reason: event.target.value, requestId: null } : current)} rows={3} minLength={8} maxLength={240} placeholder="Например: пользователь сообщил о потере устройства" disabled={actionBusy || revocation?.requestId != null} /><small>От 8 до 240 символов. Не указывайте пароли и личную переписку.</small></label>
          {actionError && <div className={styles.notice} role="alert"><CircleAlert size={18} /><div><p>{actionError}</p><p>Повторный запрос проверит ту же операцию и не завершит новые сеансы повторно.</p></div></div>}
          <AlertDialogFooter><AlertDialogCancel disabled={actionBusy}>Отмена</AlertDialogCancel><button type="button" className={styles.dangerButton} disabled={!validConfirmation || actionBusy} onClick={() => { void submitRevocation(); }}>{actionBusy ? <LoaderCircle size={17} className={styles.spin} /> : <LogOut size={17} />}{actionBusy ? "Завершаем…" : actionError ? "Повторить запрос" : "Завершить сеансы"}</button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
