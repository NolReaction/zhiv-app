"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { FlaskConical, Sun, X } from "lucide-react";
import type { WorldDevPanelProps } from "./world-dev-panel";
import { createWorldDevPanelLoader, type WorldDevPanelLoad } from "./world-dev-panel-loader";
import { WorldDevPanelBoundary } from "./world-dev-panel-boundary";
import styles from "./world-dev-panel.module.css";

const loadDevelopmentPanel = process.env.NODE_ENV === "development" ? () => import("./world-dev-panel") : null;
type Props = WorldDevPanelProps & { loadPanel?: WorldDevPanelLoad };

/** Hook state keeps the opened studio across generated-scene Fast Refresh. */
export function WorldDevEntry(props: Props) {
  const [loader] = useState(createWorldDevPanelLoader);
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getServerSnapshot);
  const load = props.loadPanel ?? loadDevelopmentPanel;
  useEffect(() => { loader.mount(); return () => loader.unmount(); }, [loader]);
  useEffect(() => { void loader.claimHandoff(load, Boolean(props.worldView), props.active !== false); }, [loader, load, props.worldView, props.active, state.pending, state.Panel]);
  if (!loadDevelopmentPanel) return null;
  const { Panel, pending, failed, noticeOpen, initialLightingStudio } = state;
  if (Panel) return <WorldDevPanelBoundary onError={loader.fail}><Panel {...props} initiallyOpen={!initialLightingStudio} initialLightingStudio={initialLightingStudio} /></WorldDevPanelBoundary>;
  if (props.active === false) return null;
  return <aside className={styles.root} data-world-view={props.worldView || undefined} aria-label="Инструменты разработчика">
    <div className={styles.toolbar}>
      <button type="button" className={styles.lightingTrigger} disabled={pending} aria-label="Студия" onClick={() => void loader.open(load, true)}><Sun size={16} aria-hidden /><strong>Студия</strong></button>
      <button type="button" className={styles.trigger} disabled={pending} aria-label="Панель разработчика" aria-expanded={failed && noticeOpen} onClick={() => void loader.open(load, false)}><FlaskConical size={16} aria-hidden /><strong>{pending ? "Загрузка DEV…" : "DEV"}</strong></button>
    </div>
    {failed && noticeOpen && <section className={styles.recovery} aria-label="Ошибка загрузки DEV">
      <p role="alert">DEV не загрузился. Перезапустите сервер разработки и обновите страницу.</p><div>
        <button type="button" onClick={() => window.location.reload()}>Обновить страницу</button>
        <button type="button" onClick={loader.closeNotice} aria-label="Закрыть сообщение DEV"><X size={16} aria-hidden />Закрыть</button>
      </div>
    </section>}
  </aside>;
}
