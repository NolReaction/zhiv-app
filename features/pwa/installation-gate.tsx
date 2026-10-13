"use client";

/* eslint-disable @next/next/no-img-element -- The preloaded versioned brand artwork is shared by Sites and Next. */

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight, Sprout } from "lucide-react";
import { BRAND_LOGO_SRC } from "@/lib/brand-assets";
import { InstallPanel } from "./install-panel";
import { usePwaInstall } from "./install-provider";
import styles from "./install.module.css";

/** Desktop browsers enter directly; mobile visitors can install or continue. */
export function InstallationGate({ children }: { children: ReactNode }) {
  const installation = usePwaInstall();
  const continued = useRef(false);
  useEffect(() => {
    if (!continued.current || !installation.browserAllowed) return;
    const frame = requestAnimationFrame(() => {
      continued.current = false;
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      // AppStartup takes over focus again once the game is ready.
      const target = document.querySelector<HTMLElement>("[data-startup-splash], [data-app-content]:not([inert]) h1, [data-app-content]:not([inert]) main");
      if (!target) return;
      const hadTabIndex = target.hasAttribute("tabindex");
      if (!hadTabIndex) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      if (!hadTabIndex) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [installation.browserAllowed]);
  if (!installation.ready) return <main className={styles.loading}><Sprout size={32} aria-hidden="true" /><p role="status">Открываем «Я живой»…</p><a href="/site" className={styles.loadingLink}>О приложении и установке</a><noscript>Для запуска приложения включите JavaScript в настройках браузера.</noscript></main>;
  if (installation.standalone || installation.browserAllowed) return children;
  return <main className={styles.gate} data-installation-gate>
    <div className={styles.intro}>
      <a href="/site" className={styles.brand}><Sprout size={24} aria-hidden="true" />Я живой</a>
      <img className={styles.gateArtwork} src={BRAND_LOGO_SRC} alt="Мохлик и друзья. Я живой" width={1024} height={1024} fetchPriority="high" decoding="async" draggable={false} />
      <p className={styles.eyebrow}>Ваш маленький мир рядом</p>
      <h1>Пусть полянка<br />будет под рукой.</h1>
      <p className={styles.lead}>Добавьте «Я живой» на экран устройства. Возвращайтесь к Мохлику и сообщайте близким, что у вас всё хорошо.</p>
      <a href="/site" className={styles.siteLink}>Познакомиться с приложением <ArrowRight size={17} aria-hidden="true" /></a>
    </div>
    <div className={styles.gatePanel}><InstallPanel compact /></div>
    <div className={styles.gateActions}>
      <button className={styles.browserButton} type="button" onClick={() => { continued.current = true; installation.allowBrowser(); }}>Продолжить в браузере</button>
      <p className={styles.browserHint}>Установить можно позже: инструкция всегда доступна на сайте приложения.</p>
    </div>
  </main>;
}
