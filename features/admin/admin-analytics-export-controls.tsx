"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { economyTime } from "./admin-economy-panel";
import { analyticsCount } from "./admin-analytics-utils";
import { downloadAdminAnalyticsExport, isExactAdminPlayerId, loadAdminAnalyticsExport,
  type AdminAnalyticsExportFilters, type AdminAnalyticsExportFormat, type AdminAnalyticsExportProgress } from "./admin-analytics-export";
import styles from "./admin-analytics.module.css";

type ExportState = { status: "idle" | "running" | "cancelled"; progress: AdminAnalyticsExportProgress }
  | { status: "done"; count: number; snapshotAt: string }
  | { status: "error"; message: string };

/** Mount with a new key whenever the actor or visible filter context changes. */
export function AdminAnalyticsExportControls({ actorPublicId, filters, disabled, onAccessLost }: {
  actorPublicId: string; filters: AdminAnalyticsExportFilters; disabled: boolean; onAccessLost: (error: ApiError) => void;
}) {
  const [scope, setScope] = useState<"filters" | "player">("filters");
  const [state, setState] = useState<ExportState>({ status: "idle", progress: { completed: 0, total: null } });
  const mounted = useRef(false), request = useRef<AbortController | null>(null), accessLost = useRef(onAccessLost);
  useLayoutEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); request.current = null; };
  }, []);
  const exactPlayer = isExactAdminPlayerId(filters.q), allTime = scope === "player" && exactPlayer;
  const running = state.status === "running";

  async function start(format: AdminAnalyticsExportFormat) {
    if (!mounted.current || disabled || request.current || scope === "player" && !exactPlayer) return;
    const controller = new AbortController(); request.current = controller;
    const current = () => mounted.current && request.current === controller && !controller.signal.aborted;
    const selected = allTime ? { ...filters, q: filters.q.trim().toUpperCase(), scope: "all" as const,
      kind: "", resource: "", direction: "all" as const, allTime: true } : { ...filters, allTime: false };
    setState({ status: "running", progress: { completed: 0, total: null } });
    try {
      const result = await loadAdminAnalyticsExport(actorPublicId, selected, format, controller.signal, progress => {
        if (current()) setState({ status: "running", progress });
      });
      if (!current()) return;
      downloadAdminAnalyticsExport(result);
      setState({ status: "done", count: result.count, snapshotAt: result.snapshotAt });
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        controller.abort(); request.current = null;
        setState({ status: "error", message: cause.message });
        accessLost.current(cause);
        return;
      }
      setState({ status: "error", message: cause instanceof ApiError ? cause.message : "Не удалось подготовить выгрузку. Повторите запрос." });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  function cancel() {
    if (!request.current) return;
    request.current.abort(); request.current = null;
    setState({ status: "cancelled", progress: { completed: 0, total: null } });
  }

  return <div className={styles.exportPanel} aria-label="Полная выгрузка операций" aria-busy={running}>
    <div className={styles.exportHeading}>
      <div><strong>Полная выгрузка</strong><p className={styles.note}>Все страницы журнала в одном файле. Снимок фиксируется при начале выгрузки.</p></div>
      <label className={styles.field}>Объём выгрузки<select value={scope} disabled={disabled || running} onChange={event => {
        setScope(event.target.value === "player" ? "player" : "filters");
        setState({ status: "idle", progress: { completed: 0, total: null } });
      }}>
        <option value="filters">По текущим фильтрам</option>
        <option value="player" disabled={!exactPlayer}>Вся история игрока</option>
      </select></label>
    </div>
    <p className={styles.note}>{allTime
      ? `Вся сохранённая история журнала игрока ${filters.q.trim().toUpperCase()}. Выгружаются все типы операций журнала и ресурсы, независимо от выбранных дат и остальных фильтров.`
      : `С ${filters.from} по ${filters.to}, UTC · ${filters.q ? `поиск: ${filters.q}` : "все игроки"}. Применяются выбранные операция, ресурс и направление.`}
      {!exactPlayer && " Для всей истории одного игрока укажите его точный ID или нажмите «Все операции игрока» в журнале."}</p>
    <div className={styles.exportActions}>
      <button type="button" className={styles.primaryButton} disabled={disabled || running} onClick={() => { void start("csv"); }}><Download size={16} aria-hidden="true" />CSV всех операций</button>
      <button type="button" className={styles.button} disabled={disabled || running} onClick={() => { void start("json"); }}><Download size={16} aria-hidden="true" />JSON для анализа</button>
      {running && <button type="button" className={styles.button} onClick={cancel}><X size={16} aria-hidden="true" />Отменить выгрузку</button>}
    </div>
    {running && <div className={styles.exportProgress} role="status" aria-live="polite"><LoaderCircle size={17} aria-hidden="true" />
      <span>{state.progress.total === null ? "Подготавливаем выгрузку…" : `Загружено ${analyticsCount(state.progress.completed)} из ${analyticsCount(state.progress.total)} операций`}</span>
      {state.progress.total !== null && state.progress.total > 0 && <progress max={state.progress.total} value={state.progress.completed} aria-label="Подготовка выгрузки" />}
    </div>}
    {state.status === "done" && <p className={styles.note} role="status">Выгружено {analyticsCount(state.count)} операций · снимок {economyTime(state.snapshotAt)}.</p>}
    {state.status === "cancelled" && <p className={styles.note} role="status">Выгрузка отменена. Файл не создан.</p>}
    {state.status === "error" && <p className={styles.warning} role="alert">{state.message} Неполный файл не сохраняется.</p>}
  </div>;
}
