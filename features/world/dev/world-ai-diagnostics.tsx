"use client";

import { useState } from "react";
import { useForestObservation } from "../use-forest-observation";
import { createForestAiReport, ForestAiDiagnostics } from "./forest-ai-diagnostics";
import styles from "./world-dev-panel.module.css";

/** Mounted only inside an open DEV drawer: the closed panel does not subscribe. */
export function WorldAiDiagnostics({ presenceKey }: { presenceKey?: string }) {
  const observation = useForestObservation(presenceKey);
  const [feedback, setFeedback] = useState("");

  function download() {
    if (!observation) return;
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const report = createForestAiReport(observation);
      url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }));
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mochlik-ai-${report.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      setFeedback("Файл диагностики подготовлен. Его можно приложить к описанию бага.");
    } catch {
      setFeedback("Не удалось скачать диагностику. Можно сделать снимок этой панели.");
    } finally {
      anchor?.remove();
      if (url) {
        const objectUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      }
    }
  }

  return <>
    <ForestAiDiagnostics observation={observation} onExport={download} />
    {feedback && <p className={styles.hint} role="status">{feedback}</p>}
  </>;
}
