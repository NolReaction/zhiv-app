"use client";

import { useEffect, useState } from "react";
import { progressionScenarioReportSchema, type ProgressionScenarioReport } from "@/features/progression/domain/economy-scenarios";
import { EconomyScenarioReport } from "./economy-scenario-report";
import styles from "./economy-scenario-report.module.css";

// The report contains internal simulation evidence and is never bundled into
// client assets. Each mount checks access again; leaving the tool aborts fetch.
export function ScenarioReportLoader() {
  const [report, setReport] = useState<ProgressionScenarioReport | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/branch/reports", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Доступ к отчёту закрыт. Войдите в панель администратора." : "Не удалось загрузить отчёт. Попробуйте ещё раз.");
        return progressionScenarioReportSchema.parse(await response.json());
      })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error && !reason.message.includes("[") ? reason.message : "Формат отчёта изменился. Обновите страницу."); });
    return () => controller.abort();
  }, [attempt]);
  if (report) return <EconomyScenarioReport report={report} />;
  return <section className={styles.report} aria-label="Отчёт прохождения">{error ? <><p role="alert">{error}</p><button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Повторить</button></> : <p role="status">Загружаем результаты прохождений…</p>}</section>;
}
