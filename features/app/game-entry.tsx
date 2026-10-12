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
  useEffect(() => {
    let disposed = false;
    void import("./app-shell").then(module => {
      if (!disposed) setGame(() => module.AppShell);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, []);
  if (Game) return <Game />;
  return <main className={styles.loading} aria-busy={!failed}>
    <p role="status">{failed ? "Не удалось загрузить приложение" : "Загружаем полянку…"}</p>
    {failed && <><p>Проверьте подключение и повторите попытку. Ваш прогресс остаётся в аккаунте.</p>
      <button type="button" onClick={() => window.location.reload()}>Повторить загрузку</button></>}
  </main>;
}

function GameRuntime() {
  preload(runtimeArt.homePreview, { as: "image", fetchPriority: "high" });
  return <><MobileGestureGuard /><ServiceWorkerShellWarmup /><AppLifecycle /><GameLoader /></>;
}

export function GameEntry() {
  return <InstallationGate><GameRuntime /></InstallationGate>;
}
