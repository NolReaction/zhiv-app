"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { adminRequest, getAdminAudit, verifyAdminActor, type AdminAccess, type AdminAudit } from "./admin-api";
import { AdminNeighborPanel } from "./admin-neighbor-panel";
import { adminActionName, adminActionDetails } from "./admin-audit-details";
import { ApiError } from "@/lib/check-in-api";
import styles from "./admin-dashboard.module.css";
import neighborStyles from "./admin-neighbor-panel.module.css";

export function AdminLocalDashboard({ access, onAccessLost }: { access: AdminAccess; onAccessLost: (cause: ApiError) => void }) {
  const [tab, setTab] = useState<"neighbor" | "audit">("neighbor");
  const [audit, setAudit] = useState<AdminAudit | null>(null), [error, setError] = useState("");
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0);
  useEffect(() => {
    if (tab !== "audit") return;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      try {
        await verifyAdminActor(access.publicId, controller.signal);
        const result = await getAdminAudit({ offset, limit: 25 }, controller.signal);
        await verifyAdminActor(access.publicId, controller.signal);
        if (!controller.signal.aborted) { setAudit(result); setError(""); }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) onAccessLost(cause);
        else setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить журнал");
      }
    });
    return () => controller.abort();
  }, [access.publicId, onAccessLost, tab, offset, reload]);
  return <main className={styles.shell}>
    <div className={styles.stack}>
      <header className={neighborStyles.heading}><div><Link href="/" className={styles.backLink}>← В приложение</Link>
        <h1>Локальное управление</h1><p>{access.displayName} · {access.publicId}</p></div>
        <button className={neighborStyles.button} onClick={async () => {
          try { await adminRequest("local/lock", z.object({ locked: z.literal(true) }), undefined, {});
            onAccessLost(new ApiError("Локальный доступ закрыт", 403)); }
          catch (cause) { setError(cause instanceof ApiError ? cause.message : "Не удалось закрыть доступ"); }
        }}>Закрыть доступ</button></header>
      <p className={neighborStyles.notice}>Сервер разработки · данные хранятся в памяти и очищаются при перезапуске. Здесь доступны настоящее управление Берестом и журнал локальных операций. Производственные разделы админки открываются на сервере приложения.</p>
      <nav className={neighborStyles.actions} aria-label="Локальная панель">
        <button className={neighborStyles.button} aria-current={tab === "neighbor" ? "page" : undefined} onClick={() => setTab("neighbor")}>Лесной сосед</button>
        <button className={neighborStyles.button} aria-current={tab === "audit" ? "page" : undefined} onClick={() => { setTab("audit"); setReload(value => value + 1); }}>Журнал администратора</button>
      </nav>
      {error && <p role="alert" className={neighborStyles.error}>{error}</p>}
      {tab === "neighbor" ? <AdminNeighborPanel actorPublicId={access.publicId} onAccessLost={onAccessLost} local />
        : <section className={styles.panel}><h2>Журнал администратора</h2>
          {!audit ? <p role="status">Загружаем журнал…</p> : <>
            {audit.events.length === 0 && <p>Операций пока нет.</p>}
            {audit.events.map(event => <article key={event.requestId} className={neighborStyles.notice}>
              <strong>{adminActionName(event.action)}</strong><p>{event.reason}</p><p>{adminActionDetails(event.details ?? "")}</p>
              <small>{event.createdAt} · {event.actorPublicId} → {event.targetPublicId}</small><p className={neighborStyles.requestId}>{event.requestId}</p>
            </article>)}
            <div className={neighborStyles.actions}>
              <button className={neighborStyles.button} disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>Назад</button>
              <span>{audit.total} операций</span>
              <button className={neighborStyles.button} disabled={offset + 25 >= audit.total} onClick={() => setOffset(value => value + 25)}>Дальше</button>
            </div>
          </>}
        </section>}
    </div>
  </main>;
}
