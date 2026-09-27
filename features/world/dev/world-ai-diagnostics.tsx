"use client";

import { useReducer, useState } from "react";
import { useForestObservation, type ForestObservation } from "../use-forest-observation";
import { createForestAiReport, ForestAiDiagnostics, type ForestAiEventFilter } from "./forest-ai-diagnostics";
import styles from "./world-dev-panel.module.css";

type InspectorState = {
  held: { observation: ForestObservation; capturedAt: number } | null;
  eventFilter: ForestAiEventFilter;
};
type InspectorAction = { type: "hold"; observation: ForestObservation | null; capturedAt: number }
  | { type: "live" } | { type: "filter"; value: ForestAiEventFilter };

/** The observer publishes detached, frozen values. Inspection only retains a read model. */
export function forestAiInspectorReducer(state: InspectorState, action: InspectorAction): InspectorState {
  if (action.type === "hold") return action.observation
    ? { ...state, held: { observation: action.observation, capturedAt: action.capturedAt } } : state;
  if (action.type === "live") return { ...state, held: null };
  return { ...state, eventFilter: action.value };
}

export function ForestAiInspectorControls({ capturedAt, ready, onHold, onResume, onExport }: {
  capturedAt: number | null; ready: boolean; onHold: () => void; onResume: () => void; onExport: () => void;
}) {
  return <div className={styles.aiInspectorControls}>
    <div className={styles.aiInspectorActions}>
      <button type="button" disabled={!ready} onClick={capturedAt === null ? onHold : onResume}>
        {capturedAt === null ? "Зафиксировать снимок" : "Обновлять данные"}
      </button>
      <button type="button" disabled={!ready} onClick={onExport}>Скачать JSON</button>
    </div>
    <p className={styles.hint} role="status">{capturedAt === null
      ? "Можно зафиксировать данные для разбора. Это не ставит лес на паузу."
      : <>Снимок зафиксирован в <time dateTime={new Date(capturedAt).toISOString()}>{new Date(capturedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>.
        {" "}Показаны данные на этот момент. Режим работы леса остаётся прежним.</>}</p>
  </div>;
}

/** Mounted only inside an open DEV drawer: the closed panel does not subscribe. */
export function WorldAiDiagnostics({ presenceKey }: { presenceKey?: string }) {
  // An account change must discard a held observation before any render or export.
  return <WorldAiInspector key={presenceKey ?? ""} presenceKey={presenceKey} />;
}

function WorldAiInspector({ presenceKey }: { presenceKey?: string }) {
  const observation = useForestObservation(presenceKey);
  const [inspector, dispatch] = useReducer(forestAiInspectorReducer, { held: null, eventFilter: "all" });
  const displayed = inspector.held?.observation ?? observation;
  const [feedback, setFeedback] = useState("");

  function download() {
    if (!displayed) return;
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const report = createForestAiReport(displayed, Date.now(), inspector.held?.capturedAt);
      url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }));
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mochlik-ai-${report.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      setFeedback("JSON содержит показанный снимок и все последние события, независимо от фильтра. Его можно приложить к описанию бага.");
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
    <ForestAiInspectorControls capturedAt={inspector.held?.capturedAt ?? null} ready={Boolean(displayed)}
      onHold={() => { dispatch({ type: "hold", observation, capturedAt: Date.now() }); setFeedback(""); }}
      onResume={() => { dispatch({ type: "live" }); setFeedback(""); }} onExport={download} />
    {feedback && <p className={styles.hint} role="status">{feedback}</p>}
    <ForestAiDiagnostics observation={displayed} eventFilter={inspector.eventFilter}
      onEventFilterChange={value => dispatch({ type: "filter", value })} />
  </>;
}
