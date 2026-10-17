"use client";

import { getAdminPlayer, getAdminSecurity, verifyAdminActor, type AdminSecurity, type AdminSecuritySignal, type AdminUser } from "./admin-api";
import styles from "./admin-security.module.css";

const dates = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const numbers = new Intl.NumberFormat("ru-RU");
const categories: Record<AdminSecuritySignal["code"], string> = {
  ECONOMY_REQUEST_TAMPER: "Изменённое игровое действие",
  MARKET_OWNERSHIP_DENIED: "Доступ к чужому объявлению",
  BARTER_OWNERSHIP_DENIED: "Доступ к чужому обмену",
};
const statusLabels: Record<AdminSecuritySignal["status"], string> = {
  active: "Требует проверки", context: "Контекст, порог не достигнут", reviewed: "Отметка снята администратором",
};
const time = (value: string) => `${dates.format(new Date(value))} UTC`;

export function adminReviewReasons(user: Pick<AdminUser, "watchlisted" | "tapSignalAt" | "securitySignalAt">) {
  return [user.watchlisted ? "Наблюдение" : null, user.tapSignalAt ? "Проверить клики" : null,
    user.securitySignalAt ? "Проверить операции" : null].filter((value): value is string => value !== null);
}

/** Verify both sides of a read: an old response must never become the next administrator's snapshot. */
export async function loadAdminPlayerReview(actorPublicId: string, targetPublicId: string, signal: AbortSignal) {
  await verifyAdminActor(actorPublicId, signal);
  const [player, security] = await Promise.all([getAdminPlayer(targetPublicId, signal), getAdminSecurity(targetPublicId, signal)]);
  if (signal.aborted) throw new DOMException("Запрос отменён", "AbortError");
  await verifyAdminActor(actorPublicId, signal);
  return { player, security };
}

export function AdminSecuritySummary({ user, onOpen }: { user: Pick<AdminUser, "watchlisted" | "tapSignalAt" | "securitySignalAt" | "displayName">; onOpen: () => void }) {
  const reasons = adminReviewReasons(user);
  if (!reasons.length) return null;
  return <button type="button" className={styles.summaryButton} onClick={onOpen}
    aria-label={`Причины наблюдения: ${user.displayName}. ${reasons.join(". ")}`}>
    {reasons.map(reason => <span key={reason}>{reason}</span>)}<small>Причины и проверка</small>
  </button>;
}

function Signal({ signal }: { signal: AdminSecuritySignal }) {
  return <details className={styles.signal} data-status={signal.status} open={signal.status === "active"}>
    <summary><span><strong>{categories[signal.code]}</strong><span className={styles.status}>{statusLabels[signal.status]}</span></span>
      <span className={styles.count}>{numbers.format(signal.count)} событий</span></summary>
    <div className={styles.signalBody}>
      <p>{signal.reason}</p>
      <dl className={styles.facts}>
        <div><dt>После последней проверки{signal.windowMinutes ? ` · окно ${signal.windowMinutes} мин.` : ""}</dt>
          <dd>{numbers.format(signal.pendingCount)} / {numbers.format(signal.threshold)} до порога</dd></div>
        <div><dt>За время наблюдения</dt><dd>{numbers.format(signal.count)} событий</dd></div>
        <div><dt>Первое событие</dt><dd><time dateTime={signal.firstAt}>{time(signal.firstAt)}</time></dd></div>
        <div><dt>Последнее событие</dt><dd><time dateTime={signal.lastAt}>{time(signal.lastAt)}</time></dd></div>
        {signal.reviewedAt && <div><dt>Последнее снятие отметки</dt><dd><time dateTime={signal.reviewedAt}>{time(signal.reviewedAt)}</time></dd></div>}
        <div><dt>Последнее действие</dt><dd><code>{signal.lastAction}</code></dd></div>
        <div className={styles.fullWidth}><dt>ID последнего запроса</dt><dd><code>{signal.lastRequestId}</code></dd></div>
      </dl>
      <small className={styles.hint}>Код: <code>{signal.code}</code>. Запросы отклонены сервером; это основание изучить действия, а не доказательство нарушения.</small>
    </div>
  </details>;
}

export function AdminSecurityContent({ detail, canManage, locked, onClear, onWatch }: {
  detail: AdminSecurity; canManage: boolean; locked: boolean; onClear: () => void; onWatch: () => void;
}) {
  const active = detail.signals.filter(signal => signal.status === "active").length;
  const context = detail.signals.filter(signal => signal.status === "context").length;
  const reviewed = detail.signals.filter(signal => signal.status === "reviewed").length;
  const hasAutomatic = Boolean(detail.tapSignalAt || detail.securitySignalAt || detail.signals.some(signal => signal.status !== "reviewed"));
  return <section className={styles.panel} aria-label="Причины наблюдения за игроком">
    <div className={styles.heading}><h3>Наблюдение и проверка</h3><p>Сигналы помогают выбрать действия для ручной проверки. Автобана и автоматического списания наград нет.</p></div>
    <div className={styles.overview} aria-label="Сводка наблюдения">
      <span>Операции на проверку<strong>{active}</strong></span><span>Контекст<strong>{context}</strong></span><span>Отметки сняты<strong>{reviewed}</strong></span>
    </div>
    <div className={styles.manual}>
      <strong>{detail.watchlisted ? "Наблюдение включено" : "Отметка наблюдения не установлена"}</strong>
      {detail.watchlisted && <p>Причина: {detail.manualWatchReason || "В старой записи причина не сохранена."}</p>}
      <button type="button" disabled={locked || !canManage} onClick={onWatch}>{detail.watchlisted ? "Снять отметку наблюдения" : "Пометить для наблюдения"}</button>
    </div>
    {detail.tapSignalAt && <div className={styles.tapSignal}><strong>Равномерная активность кликов</strong><p>Сигнал от <time dateTime={detail.tapSignalAt}>{time(detail.tapSignalAt)}</time>. Сопоставьте интервалы, длительность и задержки доставки во вкладке «Клики».</p></div>}
    {!detail.signals.length && <p className={styles.hint}>Серверных сигналов по операциям пока нет. История начинается с установки защиты; прежние действия не восстановлены.</p>}
    {detail.signals.map(signal => <Signal key={signal.code} signal={signal} />)}
    {hasAutomatic && <div className={styles.clear}>
      <button type="button" disabled={locked || !canManage} onClick={onClear}>Снять автоматические отметки</button>
      <p className={styles.hint}>Причина и ID выше обязательны. История операций сохранится; новое событие может снова потребовать проверки. Отметка наблюдения снимается отдельно.</p>
    </div>}
    <p className={styles.hint}>Снимок: <time dateTime={detail.serverTime}>{time(detail.serverTime)}</time>. Совпадающие повторы, устаревшая версия состояния и нехватка ресурсов сами по себе не означают нарушение.</p>
  </section>;
}
