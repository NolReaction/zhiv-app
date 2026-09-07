"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import styles from "./app-notifications.module.css";

type NoticeKind = "info" | "success" | "error";
const NOTICE_DURATION_MS = 10_000;

function ToastMessage({ id, message, kind }: { id: string | number; message: string; kind: NoticeKind }) {
  const [remaining, setRemaining] = useState(NOTICE_DURATION_MS);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const elapsed = useRef(0);

  useEffect(() => {
    let lastTick = performance.now();
    // Mobile browsers may suspend interval ticks while the page is hidden.
    const resetTick = () => { lastTick = performance.now(); };
    document.addEventListener("visibilitychange", resetTick);
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!hovered && !focused && !document.hidden) elapsed.current += now - lastTick;
      lastTick = now;
      const left = Math.max(0, NOTICE_DURATION_MS - elapsed.current);
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        toast.dismiss(id);
      }
    }, 100);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resetTick);
    };
  }, [id, hovered, focused]);

  const Icon = kind === "error" ? TriangleAlert : kind === "success" ? CircleCheck : Info;
  return <div className={styles.notice} data-kind={kind}
    style={{ "--notice-progress": 1 - remaining / NOTICE_DURATION_MS } as CSSProperties}
    onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className={styles.countdown} aria-hidden="true" />
    <Icon className={styles.icon} size={20} aria-hidden="true" />
    <p role={kind === "error" ? "alert" : "status"}>{message}</p>
    <div className={styles.controls}>
      <button type="button" aria-label="Закрыть уведомление" onClick={() => toast.dismiss(id)}><X size={18} aria-hidden="true" /></button>
      <span aria-hidden="true">{Math.ceil(remaining / 1000)} с</span>
    </div>
  </div>;
}

// Keeps transient feedback outside page grids and form layouts. Sonner owns the
// portal/stack; this timer also pauses its visible progress during reading.
export function notify(message: string, kind: NoticeKind = "info") {
  return toast.custom(id => <ToastMessage id={id} message={message} kind={kind} />, {
    duration: Infinity,
    style: { width: "var(--width)" },
  });
}

export function TransientNotice({ message, kind = "info" }: { message: string | null | undefined; kind?: NoticeKind }) {
  useEffect(() => {
    if (!message) return;
    const id = notify(message, kind);
    return () => { toast.dismiss(id); };
  }, [message, kind]);
  return null;
}

export function AppNotifications() {
  return <Toaster position="top-center" theme="dark" expand visibleToasts={3}
    offset="calc(env(safe-area-inset-top, 0px) + 16px)"
    mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)", left: "16px", right: "16px" }}
    style={{ "--width": "min(440px, calc(100vw - 32px))", zIndex: 100 } as CSSProperties}
    containerAriaLabel="Уведомления" />;
}
