"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw, Search } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/check-in-api";
import { formatPearls } from "@/features/economy/money";
import { getAdminAccess, getAdminEconomy, type AdminEconomy, type AdminEconomyPlayer, type AdminEconomySort } from "./admin-api";
import styles from "./admin-economy.module.css";

const PAGE_SIZE = 25;
const formatter = new Intl.NumberFormat("ru-RU");
const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
export const economyCount = (value: number | null | undefined) => value == null ? "—" : formatter.format(value);
export const economyPearls = (value: number | null | undefined) => value == null ? "—" : formatPearls(value);
export const economyTime = (value: string | null) => value ? `${dateFormatter.format(new Date(value))} UTC` : "—";
export type AdminEconomyTarget = Pick<AdminEconomyPlayer, "publicId" | "displayName">;

/** Verify the same administrator before every read, including background refreshes. */
export async function loadAdminEconomy(actorPublicId: string,
  options: { q: string; sort: AdminEconomySort; offset: number; limit: number }, signal: AbortSignal) {
  const actor = await getAdminAccess(signal);
  if (signal.aborted) throw new DOMException("Запрос отменён", "AbortError");
  if (actor.publicId !== actorPublicId) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
  return getAdminEconomy(options, signal);
}

function Metric({ label, value, note, pearls = false }: { label: string; value: number; note?: string; pearls?: boolean }) {
  return <div className={styles.metric}><span>{label}</span><strong>{pearls ? economyPearls(value) : economyCount(value)}</strong>{note && <small>{note}</small>}</div>;
}

export function AdminEconomyList({ data, loading, query, sort, offset, onQuery, onSort, onPage, onOpen, onHistory }: {
  data: AdminEconomy | null; loading: boolean; query: string; sort: AdminEconomySort; offset: number;
  onQuery: (value: string) => void; onSort: (value: AdminEconomySort) => void;
  onPage: (offset: number) => void; onOpen: (target: AdminEconomyTarget) => void;
  onHistory?: (target: AdminEconomyTarget) => void;
}) {
  const summary = data?.summary;
  return <>
    {summary && <section className={styles.summary} aria-label="Сводка хозяйств всех игроков">
      <div className={styles.heading}><h2>Сводка по всем игрокам</h2><p>Поиск ограничивает список ниже. Сводка включает всех игроков.</p></div>
      <div className={styles.metrics}>
        <Metric label="Игроки" value={summary.players} note={`Хозяйство заведено: ${economyCount(summary.initializedPlayers)} · ещё не заведено: ${economyCount(summary.uninitializedPlayers)}`} />
        <Metric label="Монеты в хозяйствах" value={summary.coins} />
        <Metric label="Жемчуг в хозяйствах" value={summary.pearls} pearls />
        <Metric label="Задания в работе" value={summary.runningJobs} note="Производство, вылазки, стройка и начатый сбор" />
        <Metric label="Готово к получению" value={summary.readyJobs} note="Включая награды, для которых пока нет места" />
        <Metric label="Изменили хозяйство за 24 часа" value={summary.updatedLast24Hours} note="По времени сохранённого изменения состояния" />
      </div>
      <div className={styles.signals}>
        <span data-warning={summary.storageBlockedPlayers > 0}>Нет места для готовых наград: <strong>{economyCount(summary.storageBlockedPlayers)}</strong> игроков</span>
        <span data-warning={summary.overflowPlayers > 0}>Склад сверх вместимости: <strong>{economyCount(summary.overflowPlayers)}</strong> игроков</span>
      </div>
    </section>}
    <section className={styles.panel} aria-label="Хозяйства игроков" aria-busy={loading}>
      <div className={styles.toolbar}>
        <label className={styles.search}><Search size={18} aria-hidden="true" /><span className={styles.srOnly}>Поиск хозяйства по имени или ID</span>
          <input type="search" value={query} onChange={event => onQuery(event.target.value)} placeholder="Имя или ID игрока" maxLength={100} autoComplete="off" />
        </label>
        <label className={styles.selectLabel}>Сортировка<select value={sort} onChange={event => onSort(event.target.value as AdminEconomySort)}>
          <option value="updated">По последнему изменению</option><option value="coins">По монетам</option>
          <option value="progress">По развитию</option><option value="ready">По готовым заданиям</option>
        </select></label>
      </div>
      <p className={styles.hint}>Время изменения хозяйства показывает сохранение его состояния. Открытие приложения здесь не учитывается.</p>
      {!data ? <p className={styles.empty} role="status">{loading ? "Загружаем хозяйства…" : "Хозяйства пока не загружены."}</p> : data.players.length === 0 ?
        <p className={styles.empty}>Игроков с таким именем или ID не найдено.</p> : <div className={styles.tableScroll}><Table>
          <TableHeader><TableRow><TableHead>Игрок</TableHead><TableHead>Валюты</TableHead><TableHead>Развитие</TableHead><TableHead>Склад</TableHead><TableHead>Задания</TableHead><TableHead>Изменение хозяйства</TableHead><TableHead><span className={styles.srOnly}>Подробности</span></TableHead></TableRow></TableHeader>
          <TableBody>{data.players.map(player => <TableRow key={player.publicId}>
            <TableCell><strong>{player.displayName}</strong><code className={styles.block}>{player.publicId}</code></TableCell>
            {!player.initialized ? <TableCell colSpan={5}><span className={styles.hint}>Хозяйство ещё не заведено</span></TableCell> : <>
              <TableCell>{economyCount(player.coins)} монет<span className={styles.block}>{economyPearls(player.pearls)} жемчуга</span></TableCell>
              <TableCell>Дом · ур. {economyCount(player.homeLevel)}<span className={styles.block}>Вылазок: {economyCount(player.completedExplorations)}</span></TableCell>
              <TableCell>{economyCount(player.storage?.used)} / {economyCount(player.storage?.capacity)}<span className={styles.block}>Свободно: {economyCount(player.storage?.available)}</span>
                <span className={styles.block}>На рынке: {economyCount(player.storage?.reserved)}</span>
                {!!player.storage?.overflow && <span className={styles.warning}>Сверх вместимости: {economyCount(player.storage.overflow)}</span>}
              </TableCell>
              <TableCell>В работе: {economyCount(player.runningJobs)}<span className={styles.block}>Готово: {economyCount(player.readyJobs)}</span>
                {player.awaitingCollectionJobs > 0 && <span className={styles.block}>Ждёт начала сбора: {economyCount(player.awaitingCollectionJobs)}</span>}
                {player.blockedReadyJobs > 0 && <span className={styles.warning}>Нет места: {economyCount(player.blockedReadyJobs)}</span>}
              </TableCell>
              <TableCell><time dateTime={player.updatedAt ?? undefined}>{economyTime(player.updatedAt)}</time></TableCell>
            </>}
            <TableCell><button type="button" className={styles.button} onClick={() => onOpen(player)} aria-label={`Открыть хозяйство игрока ${player.displayName}`}>Подробнее</button>{onHistory && <button type="button" className={styles.button} onClick={() => onHistory(player)} aria-label={`Открыть операции игрока ${player.displayName}`}>Операции</button>}</TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
      <div className={styles.pagination}>
        <span>{data ? data.total === 0 ? "Нет записей" : `${economyCount(offset + 1)}–${economyCount(Math.min(offset + data.players.length, data.total))} из ${economyCount(data.total)}` : "—"}</span>
        <div><button type="button" className={styles.button} disabled={loading || offset === 0} onClick={() => { if (!loading && offset > 0) onPage(Math.max(0, offset - PAGE_SIZE)); }} aria-label="Предыдущая страница хозяйств"><ChevronLeft size={18} />Назад</button>
          <button type="button" className={styles.button} disabled={loading || !data || offset + PAGE_SIZE >= data.total} onClick={() => { if (!loading && data && offset + PAGE_SIZE < data.total) onPage(offset + PAGE_SIZE); }} aria-label="Следующая страница хозяйств">Далее<ChevronRight size={18} /></button></div>
      </div>
    </section>
  </>;
}

export function AdminEconomyPanel({ actorPublicId, refreshVersion = 0, onAccessLost, onOpen, onHistory }: {
  actorPublicId: string; refreshVersion?: number; onAccessLost: (error: ApiError) => void; onOpen: (target: AdminEconomyTarget) => void;
  onHistory?: (target: AdminEconomyTarget) => void;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AdminEconomySort>("updated");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; value: AdminEconomy } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([actorPublicId, query, sort, offset]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(queryInput.trim()); setOffset(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);
  useEffect(() => {
    let active = true, busy = false;
    let controller: AbortController | null = null;
    async function load() {
      if (!active || busy || document.visibilityState !== "visible") return;
      busy = true; controller = new AbortController();
      const signal = controller.signal;
      await Promise.resolve();
      if (!active || signal.aborted) return;
      setLoading(true);
      try {
        const value = await loadAdminEconomy(actorPublicId, { q: query, sort, offset, limit: PAGE_SIZE }, signal);
        if (!active || signal.aborted) return;
        if (offset > 0 && value.players.length === 0 && value.total <= offset) {
          setOffset(Math.max(0, Math.floor((value.total - 1) / PAGE_SIZE) * PAGE_SIZE)); return;
        }
        setSnapshot({ key, value }); setError(null);
      } catch (cause) {
        if (!active || signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setSnapshot(null); onAccessLost(cause); return; }
        setError(cause instanceof ApiError ? cause.message : "Не удалось получить хозяйства. Повторите запрос.");
      } finally { busy = false; if (active && !signal.aborted) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible); window.addEventListener("focus", visible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [actorPublicId, query, sort, offset, key, version, refreshVersion, onAccessLost]);
  const data = snapshot?.key === key ? snapshot.value : null;
  return <div className={styles.stack}>
    <div className={styles.refresh}><span className={styles.hint}>{data ? `Снимок: ${economyTime(data.serverTime)}` : "Ожидаем данные"}</span>
      <button type="button" className={styles.button} disabled={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={17} aria-hidden="true" />Обновить хозяйства</button></div>
    {error && <div className={styles.error} role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{error}{data ? " Показан последний успешный снимок; состояние могло измениться." : ""}</span></div>}
    <AdminEconomyList data={data} loading={loading} query={queryInput} sort={sort} offset={offset}
      onQuery={setQueryInput} onSort={value => { setSort(value); setOffset(0); }} onPage={setOffset} onOpen={onOpen} onHistory={onHistory} />
  </div>;
}
