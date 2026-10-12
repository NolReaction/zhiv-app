"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Download, ExternalLink, Smartphone } from "lucide-react";
import { copyText } from "@/lib/identity-sharing";
import { INSTALL_GUIDES, INSTALL_GUIDE_OPTIONS, suggestedInstallGuide, type InstallGuideId } from "./install-platform";
import { usePwaInstall } from "./install-provider";
import styles from "./install.module.css";

export function InstallPanel({ compact = false }: { compact?: boolean }) {
  const installation = usePwaInstall();
  return <InstallPanelContent installation={installation} compact={compact} />;
}

export function InstallPanelContent({ installation, compact = false }: { installation: ReturnType<typeof usePwaInstall>; compact?: boolean }) {
  const [selected, setSelected] = useState<InstallGuideId | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const nativeRequested = useRef(false);
  const selector = useRef<HTMLSelectElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const id = useId();
  const guideId = selected ?? suggestedInstallGuide(installation.device);
  const guide = INSTALL_GUIDES[guideId];
  useEffect(() => {
    if (!nativeRequested.current || installation.busy || installation.outcome === "idle") return;
    nativeRequested.current = false;
    // The native trigger disappears after use. Restore lost focus without
    // interrupting someone who has already moved to another control.
    if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
    const target = installation.outcome === "accepted" ? status.current : selector.current;
    target?.focus({ preventScroll: true });
  }, [installation.busy, installation.outcome]);
  async function copyAddress() {
    // Do not copy invitations, callback state or another user's notification link.
    const address = window.location.origin + "/";
    setCopyStatus(await copyText(address) ? "Адрес скопирован" : `Скопируйте адрес вручную: ${address}`);
  }
  const instructions = <>
    <div className={styles.guide}>
      <label htmlFor={`${id}-device`}>Инструкция для вашего устройства</label>
      <select ref={selector} id={`${id}-device`} value={guideId} onChange={event => setSelected(event.target.value as InstallGuideId)}>
        {INSTALL_GUIDE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <h3>{guide.title}</h3>
      <ol>{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <p className={styles.note}>{guide.note}</p>
    </div>
    <p className={styles.accountNote}>Уже играли? После установки войдите прежним способом — через привязанные ВК или почту. В другом браузере может потребоваться повторный вход.</p>
    <button type="button" className={styles.copy} onClick={() => void copyAddress()}><Copy size={15} aria-hidden="true" />Скопировать адрес сайта</button>
    <span className={styles.copyStatus} role="status">{copyStatus}</span>
  </>;
  return <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-labelledby={`${id}-title`} data-install-panel>
    <div className={styles.panelHeading}><span className={styles.panelIcon}><Smartphone size={22} aria-hidden="true" /></span><div>
      <p className={styles.eyebrow}>Всегда под рукой</p>
      <h2 id={`${id}-title`}>{installation.standalone ? "Вы уже в приложении" : "Установить «Я живой»"}</h2>
    </div></div>
    <p className={styles.description}>{installation.standalone ? "Это отдельное окно приложения. Можно возвращаться на свою полянку прямо со значка." : "Значок на экране, отдельное окно и ваша полянка в одно касание. Без магазина приложений."}</p>
    {installation.standalone ? <Link href="/" prefetch={false} className={styles.primary}>Вернуться на полянку<ArrowRight size={18} aria-hidden="true" /></Link> : <>
      {installation.device.embedded && <div className={styles.notice}><ExternalLink size={18} aria-hidden="true" /><p>Похоже, сайт открыт внутри другого приложения. В его меню выберите «Открыть в браузере», затем вернитесь к инструкции.</p></div>}
      {!installation.secure && <p className={styles.notice}>Для установки нужен защищённый адрес HTTPS. На обычном локальном HTTP установка может быть недоступна.</p>}
      {installation.canInstall || installation.busy ? <button className={styles.primary} type="button" disabled={installation.busy} onClick={() => { nativeRequested.current = true; void installation.install(); }}><Download size={18} aria-hidden="true" />{installation.busy ? "Ожидаем ответ браузера…" : "Установить приложение"}</button> : null}
      <div ref={status} className={styles.status} role="status" aria-live="polite" tabIndex={-1}>
        {(installation.outcome === "accepted" || installation.installedHere) && <p><Check size={18} aria-hidden="true" />{installation.installedHere ? "Приложение добавлено. Закройте эту вкладку и запустите «Я живой» со значка." : "Запрос принят. Завершите установку в браузере и запустите «Я живой» с появившегося значка."}</p>}
        {installation.outcome === "dismissed" && <p>Установку можно закончить позже через меню браузера. Инструкция остаётся ниже.</p>}
        {installation.outcome === "error" && <p>Браузер не завершил установку. Используйте его меню по инструкции ниже.</p>}
      </div>
    </>}
    {installation.standalone ? <details className={styles.otherDevice}><summary>Установить на другом устройстве</summary>{instructions}</details> : instructions}
  </section>;
}
