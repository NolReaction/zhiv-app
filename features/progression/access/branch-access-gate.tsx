"use client";

import { apiFetch } from "@/lib/api-fetch";

import { lazy, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import type { AdminPageAccess } from "@/lib/server/admin-page-access";
import { withRequestDeadline } from "@/lib/request-deadline";
import styles from "./branch-access-gate.module.css";

const Workspace = lazy(() => import("../branch-page").then(module => ({ default: module.BranchPage })));
type Access = AdminPageAccess | { status: "checking" };

export function BranchAccessGate({ initial }: { initial: AdminPageAccess }) {
  const [access, setAccess] = useState<Access>(initial);
  useEffect(() => {
    if (initial.status !== "allowed") return;
    const actorId = initial.publicId;
    let active = true, busy = false;
    const controller = new AbortController();
    async function verify() {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const next = await withRequestDeadline(8000, controller.signal, async signal => {
          const response = await apiFetch("/api/v1/admin/access", { credentials: "same-origin", cache: "no-store", signal });
          if (response.status === 401) return { status: "signed-out" } as const;
          if (response.status === 403) return { status: "forbidden" } as const;
          if (!response.ok) return { status: "unavailable" } as const;
          const value: unknown = await response.json();
          return value && typeof value === "object" && "publicId" in value && value.publicId === actorId
            ? initial : { status: "forbidden" } as const;
        });
        if (active) setAccess(previous => previous.status === next.status ? previous : next);
      } catch { if (active) setAccess({ status: "unavailable" }); }
      finally { busy = false; }
    }
    const onVisibility = () => { if (document.visibilityState === "visible") { setAccess({ status: "checking" }); void verify(); } };
    const onRestore = (event: PageTransitionEvent) => { if (event.persisted) { setAccess({ status: "checking" }); void verify(); } };
    void verify();
    const timer = window.setInterval(() => { void verify(); }, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onRestore);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pageshow", onRestore); };
  }, [initial]);

  // Keep form state during a visibility recheck, but hide it until access is confirmed.
  const retainWorkspace = initial.status === "allowed" && (access.status === "allowed" || access.status === "checking");
  const title = access.status === "signed-out" ? "Войдите в аккаунт администратора" : access.status === "forbidden" ? "Доступ закрыт" : access.status === "checking" ? "Проверяем доступ" : "Не удалось проверить доступ";
  return <>{retainWorkspace && <div hidden={access.status === "checking"} inert={access.status === "checking"} style={access.status === "checking" ? { display: "none" } : undefined}>
    <Suspense fallback={<div className={styles.loading} role="status">Загружаем рабочие разделы…</div>}><Workspace /></Suspense>
  </div>}{access.status !== "allowed" && <main className={styles.page}><section className={styles.card}>
    <Link href="/" className={styles.back}><ArrowLeft size={18} />В приложение</Link>
    <ShieldCheck size={32} aria-hidden="true" /><p className={styles.label}>Внутренняя мастерская</p><h1>{title}</h1>
    <p>{access.status === "checking" ? "Подключаемся к серверу…" : "Раздел /branch доступен с теми же правами, что и панель управления."}</p>
    {access.status !== "checking" && <div className={styles.actions}><Link href="/admin">Открыть управление</Link><button type="button" onClick={() => window.location.reload()}>Проверить снова</button></div>}
  </section></main>}</>;
}
