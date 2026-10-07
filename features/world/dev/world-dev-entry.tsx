"use client";

import { Component, type ComponentType } from "react";
import { FlaskConical, X } from "lucide-react";
import type { WorldDevPanelProps } from "./world-dev-panel";
import styles from "./world-dev-panel.module.css";

type PanelModule = { default: ComponentType<WorldDevPanelProps> };
const loadDevelopmentPanel = process.env.NODE_ENV === "development"
  ? () => import("./world-dev-panel") : null;
type Props = WorldDevPanelProps & { loadPanel?: () => Promise<PanelModule> };
type State = {
  Panel: ComponentType<WorldDevPanelProps> | null;
  pending: boolean;
  failed: boolean;
  noticeOpen: boolean;
};

/** Load optional diagnostics on demand; a failed DEV chunk must not take down the game. */
export class WorldDevEntry extends Component<Props, State> {
  state: State = { Panel: null, pending: false, failed: false, noticeOpen: false };
  private mounted = false;

  componentDidMount() { this.mounted = true; }
  componentWillUnmount() { this.mounted = false; }

  static getDerivedStateFromError(): Partial<State> {
    return { Panel: null, pending: false, failed: true, noticeOpen: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("DEV panel is unavailable; the game remains open.", error);
  }

  open = async () => {
    const load = this.props.loadPanel ?? loadDevelopmentPanel;
    if (!load || this.state.pending) return;
    if (this.state.failed) {
      this.setState(state => ({ noticeOpen: !state.noticeOpen }));
      return;
    }
    this.setState({ pending: true });
    try {
      const panelModule = await load();
      if (this.mounted) this.setState({ Panel: panelModule.default, pending: false });
    } catch (error) {
      if (this.mounted) {
        this.setState({ pending: false, failed: true, noticeOpen: true });
        this.componentDidCatch(error);
      }
    }
  };

  render() {
    if (!loadDevelopmentPanel) return null;
    const { Panel, pending, failed, noticeOpen } = this.state;
    if (Panel) return <Panel {...this.props} initiallyOpen />;
    if (this.props.active === false) return null;
    return <aside className={styles.root} data-world-view={this.props.worldView || undefined} aria-label="Инструменты разработчика">
      <div className={styles.toolbar}>
        <button type="button" className={styles.trigger} disabled={pending}
          aria-label="Панель разработчика" aria-expanded={failed && noticeOpen} onClick={this.open}>
          <FlaskConical size={16} aria-hidden /><strong>{pending ? "Загрузка DEV…" : "DEV"}</strong>
        </button>
      </div>
      {failed && noticeOpen && <section className={styles.recovery} aria-label="Ошибка загрузки DEV">
        <p role="alert">DEV не загрузился. Перезапустите сервер разработки и обновите страницу.</p>
        <div>
          <button type="button" onClick={() => window.location.reload()}>Обновить страницу</button>
          <button type="button" onClick={() => this.setState({ noticeOpen: false })} aria-label="Закрыть сообщение DEV"><X size={16} aria-hidden />Закрыть</button>
        </div>
      </section>}
    </aside>;
  }
}
