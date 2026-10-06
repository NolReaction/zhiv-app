"use client";
import { useEffect, useRef, type RefObject } from "react";
import { CalendarDays, Check, Clock3, Gift, RefreshCw, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { formatPearls } from "@/features/economy/money";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyController } from "@/features/economy/use-economy";
import type { GameReward } from "./game-rewards-api";
import { useGameRewards, type GameRewardsController } from "./use-game-rewards";
import { createDailyRewardEntryPrompt } from "./daily-reward-entry";
import styles from "./daily-rewards.module.css";

export function dailyRewardWait(nextClaimAt: string, now: number) {
  const minutes = Math.ceil((Date.parse(nextClaimAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Проверяем доступность…";
  if (minutes < 60) return `Следующий подарок через ${minutes} мин`;
  return `Следующий подарок через ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
}
export function RewardContents({ reward, names = {}, large = false }: { reward: GameReward; names?: Record<string, string>; large?: boolean }) {
  const rows = [{ id: "coins", count: reward.coins, name: "Монеты" }, { id: "pearls", count: reward.pearls, name: "Жемчуг" },
    ...Object.entries(reward.items).map(([id, count]) => ({ id, count, name: names[id] ?? "Припасы" }))].filter(row => row.count > 0);
  return <ul className={styles.contents} aria-label="Состав подарка">{rows.map(row => <li key={row.id}>
    <ItemIcon itemId={row.id} size={large ? 34 : 26} /><span><strong>{row.id === "pearls" ? formatPearls(row.count) : row.count.toLocaleString("ru-RU")}</strong><small>{row.name}</small></span>
  </li>)}</ul>;
}
export function RewardRecovery({ controller, isOnline }: { controller: GameRewardsController; isOnline: boolean }) {
  if (!controller.uncertain) return controller.error ? <p className={styles.error} role="status">{controller.error}</p> : null;
  return <aside className={styles.recovery} role="status"><strong>Проверим получение</strong>
    <p>{controller.error || "Ответ сервера ещё не подтверждён."} Новый подарок пока не отправляем.</p>
    <button type="button" disabled={controller.busy || !isOnline || controller.retryAt > controller.now} onClick={() => void controller.retry()}>
      <RefreshCw size={16} aria-hidden="true" />{controller.busy ? "Проверяем…" : "Проверить получение"}
    </button></aside>;
}
export function DailyRewardsPanel({ controller, isOnline, names = {} }: { controller: GameRewardsController; isOnline: boolean; names?: Record<string, string> }) {
  const daily = controller.data?.daily, receipt = controller.result?.claim.kind === "daily" ? controller.result.claim : null;
  const locked = !isOnline || controller.busy || controller.uncertain || controller.pending !== null || controller.retryAt > controller.now;
  return <div className={styles.panel} aria-busy={controller.loading || controller.busy}>
    <p className={styles.intro}>Припасы, монеты и жемчуг за возвращение в лес. Пропуск дня сохраняет ваш шаг.</p>
    {!isOnline && <p className={styles.status} role="status">Для получения нужен интернет.{daily && " Показаны последние загруженные подарки."}</p>}
    {!daily ? <div className={styles.empty}><Gift size={34} aria-hidden="true" /><p>{controller.loading ? "Открываем подарки…" : "Загрузите подарки, чтобы узнать, что приготовил лес."}</p>
      <button type="button" disabled={controller.loading || !isOnline} onClick={() => void controller.refresh()}><RefreshCw size={16} aria-hidden="true" />Обновить</button></div>
      : <>
        <ol className={styles.cycle} aria-label="Семь подарков за вход">
          {daily.cycle.map(row => { const completed = row.step < daily.step, current = row.step === daily.step;
            return <li key={row.step} data-current={current || undefined} data-completed={completed || undefined} data-finale={row.step === 7 || undefined} aria-current={current ? "step" : undefined}>
              <div className={styles.day}><span>День {row.step}</span>{completed ? <Check size={14} aria-label="Пройден" /> : row.step === 7 ? <Gift size={15} aria-hidden="true" /> : null}</div>
              <RewardContents reward={row.reward} names={names} />
              <span className={styles.stepStatus}>{completed ? "Получено" : current ? daily.claimable ? "Можно забрать" : "Следующий подарок" : "Впереди"}</span>
            </li>;
          })}
        </ol>
        {receipt && <div className={styles.received} role="status"><Check size={18} aria-hidden="true" /><div><strong>Подарок дня {receipt.step} получен</strong><small>{new Date(receipt.claimedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</small><RewardContents reward={receipt.reward} names={names} />{receipt.step === 7 && <p>Все семь шагов пройдены. Следующий круг начнётся с первого подарка.</p>}</div></div>}
        <div className={styles.claimArea}>
          {daily.claimable ? <><div><span className={styles.eyebrow}>ПОДАРОК ДНЯ {daily.step}</span><RewardContents reward={daily.reward} names={names} large /></div>
            <button type="button" className={styles.claim} disabled={locked} onClick={() => void controller.claimDaily()}><Gift size={18} aria-hidden="true" />{controller.busy && controller.pending?.kind === "daily" ? "Получаем…" : "Забрать подарок"}</button></>
            : <p className={styles.wait} role="status"><Clock3 size={17} aria-hidden="true" />{dailyRewardWait(daily.nextClaimAt, controller.now)}</p>}
        </div>
      </>}
    <RewardRecovery controller={controller} isOnline={isOnline} />
    <details className={styles.rules}><summary>Как приходят подарки</summary><p>Один подарок в день по UTC, не раньше чем через 20 часов после предыдущего. Получайте их по очереди: пропуск не сбрасывает семь шагов. Награда попадает в кошелёк и кладовую только после нажатия и подтверждения сервера.</p></details>
  </div>;
}
export function DailyRewardsButton({ ownerPublicId, isOnline = true, onSessionLost, open, onRequestOpen, triggerRef }: {
  ownerPublicId: string; isOnline?: boolean; onSessionLost?: () => void; open: boolean; onRequestOpen: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const controller = useGameRewards(ownerPublicId, isOnline, onSessionLost);
  const available = Boolean(controller.data?.daily.claimable && !controller.pending && isOnline), uncertain = controller.uncertain;
  return <button ref={triggerRef} type="button" className={styles.giftButton} data-world-rewards-trigger data-available={available || undefined} data-uncertain={uncertain || undefined}
      aria-haspopup="dialog" aria-expanded={open} aria-label={`Подарки за вход${uncertain ? ". Нужно проверить получение" : available ? ". Подарок доступен" : ""}`}
      onClick={() => { onRequestOpen(); void controller.refresh(); }}><Gift size={18} aria-hidden="true" /><span>Подарки</span>{(available || uncertain) && <span className={styles.indicator} aria-hidden="true" />}</button>;
}

/** Keep this mounted while the profile or dialog closes: an in-flight claim still confirms the wallet. */
export function DailyRewardsDialog({ ownerPublicId, economy, isOnline = true, onSessionLost, open, onOpenChange, onReturnFocus }: {
  ownerPublicId: string; economy: EconomyController; isOnline?: boolean; onSessionLost?: () => void;
  open: boolean; onOpenChange: (value: boolean) => void; onReturnFocus: () => void;
}) {
  const controller = useGameRewards(ownerPublicId, isOnline, onSessionLost, () => { void economy.refresh(); });
  const entryPrompt = useRef<ReturnType<typeof createDailyRewardEntryPrompt> | null>(null);
  if (entryPrompt.current === null) { entryPrompt.current = createDailyRewardEntryPrompt(ownerPublicId, controller.readVersion); }
  useEffect(() => {
    if (open) entryPrompt.current?.dismiss();
    if (entryPrompt.current?.shouldOpen(controller, isOnline)) onOpenChange(true);
  }, [controller, isOnline, open, onOpenChange]);
  const names = Object.fromEntries(economy.snapshot?.catalog.items.map(item => [item.id, item.name]) ?? []);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPortal><DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}>
        <header className={styles.header}><DialogTitle><CalendarDays size={22} aria-hidden="true" />Подарки за вход</DialogTitle><DialogPrimitive.Close aria-label="Закрыть подарки"><X size={20} aria-hidden="true" /></DialogPrimitive.Close></header>
        <DialogDescription className={styles.sr}>Семь подарков за возвращение в лес. Каждый подарок нужно забрать вручную.</DialogDescription>
        <DailyRewardsPanel controller={controller} isOnline={isOnline} names={names} />
      </DialogPrimitive.Content>
    </DialogPortal></Dialog>;
}
