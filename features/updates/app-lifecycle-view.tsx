"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw, Sprout, Wrench } from "lucide-react";
import { AppLifecycleController, browserAppLifecycleEnvironment, INITIAL_APP_LIFECYCLE, type AppLifecycleState } from "./app-lifecycle";
import styles from "./app-lifecycle.module.css";

export function AppLifecycleContent({ state, onRetry }: { state: AppLifecycleState; onRetry: () => void }) {
  const maintenance = state.phase === "maintenance", updating = state.phase === "updating";
  return <div className={styles.card}>
    <div className={styles.icon} aria-hidden="true">{maintenance ? <Wrench size={28} /> : <Sprout size={32} />}</div>
    <p className={styles.brand}>Я ЖИВОЙ</p>
    <h1 id="app-lifecycle-title" tabIndex={-1} autoFocus>{maintenance ? "Скоро вернёмся" : updating ? "Приложение обновляется" : state.phase === "blocked" ? "Сохраняем ваши данные" : "Обновление ждёт подключения"}</h1>
    <p id="app-lifecycle-description">{maintenance ? state.message || "Устанавливаем обновление. Приложение откроется автоматически, как только всё будет готово."
      : updating ? "Новая версия готова. Через несколько секунд откроем её автоматически."
      : state.phase === "blocked" ? "Не удалось сохранить данные перед обновлением. Освободите место на устройстве и повторите попытку."
      : state.phase === "retry" ? "Новая версия пока не загрузилась. Проверьте соединение и попробуйте ещё раз."
      : "Проверьте интернет. Продолжим обновление, когда связь восстановится."}</p>
    <p className={styles.hint}>Аккаунт и сохранённый прогресс остаются на месте.</p>
    {!updating && <button type="button" onClick={onRetry}><RefreshCw size={17} aria-hidden="true" />{maintenance ? "Проверить готовность" : "Повторить"}</button>}
    {updating && <div className={styles.progress} role="status" aria-label="Загружаем обновление"><span /></div>}
  </div>;
}

export function AppReloadDeferred({ onRetry }: { onRetry: () => void }) {
  return <aside className={styles.deferred} role="status">
    <p><strong>Обновление отложено</strong><span>Не удалось сохранить данные. Сохраните или скопируйте черновик, затем повторите попытку.</span></p>
    <button type="button" onClick={onRetry}>Повторить</button>
  </aside>;
}

export function AppLifecycle() {
  const [controller] = useState(() => new AppLifecycleController(process.env.NEXT_PUBLIC_APP_BUILD_ID ?? "development", browserAppLifecycleEnvironment()));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, () => INITIAL_APP_LIFECYCLE);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  const blocking = state.phase !== "ready" && state.phase !== "blocked";
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (blocking && !element.open) element.showModal();
    if (!blocking && element.open) element.close();
  }, [blocking]);
  return <>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="app-lifecycle-title" aria-describedby="app-lifecycle-description" onCancel={event => event.preventDefault()}>
      {blocking && <AppLifecycleContent state={state} onRetry={controller.retry} />}
    </dialog>
    {state.phase === "blocked" && <AppReloadDeferred onRetry={controller.retry} />}
  </>;
}
