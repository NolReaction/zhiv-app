"use client";
import { useEffect } from "react";
import { Mail, X } from "lucide-react";
import { toast } from "sonner";
import type { MailboxController } from "./use-mailbox";
import styles from "./mailbox.module.css";

export function MailboxNotifications({ mailbox }: { mailbox: MailboxController }) {
  const candidate = mailbox.notification, id = candidate?.id, owner = mailbox.ownerPublicId;
  const { claimNotification, isAvailable, open } = mailbox;
  useEffect(() => {
    if (!id || !owner || !mailbox.available || !isAvailable()) return;
    const toastId = `mail:${owner}:${id}`;
    let disposed = false, shown = false;
    // Strict Mode's provisional setup is cleaned up before this microtask: it
    // must not consume a durable notification that has never reached the UI.
    queueMicrotask(() => {
      if (disposed || !isAvailable() || !claimNotification(id)) return;
      shown = true;
      toast.custom(() => <div className={styles.notification} role="status"><Mail size={22} aria-hidden="true" />
      <div><strong>Вам пришло письмо</strong><p>Новое сообщение автора игры в вашей почте.</p>
        <button type="button" onClick={() => { if (isAvailable()) open(); toast.dismiss(toastId); }}>Открыть почту</button></div>
      <button type="button" aria-label="Закрыть уведомление о письме" onClick={() => toast.dismiss(toastId)}><X size={17} aria-hidden="true" /></button></div>,
      { id: toastId, duration: 12_000 });
    });
    return () => { disposed = true; if (shown) toast.dismiss(toastId); };
  }, [id, owner, mailbox.available, claimNotification, isAvailable, open]);
  return null;
}
