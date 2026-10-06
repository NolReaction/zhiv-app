"use client";

import { useEffect, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/check-in-api";
import { economyCatalog, type EconomyCatalog, type EconomyJob } from "@/features/economy/model";
import { formatPearls } from "@/features/economy/money";
import { getAdminAccess, getAdminEconomyPlayer, type AdminEconomyDetail } from "./admin-api";
import { economyCount, economyTime, type AdminEconomyTarget } from "./admin-economy-panel";
import styles from "./admin-economy.module.css";

const ledgerLabels: Record<string, string> = {
  legacy_conversion: "Перенос прежних ресурсов", legacy_journey: "Прежнее путешествие", start_production: "Начало производства",
  buy_production_slot: "Открытие места производства", start_collection: "Начало сбора", start_exploration: "Начало вылазки", cancel_exploration: "Отмена вылазки",
  start_construction: "Начало стройки", speedup_construction: "Ускорение стройки", claim_job: "Получение результата",
  sell: "Продажа припасов", buy_fishing_item: "Покупка снастей", buy_wardrobe_item: "Покупка одежды", sell_fish: "Продажа рыбы", equip_fishing_rod: "Выбор удочки",
  equip_fishing_bait: "Выбор наживки", start_fishing: "Начало рыбалки", market_create: "Выставление на рынок",
  market_buy: "Покупка на рынке", market_sell: "Продажа на рынке", market_cancel: "Возврат с рынка",
  daily_reward: "Подарок за вход", achievement_reward: "Жемчуг за достижение",
  barter_create: "Предложение обмена", barter_accept: "Получение по обмену",
  barter_exchange: "Завершение своего обмена", barter_cancel: "Возврат реликвии",
  account_merge: "Объединение аккаунтов", merged_receipt: "Перенос записи при объединении",
  dev_grant_currency: "Выдача валюты в DEV", dev_grant_item: "Выдача припасов в DEV", dev_set_building_level: "Уровень здания в DEV",
};
const statusLabels = { running: "В работе", awaiting_collection: "Ждёт начала сбора", collecting: "Идёт сбор", ready: "Готово к получению" };
const signed = (value: number) => `${value > 0 ? "+" : ""}${economyCount(value)}`;
const itemName = (id: string, catalog: EconomyCatalog) => catalog.items.find(item => item.id === id)?.name ?? `Предмет ${id}`;
const buildingName = (id: string, catalog: EconomyCatalog) => catalog.buildings.find(item => item.id === id)?.name ?? `Здание ${id}`;

export async function loadAdminEconomyDetail(actorPublicId: string, target: string, signal: AbortSignal) {
  const actor = await getAdminAccess(signal);
  if (signal.aborted) throw new DOMException("Запрос отменён", "AbortError");
  if (actor.publicId !== actorPublicId) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
  return getAdminEconomyPlayer(target, signal);
}

export function economyJobTitle(job: EconomyJob, catalog: EconomyCatalog) {
  if (job.kind === "construction") return `${buildingName(job.targetId, catalog)} · уровень ${economyCount(job.targetLevel)}`;
  if (job.kind === "exploration") return catalog.explorations.find(route => route.id === job.targetId)?.name ?? `Вылазка ${job.targetId}`;
  return catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? `Производство ${job.recipeId ?? job.targetId}`;
}

export function economyRemaining(finishesAt: string, serverTime: string) {
  const seconds = Math.max(0, Math.ceil((Date.parse(finishesAt) - Date.parse(serverTime)) / 1000));
  if (!seconds) return "Срок наступил";
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} мин.` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин.`;
}

function Quantities({ items, catalog, delta = false }: { items: Record<string, number>; catalog: EconomyCatalog; delta?: boolean }) {
  const entries = Object.entries(items).filter(([, value]) => value !== 0);
  return entries.length ? <ul className={styles.quantities}>{entries.map(([id, value]) => <li key={id}>{itemName(id, catalog)} <strong>{delta ? signed(value) : economyCount(value)}</strong></li>)}</ul> : <span className={styles.hint}>Нет припасов</span>;
}

export function AdminEconomyDetailContent({ detail }: { detail: AdminEconomyDetail }) {
  const state = detail.economy, catalog = state?.catalog ?? economyCatalog;
  return <div className={styles.stack}>
    <p className={styles.hint}>Снимок: {economyTime(detail.serverTime)}. Последнее изменение хозяйства: {economyTime(detail.updatedAt)}.{state && ` Версия состояния: ${economyCount(state.revision)}.`}</p>
    {!state ? <div className={styles.empty}>Хозяйство ещё не заведено. Балансы, склад и прогресс пока отсутствуют.</div> : <>
      <div className={styles.metrics}>
        <div className={styles.metric}><span>Монеты</span><strong>{economyCount(state.wallet.coins)}</strong></div>
        <div className={styles.metric}><span>Жемчуг</span><strong>{formatPearls(state.wallet.pearls)}</strong></div>
        <div className={styles.metric}><span>Завершённые вылазки</span><strong>{economyCount(state.completedExplorations)}</strong></div>
      </div>
      <section className={styles.panel}><div className={styles.heading}><h3>Склад</h3><p>Припасы в хозяйстве и места, занятые товарами на рынке.</p></div>
        <dl className={styles.facts}>
          <div><dt>Вместимость</dt><dd>{economyCount(state.storage.capacity)}</dd></div><div><dt>В хозяйстве</dt><dd>{economyCount(state.storage.used)}</dd></div>
          <div><dt>Зарезервировано на рынке</dt><dd>{economyCount(state.storage.reserved)}</dd></div><div><dt>Свободно</dt><dd>{economyCount(state.storage.available)}</dd></div>
          <div data-warning={state.storage.overflow > 0}><dt>Сверх вместимости</dt><dd>{economyCount(state.storage.overflow)}</dd></div>
        </dl>
        <Quantities items={state.inventory} catalog={catalog} />
      </section>
      <section className={styles.panel}><div className={styles.heading}><h3>Здания</h3></div><ul className={styles.buildings}>
        {catalog.buildings.map(building => <li key={building.id}><span>{building.name}</span><strong>{(state.buildings[building.id] ?? 0) > 0 ? `Уровень ${economyCount(state.buildings[building.id])}${catalog.recipes.some(recipe => recipe.buildingId === building.id) ? ` · мест: ${state.productionSlots?.[building.id] ?? 1}` : ""}` : "Не построено"}</strong></li>)}
        {Object.entries(state.buildings).filter(([id]) => !catalog.buildings.some(building => building.id === id)).map(([id, level]) => <li key={id}><span>{buildingName(id, catalog)}</span><strong>Уровень {economyCount(level)}</strong></li>)}
      </ul></section>
      <section className={styles.panel}><div className={styles.heading}><h3>Текущие задания · {economyCount(state.jobs.length)}</h3><p>Статусы и оставшееся время рассчитаны на время серверного снимка.</p></div>
        {state.jobs.length === 0 ? <p className={styles.hint}>Сейчас нет заданий.</p> : <div className={styles.jobs}>{state.jobs.map(job => {
          const status = detail.jobStatuses.find(value => value.jobId === job.id)!;
          const deadline = status.status === "collecting" ? job.collection?.finishesAt ?? job.finishesAt : job.finishesAt;
          return <article className={styles.job} key={job.id}>
            <div className={styles.jobHeading}><strong>{economyJobTitle(job, catalog)}</strong><span className={styles.badge} data-ready={status.status === "ready"}>{statusLabels[status.status]}</span></div>
            <p className={styles.hint}>{job.kind === "production" ? buildingName(job.targetId, catalog) : job.kind === "construction" ? "Строительство" : "Вылазка"} · начало: {economyTime(job.startedAt)}</p>
            <p className={styles.hint}>Срок задания: {economyTime(job.finishesAt)}</p>
            {(status.status === "running" || status.status === "collecting") && <p>До завершения: <strong>{economyRemaining(deadline, detail.serverTime)}</strong> · {economyTime(deadline)}</p>}
            {status.status === "awaiting_collection" && <p>Урожай созрел; игроку нужно начать сбор.</p>}
            {status.storageBlocked && <p className={styles.warning}><CircleAlert size={16} aria-hidden="true" />Для получения награды не хватает места на складе.</p>}
            <p className={styles.hint}>Сохранённая стоимость: {economyCount(job.cost.coins)} монет</p>
            {Object.keys(job.cost.items).length > 0 && <Quantities items={job.cost.items} catalog={catalog} />}
            {job.kind !== "construction" && <><span className={styles.hint}>Награда после получения</span><Quantities items={job.rewards} catalog={catalog} /></>}
          </article>;
        })}</div>}
      </section>
      {catalog.fishing && <section className={styles.panel}><div className={styles.heading}><h3>Рыбалка</h3></div>
        <p>Удочка: <strong>{catalog.fishing.rods.find(rod => rod.id === state.fishing.equippedRodId)?.name ?? state.fishing.equippedRodId}</strong></p>
        <p className={styles.hint}>Доступные удочки: {state.fishing.ownedRods.map(id => catalog.fishing!.rods.find(rod => rod.id === id)?.name ?? id).join(", ")}</p>
        <p>Наживка: <strong>{state.fishing.equippedBaitId ? itemName(state.fishing.equippedBaitId, catalog) : "Не выбрана"}</strong></p>
        <p className={styles.hint}>Открытая коллекция улова</p><Quantities items={state.fishing.catches} catalog={catalog} />
      </section>}
    </>}
    <section className={styles.panel}><div className={styles.heading}><h3>Последние операции · до 30 записей</h3><p>Показаны изменения валют и припасов. Это последние записи, а не полная история аккаунта.</p></div>
      {!detail.ledger.length ? <p className={styles.hint}>Записей пока нет.</p> : <div className={styles.tableScroll}><Table>
        <TableHeader><TableRow><TableHead>Время, UTC</TableHead><TableHead>Операция</TableHead><TableHead>Монеты</TableHead><TableHead>Жемчуг</TableHead><TableHead>Припасы</TableHead></TableRow></TableHeader>
        <TableBody>{detail.ledger.map((entry, index) => <TableRow key={`${entry.createdAt}:${index}`}>
          <TableCell><time dateTime={entry.createdAt}>{economyTime(entry.createdAt)}</time></TableCell><TableCell>{ledgerLabels[entry.kind] ?? entry.kind}</TableCell>
          <TableCell>{signed(entry.coins)}</TableCell><TableCell>{formatPearls(entry.pearls, { signDisplay: "exceptZero" })}</TableCell><TableCell><Quantities items={entry.items} catalog={catalog} delta /></TableCell>
        </TableRow>)}</TableBody>
      </Table></div>}
    </section>
  </div>;
}

export function AdminEconomyDialog({ target, actorPublicId, onAccessLost, onClose }: {
  target: AdminEconomyTarget; actorPublicId: string; onAccessLost: (error: ApiError) => void; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ owner: string; value: AdminEconomyDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true, busy = false;
    let controller: AbortController | null = null;
    async function load() {
      if (!active || busy || document.visibilityState !== "visible") return;
      busy = true; controller = new AbortController(); const signal = controller.signal;
      await Promise.resolve(); if (!active || signal.aborted) return;
      setLoading(true);
      try {
        const value = await loadAdminEconomyDetail(actorPublicId, target.publicId, signal);
        if (active && !signal.aborted) { setSnapshot({ owner: actorPublicId, value }); setError(null); }
      } catch (cause) {
        if (!active || signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setSnapshot(null); onAccessLost(cause); return; }
        setError(cause instanceof ApiError ? cause.message : "Не удалось получить хозяйство игрока. Повторите запрос.");
      } finally { busy = false; if (active && !signal.aborted) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible); window.addEventListener("focus", visible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [actorPublicId, target.publicId, onAccessLost, version]);
  const detail = snapshot?.owner === actorPublicId && snapshot.value.publicId === target.publicId ? snapshot.value : null;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={styles.dialog}>
    <DialogHeader><DialogTitle>Хозяйство игрока</DialogTitle><DialogDescription>{detail?.displayName ?? target.displayName} · {target.publicId}</DialogDescription></DialogHeader>
    <div className={styles.refresh}><span className={styles.hint}>Обновляется раз в 30 секунд, пока окно видно</span><button type="button" className={styles.button} disabled={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={17} aria-hidden="true" />Обновить</button></div>
    {error && <div className={styles.error} role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{error}{detail ? " Показан последний успешный снимок; состояние могло измениться." : ""}</span></div>}
    <div aria-busy={loading}>{detail ? <AdminEconomyDetailContent detail={detail} /> : <p className={styles.empty} role="status">{loading ? "Загружаем хозяйство…" : "Хозяйство пока не загружено."}</p>}</div>
  </DialogContent></Dialog>;
}
