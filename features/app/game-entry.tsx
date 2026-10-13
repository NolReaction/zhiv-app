"use client";

import { useEffect, useState, type ComponentType } from "react";
import { preload } from "react-dom";
import { MobileGestureGuard } from "@/components/mobile-gesture-guard";
import { ServiceWorkerShellWarmup } from "@/components/service-worker-registration";
import { InstallationGate } from "@/features/pwa/installation-gate";
import { AppLifecycle } from "@/features/updates/app-lifecycle-view";
import runtimeArt from "@/features/world/runtime-art.json";
import styles from "./game-entry.module.css";

// The account, simulation and world chunks are requested only after entering.
export function GameLoader() {
  const [Game, setGame] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let disposed = false;
    // A network request can stay pending indefinitely. Offer recovery without
    // discarding a late successful load or changing auth/invite parameters.
    const timeout = window.setTimeout(() => { if (!disposed) setSlow(true); }, 30_000);
    void import("./app-shell").then(module => {
      window.clearTimeout(timeout);
      if (!disposed) setGame(() => module.AppShell);
    }).catch(() => { window.clearTimeout(timeout); if (!disposed) setFailed(true); });
    return () => { disposed = true; window.clearTimeout(timeout); };
  }, []);
  if (Game) return <Game />;
  return <main className={styles.loading} aria-busy={!failed && !slow}>
    <p role="status">{failed ? "Не удалось загрузить приложение" : slow ? "Загрузка занимает больше времени" : "Загружаем полянку…"}</p>
    {(failed || slow) && <><p>Проверьте подключение и повторите попытку. Ваш прогресс остаётся в аккаунте.</p>
      <button type="button" onClick={() => window.location.reload()}>Повторить загрузку</button>
      <a href="/site">На сайт приложения</a></>}
  </main>;
}

function GameRuntime() {
  preload(runtimeArt.homePreview, { as: "image", fetchPriority: "high" });
  return <><MobileGestureGuard /><ServiceWorkerShellWarmup /><AppLifecycle /><GameLoader /></>;
}

export function GameEntry() {
  return <InstallationGate><GameRuntime /></InstallationGate>;
}
