"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Copy, Download, ExternalLink, Monitor, Share2, Smartphone } from "lucide-react";
import { copyText } from "@/lib/identity-sharing";
import { INSTALL_GUIDES, INSTALL_GUIDE_OPTIONS, installDeviceLabel, installGuideForDevice, suggestedInstallGuide, type InstallGuideId } from "./install-platform";
import { usePwaInstall } from "./install-provider";
import styles from "./install.module.css";

export function InstallPanel({ compact = false }: { compact?: boolean }) {
  const installation = usePwaInstall();
  return <InstallPanelContent installation={installation} compact={compact} />;
}

export function InstallPanelContent({ installation, compact = false }: { installation: ReturnType<typeof usePwaInstall>; compact?: boolean }) {
  // A deliberate manual choice survives provider refreshes and native events.
  const [selected, setSelected] = useState<InstallGuideId | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const nativeRequested = useRef(false);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const correction = useRef<HTMLDetailsElement>(null);
  const correctionSummary = useRef<HTMLElement>(null);
  const id = useId();
  const guideId = selected ?? suggestedInstallGuide(installation.device);
  const guide = selected ? INSTALL_GUIDES[selected] : installGuideForDevice(installation.device);
  const nativeAvailable = selected === null && installation.canInstall || installation.busy;
  const completed = selected === null && (installation.outcome === "accepted" || installation.installedHere);
  const embedded = installation.device.embedded && selected === null && !nativeAvailable;
  const manualFolded = selected === null && (nativeAvailable || completed);
  const deviceLabel = selected && !installation.busy ? INSTALL_GUIDE_OPTIONS.find(option => option.id === selected)?.label : installDeviceLabel(installation.device);
  const mobileDevice = selected ? selected === "ios" || selected.startsWith("android-") : ["ios", "android"].includes(installation.device.platform);
  const DeviceIcon = mobileDevice ? Smartphone : Monitor;
  useEffect(() => {
    if (!nativeRequested.current || installation.busy || installation.outcome === "idle") return;
    nativeRequested.current = false;
    // The one-use native trigger disappears. Focus visible guidance, never a
    // selector inside a closed disclosure, without stealing another focus.
    if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
    const target = installation.outcome === "accepted" || manualFolded ? status.current : guideHeading.current;
    target?.focus({ preventScroll: true });
  }, [installation.busy, installation.outcome, manualFolded]);
  async function copyAddress() {
    // Never expose invitation tokens, callback state or notification links.
    const address = window.location.origin + "/";
    setCopyStatus(await copyText(address) ? "Адрес скопирован" : `Скопируйте адрес вручную: ${address}`);
  }
  const copyButton = <button type="button" className={embedded ? styles.primary : styles.copy} onClick={() => void copyAddress()}><Copy size={15} aria-hidden="true" />Скопировать адрес сайта</button>;
  const manualGuide = <div className={styles.guide} data-install-guide={guideId}>
    <h3 ref={guideHeading} tabIndex={-1}>{embedded ? "Сначала откройте внешний браузер" : guide.title}</h3>
    {embedded ? <>
      <p className={styles.embeddedText}>Этот сайт открыт внутри другого приложения. В его меню выберите «Открыть в браузере» — там появится подходящий способ установки.</p>
      <div className={styles.browserVisual} aria-hidden="true"><ExternalLink size={19} /><span>Открыть в браузере</span><ArrowRight size={16} /></div>
      <p className={styles.note}>Нет такого пункта? Скопируйте адрес и откройте его в Safari на iPhone или в Chrome на Android.</p>
    </> : <>
      <ol className={styles.steps}>{guide.steps.map((step, index) => <li key={step}>
        <span className={styles.stepNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div><p className={styles.stepAction}>{guide.actions[index]}</p><p className={styles.stepText}>{step}</p></div>
      </li>)}</ol>
      <details className={styles.help}><summary>Не нашли нужный пункт?</summary><p className={styles.note}>{guide.note}</p></details>
    </>}
  </div>;
  const correctionControl = <details ref={correction} className={styles.correction} data-install-correction>
    <summary ref={correctionSummary}>Другой браузер или устройство<ChevronDown size={15} aria-hidden="true" /></summary>
    <div className={styles.correctionBody}>
      <label htmlFor={`${id}-device`}>Способ установки</label>
      <select id={`${id}-device`} disabled={installation.busy} value={guideId} onChange={event => setSelected(event.target.value as InstallGuideId)}>
        {INSTALL_GUIDE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <p>Выберите здесь, если браузер определился неправильно или устанавливаете на другое устройство.</p>
      {selected !== null && <button type="button" className={styles.reset} onClick={() => {
        setSelected(null);
        if (correction.current) correction.current.open = false;
        correctionSummary.current?.focus({ preventScroll: true });
      }}>Вернуть автоопределение</button>}
    </div>
  </details>;
  const instructions = <>
    {manualFolded && !installation.standalone ? <details className={styles.manual}><summary>Установить через меню браузера<ChevronDown size={15} aria-hidden="true" /></summary>{manualGuide}</details> : manualGuide}
    {correctionControl}
    <p className={styles.accountNote}>Уже играли? Войдите через прежние ВК или почту — серверный прогресс останется с вами.</p>
    {copyButton}<span className={styles.copyStatus} role="status">{copyStatus}</span>
  </>;
  return <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-labelledby={`${id}-title`} data-install-panel>
    <div className={styles.panelHeading}><span className={styles.panelIcon}>{installation.standalone ? <Check size={22} aria-hidden="true" /> : <Smartphone size={22} aria-hidden="true" />}</span><div>
      <p className={styles.eyebrow}>Ваша полянка. Всегда рядом.</p>
      <h2 id={`${id}-title`}>{installation.standalone ? "Вы уже в приложении" : "Установить «Я живой»"}</h2>
    </div></div>
    <p className={styles.description}>{installation.standalone ? "Возвращайтесь в свой лес прямо со значка. Это отдельное окно приложения." : "Один значок. Свой маленький мир. Установите прямо отсюда, без магазина приложений."}</p>
    {!installation.ready ? <div className={styles.pending} role="status" data-install-pending><span aria-hidden="true" /><p>Подбираем способ установки…</p></div> : installation.standalone ? <>
      <Link href="/" prefetch={false} className={styles.primary}>Вернуться на полянку<ArrowRight size={18} aria-hidden="true" /></Link>
      <details className={styles.otherDevice}><summary>Установить на другом устройстве</summary>{instructions}</details>
    </> : <>
      <div className={styles.device} data-install-device><DeviceIcon size={15} aria-hidden="true" /><span>{deviceLabel}</span><span className={styles.deviceHint}>{selected ? "Выбрано вами" : guideId === "other" && !nativeAvailable ? "Поможем установить" : "Подобрали для вас"}</span></div>
      {!installation.secure && <p className={styles.notice}>Установка доступна с защищённого адреса HTTPS или localhost.</p>}
      {nativeAvailable && <>
        <button className={styles.primary} type="button" disabled={installation.busy} onClick={() => { nativeRequested.current = true; void installation.install(); }}><Download size={18} aria-hidden="true" />{installation.busy ? "Ожидаем ответ браузера…" : "Установить приложение"}<ArrowRight size={17} aria-hidden="true" /></button>
        <p className={styles.nativeNote}>Браузер сам откроет окно установки. Останется подтвердить.</p>
      </>}
      <div ref={status} className={styles.status} role="status" aria-live="polite" tabIndex={-1}>
        {completed && <p><Check size={18} aria-hidden="true" />{installation.installedHere ? "Приложение добавлено. Закройте вкладку и запустите «Я живой» со значка." : "Запрос принят. Завершите установку в браузере и запустите «Я живой» со значка."}</p>}
        {installation.outcome === "dismissed" && <p>Можно установить позже. Вот способ через меню браузера.</p>}
        {installation.outcome === "error" && <p>Браузер не завершил установку. Попробуйте способ через его меню.</p>}
      </div>
      {instructions}
    </>}
    {!installation.ready && <>{correctionControl}<noscript><p className={styles.note}>Для автоматического подбора включите JavaScript. Можно установить вручную: на iPhone — Safari → «Поделиться» → «На экран „Домой“»; на Android — Chrome → меню ⋮ → «Установить приложение».</p></noscript></>}
    <span className={styles.shareMark} aria-hidden="true"><Share2 size={62} /></span>
  </section>;
}
