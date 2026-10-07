"use client";

/* eslint-disable @next/next/no-img-element -- The optimized brand asset loads identically in Sites and Next, with explicit decode readiness. */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { BRAND_LOGO_SRC } from "@/lib/brand-assets";
import styles from "./startup-splash.module.css";

export const SPLASH_ENTER_MS = 900;
export const SPLASH_EXIT_MS = 520;

export type StartupSplashProps = {
  phase: "entering" | "loading" | "leaving";
  progress: number;
  message: string;
  detail?: string | null;
  retryAvailable: boolean;
  onRetry: () => void;
  onLogoReady: () => void;
};

const LEAF_COUNT = 12;
const FIREFLIES = [
  [18, 28, 0, 5.7], [77, 19, 1.2, 6.4], [88, 55, 2.1, 7.2],
  [12, 64, 3.1, 6.8], [68, 76, 0.7, 5.9], [34, 16, 2.7, 7.4],
  [29, 83, 1.8, 6.1], [83, 84, 3.6, 7.7],
];

function Leaf() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M20.5 3.5C11 1.5 3.1 5 3.5 12.3c.2 4.6 3.8 7.8 8.2 7.3C19 18.8 21.3 11.6 20.5 3.5Z" fill="currentColor" />
    <path d="m4.2 20 11-11.6m-6.6 7 .1-4.3m3.1 1.1 4.1-.1" stroke="var(--leaf-vein)" strokeWidth="1.3" strokeLinecap="round" />
  </svg>;
}

/** Presentation only: asset retries and the one-shot app-entry lifecycle live in the startup gate. */
export function StartupSplash({ phase, progress, message, detail, retryAvailable, onRetry, onLogoReady }: StartupSplashProps) {
  const [logoState, setLogoState] = useState<"loading" | "ready" | "failed">("loading");
  const logoSettled = useRef(false);
  const logoDecoding = useRef(false);
  const safeProgress = Math.round(Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0)));

  const finishLogo = useCallback((loaded: boolean) => {
    if (logoSettled.current) return;
    logoSettled.current = true;
    setLogoState(loaded ? "ready" : "failed");
    onLogoReady();
  }, [onLogoReady]);

  const handleLogoLoad = useCallback((element: HTMLImageElement) => {
    if (logoDecoding.current || logoSettled.current) return;
    logoDecoding.current = true;
    // Do not spend the entrance animation waiting for the image decoder.
    const decoded = typeof element.decode === "function" ? element.decode() : Promise.resolve();
    void decoded.catch(() => undefined).then(() => finishLogo(element.naturalWidth > 0));
  }, [finishLogo]);

  const captureLogo = useCallback((element: HTMLImageElement | null) => {
    if (!element?.complete) return;
    if (element.naturalWidth > 0) handleLogoLoad(element);
    else finishLogo(false);
  }, [finishLogo, handleLogoLoad]);

  useEffect(() => {
    // Branding is decorative: a stalled image must not trap an otherwise ready app.
    const timer = setTimeout(() => finishLogo(false), 10_000);
    return () => clearTimeout(timer);
  }, [finishLogo]);

  return <section
    className={styles.splash}
    data-startup-splash=""
    data-phase={phase}
    data-logo-ready={logoState !== "loading"}
    aria-label="Запуск приложения Я живой"
    style={{ "--splash-enter-ms": `${SPLASH_ENTER_MS}ms`, "--splash-exit-ms": `${SPLASH_EXIT_MS}ms` } as CSSProperties}
  >
    <div className={styles.backdrop} aria-hidden="true" />
    <div className={styles.atmosphere} aria-hidden="true">
      <div className={styles.foliage}><i /><i /><i /></div>
      <div className={`${styles.foliage} ${styles.foliageOpposite}`}><i /><i /><i /></div>
      {FIREFLIES.map(([left, top, delay, duration], index) => <i
        key={index}
        className={styles.firefly}
        style={{ left: `${left}%`, top: `${top}%`, animationDelay: `-${delay}s`, animationDuration: `${duration}s` }}
      />)}
    </div>

    <div className={styles.content}>
      <div className={styles.stage}>
        <span className={styles.seed} aria-hidden="true" />
        <span className={styles.ripple} aria-hidden="true" />
        <div className={styles.logo} data-ready={logoState !== "loading"}>
          {logoState === "failed" ? <div className={styles.logoFallback}>
            <span aria-hidden="true"><Leaf /></span>
            <h1>Я живой</h1>
          </div> : <img
            ref={captureLogo}
            src={BRAND_LOGO_SRC}
            alt="Я живой — Мохлик и его друзья"
            width={1024}
            height={1024}
            fetchPriority="high"
            loading="eager"
            decoding="async"
            draggable={false}
            onLoad={event => handleLogoLoad(event.currentTarget)}
            onError={() => finishLogo(false)}
          />}
        </div>
      </div>

      <div className={styles.loading}>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="Подготовка игрового мира"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safeProgress}
          aria-valuetext={`${safeProgress}% — ${message}`}
        >
          <div className={styles.vine} aria-hidden="true">
            <span style={{ transform: `scaleX(${safeProgress / 100})` }} />
          </div>
          <div className={styles.leaves} aria-hidden="true">
            {Array.from({ length: LEAF_COUNT }, (_, index) => {
              const filled = Math.min(1, Math.max(0, safeProgress / 100 * LEAF_COUNT - index));
              return <span className={styles.leaf} key={index} data-filled={filled > 0}>
                <Leaf />
                <span className={styles.litLeaf} style={{ opacity: filled }}><Leaf /></span>
              </span>;
            })}
          </div>
        </div>

        <div className={styles.status} role="status" aria-live="polite" aria-atomic="true">
          <p className={styles.message}>{message}</p>
          {detail && <p className={styles.detail}>{detail}</p>}
        </div>
        {retryAvailable && <button className={styles.retry} type="button" onClick={onRetry}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 8a8 8 0 1 0 .1 7M20 3v5h-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Попробовать сейчас
        </button>}
      </div>
    </div>
  </section>;
}
