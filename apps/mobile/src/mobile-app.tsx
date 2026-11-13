import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppNotifications } from "@/components/app-notifications";
import { MobileGestureGuard } from "@/components/mobile-gesture-guard";
import { BRAND_LOGO_SRC } from "@/lib/brand-assets";
import type { MobileSession } from "./mobile-session";
import { getNativeSettingsStatus, subscribeNativeSettings } from "./native-storage";
import BundledImage from "./compat/image";
import "@/app/globals.css";
import "./style.css";

const DeviceLab = lazy(() => import("./device-lab").then(module => ({ default: module.DeviceLab })));
const AppShell = lazy(() => import("@/features/app/app-shell").then(module => ({ default: module.AppShell })));

class GameBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="mobile-start"><h1>Не удалось открыть полянку</h1><p>Ваш подтверждённый прогресс остаётся в аккаунте. Перезапустите приложение.</p><button onClick={() => window.location.reload()}>Перезапустить</button></main>;
    return this.props.children;
  }
}

export function MobileApplication({ session }: { session: MobileSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const settings = useSyncExternalStore(subscribeNativeSettings, getNativeSettingsStatus, getNativeSettingsStatus);
  const [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => {
    const open = () => setDiagnostics(true);
    window.addEventListener("mochlik:open-diagnostics", open);
    return () => window.removeEventListener("mochlik:open-diagnostics", open);
  }, []);
  const login = () => { void session.login().catch(() => {}); };
  return <>
    <MobileGestureGuard />
    <div inert={diagnostics} aria-hidden={diagnostics || undefined}>
      {state.phase === "authenticated" ? <GameBoundary key={`${state.userId}:${state.generation}`}><Suspense fallback={<main className="mobile-start" role="status">Открываем полянку…</main>}><AppShell /></Suspense></GameBoundary> :
        <main className="mobile-start" aria-busy={state.phase === "loading" || state.busy}>
          <BundledImage className="mobile-brand" src={BRAND_LOGO_SRC} width="124" height="124" alt="Мохлик" priority />
          <p className="mobile-eyebrow">МОХЛИК</p>
          <h1>{state.phase === "loading" ? "Открываем полянку…" : state.phase === "error" ? "Не удалось запустить приложение" : "Ваш лес всегда рядом"}</h1>
          {state.phase === "signed-out" && <><p>Войдите в свой аккаунт через ВК или почту. Ваш Мохлик, друзья и прогресс появятся здесь.</p>
            <button disabled={state.busy} onClick={login}>{state.busy ? "Ожидаем вход…" : "Войти в аккаунт"}</button>
            {state.busy && <button className="mobile-secondary" onClick={() => { void session.cancelLogin().catch(() => {}); }}>Отменить вход</button>}
            <p className="mobile-caption">Вход откроется в защищённом окне браузера. После подтверждения вернитесь в приложение.</p></>}
          {state.error && <p role="alert">{state.error}</p>}
          {state.phase === "error" && <button onClick={() => { void session.refresh(); }}>Повторить</button>}
          {state.phase !== "loading" && <button className="mobile-secondary" onClick={() => setDiagnostics(true)}>Проверить устройство</button>}
        </main>}
    </div>
    {settings.error && <div className="mobile-storage-warning" role="status">Не удалось сохранить часть настроек. Не закрывайте приложение и повторите изменение.</div>}
    {diagnostics && <div className="mobile-diagnostics" role="dialog" aria-modal="true" aria-label="Проверка устройства">
      <button className="mobile-diagnostics-close" onClick={() => setDiagnostics(false)}>Вернуться в Мохлика</button>
      <Suspense fallback={<p className="mobile-start" role="status">Открываем проверку…</p>}><DeviceLab /></Suspense>
    </div>}
    <AppNotifications />
  </>;
}
