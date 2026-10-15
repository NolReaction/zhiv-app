"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Popover } from "radix-ui";
import { RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import styles from "./connection-status.module.css";

export type ConnectionStatusProps = {
  online: boolean;
  reconnecting?: boolean;
  queuedCount?: number;
  pending?: boolean;
  error?: string | null;
  retrySeconds?: number;
  busy?: boolean;
  onRetry?: () => unknown;
  className?: string;
};

export const CONNECTION_PENDING_DELAY_MS = 900;

const subscribeToBrowser = () => () => {};
const browserAvailable = () => typeof document !== "undefined";
const serverBrowserAvailable = () => false;

/** A single movable host keeps both the indicator and its details inside the active focus scope. */
export function connectConnectionStatusHost(host: HTMLElement, fallback: HTMLElement, onMove: () => void) {
  const document = host.ownerDocument;
  let disposed = false, blocked = false;
  const place = () => {
    if (disposed) return;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"], [role="dialog"][aria-modal="true"]'))
      .filter(dialog => !host.contains(dialog) && !dialog.closest('[data-connection-details], [inert], [hidden], [aria-hidden="true"], [data-state="closed"]')
        && dialog.getClientRects().length > 0 && document.defaultView?.getComputedStyle(dialog).visibility !== "hidden");
    const top = dialogs.at(-1);
    blocked = Boolean(top?.matches("[data-activity-gate], [data-forest-session-notice]"));
    const target = top && !blocked ? top : fallback;
    if (host.parentElement !== target) {
      const moving = host.parentElement !== null;
      target.appendChild(host);
      if (moving) onMove();
    }
  };
  place();
  // The host moves in the DOM, not the React tree. Radix's non-bubbling outside
  // events otherwise mistake its controls for a click/focus outside a new dialog.
  const keepInside = (event: Event) => {
    if (!disposed && !blocked && host.isConnected && !host.closest('[inert], [hidden], [aria-hidden="true"]')
      && event.target && host.contains(event.target as Node)) event.preventDefault();
  };
  host.addEventListener("dismissableLayer.pointerDownOutside", keepInside, true);
  host.addEventListener("dismissableLayer.focusOutside", keepInside, true);
  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(place) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["aria-hidden", "aria-modal", "data-state", "hidden", "inert", "style", "class"] });
  return () => {
    disposed = true; observer?.disconnect();
    host.removeEventListener("dismissableLayer.pointerDownOutside", keepInside, true);
    host.removeEventListener("dismissableLayer.focusOutside", keepInside, true);
    host.remove();
  };
}

/** This reports transport and real unacknowledged work, never optimistic balances. */
export function ConnectionStatus(props: ConnectionStatusProps) {
  const { online, reconnecting = false, pending = false, error, busy = false, onRetry, className } = props;
  const count = Number.isSafeInteger(props.queuedCount) ? Math.max(0, props.queuedCount!) : 0;
  const retrySeconds = Math.max(0, Math.ceil(props.retrySeconds ?? 0));
  const [open, setOpen] = useState(false), [retrying, setRetrying] = useState(false);
  const latest = useRef(props), requested = useRef(false), mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null), fallback = useRef<HTMLSpanElement>(null), restoreFocus = useRef(true), titleId = useId();
  const browser = useSyncExternalStore(subscribeToBrowser, browserAvailable, serverBrowserAvailable);
  const portalHost = useMemo(() => {
    if (!browser) return null;
    const host = document.createElement("span");
    host.className = styles.host;
    host.setAttribute("data-connection-status-host", "");
    return host;
  }, [browser]);
  useLayoutEffect(() => { latest.current = props; }, [props]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const hasPending = pending || count > 0, transportIssue = !online || reconnecting || Boolean(error);
  const [pendingDisplay, setPendingDisplay] = useState({ pending: hasPending, visible: hasPending && transportIssue });
  let display = pendingDisplay;
  if (display.pending !== hasPending || hasPending && transportIssue && !display.visible) {
    display = { pending: hasPending, visible: hasPending && transportIssue };
    setPendingDisplay(display);
  }
  useEffect(() => {
    if (!display.pending || display.visible) return;
    const cycle = display;
    const timeout = setTimeout(() => {
      setPendingDisplay(current => current === cycle ? { ...current, visible: true } : current);
    }, CONNECTION_PENDING_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [display]);
  const visible = transportIssue || hasPending && display.visible;
  useEffect(() => {
    if (!visible || !portalHost || !fallback.current) return;
    return connectConnectionStatusHost(portalHost, fallback.current, () => { restoreFocus.current = false; setOpen(false); });
  }, [portalHost, visible]);
  if (!visible) { if (open) setOpen(false); return null; }
  const label = !online ? "Нет связи" : reconnecting ? "Восстанавливаем связь" : count > 0 ? `Ожидают подтверждения: ${count}` : pending ? "Действие ждёт подтверждения" : "Нужно проверить соединение";
  const disabled = !online || reconnecting || busy || retrying || retrySeconds > 0;
  const Icon = online ? Wifi : WifiOff;
  async function retry() {
    const current = latest.current;
    if (current.online && !current.reconnecting && !current.pending && !current.error && !(current.queuedCount && current.queuedCount > 0)) return;
    if (requested.current || !current.onRetry || !current.online || current.reconnecting || current.busy || (current.retrySeconds ?? 0) > 0) return;
    requested.current = true; setRetrying(true);
    try { await current.onRetry(); }
    catch { /* The owning controller keeps its actionable error and receipt. */ }
    finally { requested.current = false; if (mounted.current) setRetrying(false); }
  }
  const content = <>
    <span className={`${styles.anchor} ${className ?? ""}`} data-connection-status data-online={online} data-connection-pending={pending || count > 0 || undefined}>
      <Popover.Trigger asChild><button ref={trigger} type="button" className={styles.indicator} aria-label={label} title={label}
        data-connection-toggle data-unstable={!online || reconnecting || Boolean(error) || undefined}>
        <Icon size={19} aria-hidden="true" />{count > 0 && <span className={styles.count} aria-hidden="true">{count > 9 ? "9+" : count}</span>}
      </button></Popover.Trigger>
      <span className={styles.srOnly} role="status" aria-live="polite">{label}</span>
    </span>
    {open && <Popover.Portal container={portalHost ?? undefined}><Popover.Content className={styles.details} side="bottom" align="end" sideOffset={7} collisionPadding={12}
      aria-labelledby={titleId} data-connection-details onEscapeKeyDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onCloseAutoFocus={event => { event.preventDefault(); if (restoreFocus.current && trigger.current?.isConnected && !trigger.current.closest("[inert], [aria-hidden=\"true\"]")) trigger.current.focus({ preventScroll: true }); }}>
      <header><h2 id={titleId}>{label}</h2><Popover.Close asChild><button type="button" className={styles.close} aria-label="Закрыть состояние связи"><X size={16} aria-hidden="true" /></button></Popover.Close></header>
      {count > 0 ? <p data-connection-queue>В очереди: <strong>{count}</strong>. Эти действия ещё не подтверждены сервером.</p>
        : pending ? <p>Проверяем результат последнего действия. Подтверждение ещё не получено.</p>
          : <p>{online ? "Проверяем соединение с сервером." : "Игра сохраняет последний полученный прогресс. Ждём восстановления связи."}</p>}
      {error && <p className={styles.error}>{error}</p>}
      {onRetry && <button type="button" className={styles.retry} disabled={disabled} onClick={() => void retry()}><RefreshCw size={14} aria-hidden="true" />{retrying || reconnecting ? "Проверяем…" : retrySeconds > 0 ? `Повторить через ${retrySeconds} с` : "Проверить связь"}</button>}
    </Popover.Content></Popover.Portal>}
  </>;
  return <Popover.Root open={open} onOpenChange={next => { if (next) restoreFocus.current = true; setOpen(next); }} modal={false}>
    <span ref={fallback} className={styles.host} data-connection-placement />
    {portalHost ? createPortal(content, portalHost) : content}
  </Popover.Root>;
}
