"use client";
import { useEffect, useRef } from "react";
import { ArrowLeft, Check, Gift, Mail, MailOpen, RefreshCw, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import type { MailMessage } from "./model";
import type { MailboxController } from "./use-mailbox";
import styles from "./mailbox.module.css";

const dateLabel = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const typeLabel = (message: MailMessage) => message.type === "admin_grant" ? "Подарок от команды" : message.type === "balance_correction" ? "Изменение хозяйства" : message.type === "event" ? "Событие" : "От команды игры";
export function MailLetter({ message, reading, readError, available, onRetry }: {
  message: MailMessage; reading: boolean; readError: string | null; available: boolean; onRetry: () => void;
}) {
  const attachments = message.attachments;
  const contents = attachments ? [attachments.coins ? `${attachments.coins > 0 ? "+" : ""}${attachments.coins.toLocaleString("ru-RU")} монет` : null,
    attachments.pearls ? `${attachments.pearls > 0 ? "+" : ""}${attachments.pearls.toLocaleString("ru-RU")} жемчуга` : null,
    Object.keys(attachments.items).length ? `Припасы: ${Object.values(attachments.items).reduce((sum, count) => sum + count, 0).toLocaleString("ru-RU")}` : null,
    Object.keys(attachments.buildings).length ? "Обновлены постройки" : null,
    Object.keys(attachments.productionSlots).length ? "Обновлены места производства" : null,
    attachments.worldItems.length || attachments.finds.length ? "Добавлены находки" : null,
    attachments.gameItems.length ? "Добавлены игровые предметы" : null,
    attachments.achievements.length ? "Открыты достижения" : null,
    attachments.rods.length || attachments.hooks.length ? "Добавлены снасти" : null].filter(Boolean) : [];
  return <article className={styles.letter} aria-labelledby="mail-letter-title" data-mail-letter={message.id}>
    <span className={styles.eyebrow}>{typeLabel(message)}</span>
    <h2 id="mail-letter-title" tabIndex={-1}>{message.title}</h2><time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time>
    <div className={styles.letterBody}>{message.body}</div>
    {contents.length > 0 && <aside className={styles.attachments}><strong><Gift size={17} aria-hidden="true" />Изменения уже применены</strong>
      <ul>{contents.map((text, index) => <li key={index}>{text}</li>)}</ul></aside>}
    <footer className={styles.readStatus} aria-live="polite">{message.readAt ? <><Check size={14} aria-hidden="true" />Прочитано</> : reading ? "Сохраняем отметку прочтения…" : !available ? "Подключитесь, чтобы сохранить прочтение." : "Письмо открыто"}</footer>
    {readError && <div className={styles.error} role="status"><p>{readError}</p><button type="button" disabled={!available || reading} onClick={onRetry}>Повторить отметку</button></div>}
  </article>;
}
export function MailboxPanel({ mailbox }: { mailbox: MailboxController }) {
  const selected = mailbox.selected;
  const { opened, available, messageVisible } = mailbox, selectedId = selected?.id, readAt = selected?.readAt;
  useEffect(() => {
    if (opened && available && selectedId && !readAt) void messageVisible(selectedId);
  }, [opened, available, selectedId, readAt, messageVisible]);
  if (selected) return <MailLetter message={selected} reading={mailbox.readingIds.includes(selected.id)} readError={mailbox.readError}
    available={mailbox.available} onRetry={() => void mailbox.messageVisible(selected.id)} />;
  return <div className={styles.inbox} aria-busy={mailbox.loading || mailbox.loadingMore}>
    {!mailbox.available && <p className={styles.offline} role="status">Для обновления почты нужен интернет и открытая вкладка.</p>}
    {mailbox.error && <p className={styles.error} role="status">{mailbox.error}</p>}
    {mailbox.messages.length === 0 ? <div className={styles.empty}><MailOpen size={40} aria-hidden="true" />
      <strong>{mailbox.loading ? "Проверяем почтовый ящик…" : mailbox.loaded ? "Пока тихо" : "Заглянем в почтовый ящик"}</strong>
      <p>{mailbox.loaded ? "Здесь сохраняются письма команды и новости о событиях." : "Письма появятся после подключения к серверу."}</p></div>
      : <ul className={styles.letters} aria-label="Письма">{mailbox.messages.map(message => <li key={message.id}>
        <button type="button" data-mail-id={message.id} data-unread={!message.readAt || undefined} onClick={() => mailbox.select(message.id)}>
          <span className={styles.letterIcon}>{message.readAt ? <MailOpen size={20} aria-hidden="true" /> : <Mail size={20} aria-hidden="true" />}</span>
          <span className={styles.letterSummary}><span>{message.title}</span><small>{typeLabel(message)} · {dateLabel(message.createdAt)}</small></span>
          {!message.readAt && <span className={styles.unreadDot} aria-label="Не прочитано" />}
        </button></li>)}</ul>}
    <div className={styles.inboxActions}><button type="button" disabled={!mailbox.available || mailbox.loading || mailbox.loadingMore} onClick={() => void mailbox.refresh()}><RefreshCw size={15} aria-hidden="true" />Обновить</button>
      {mailbox.nextCursor && <button type="button" disabled={!mailbox.available || mailbox.loading || mailbox.loadingMore} onClick={() => void mailbox.loadMore()}>{mailbox.loadingMore ? "Загружаем…" : "Более ранние письма"}</button>}</div>
  </div>;
}
export function MailboxDialog({ mailbox }: { mailbox: MailboxController }) {
  const trigger = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const selectedId = mailbox.selected?.id;
  useEffect(() => { if (selectedId) document.getElementById("mail-letter-title")?.focus({ preventScroll: true }); }, [selectedId]);
  const back = () => { mailbox.back(); requestAnimationFrame(() => {
    if (!mailbox.isAvailable()) return;
    const target = document.querySelector<HTMLElement>(`[data-mail-id="${selectedId}"]`) ?? heading.current;
    target?.focus({ preventScroll: true });
  }); };
  return <Dialog open={mailbox.opened} onOpenChange={open => { if (!open) mailbox.close(); }}><DialogPortal><DialogOverlay className={styles.scrim} />
    <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog} aria-describedby="mailbox-description"
      onOpenAutoFocus={event => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; event.preventDefault(); heading.current?.focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); if (!mailbox.isAvailable()) return;
        const target = trigger.current?.isConnected ? trigger.current : document.querySelector<HTMLElement>('[data-world-quick="more"]'); target?.focus({ preventScroll: true }); }}
      onEscapeKeyDown={event => { if (mailbox.selected) { event.preventDefault(); event.stopPropagation(); back(); } }}>
      <header className={styles.header}>{mailbox.selected && <button type="button" aria-label="К списку писем" onClick={back}><ArrowLeft size={19} aria-hidden="true" /></button>}
        <DialogTitle ref={heading} tabIndex={-1}><Mail size={22} aria-hidden="true" />Почта{mailbox.unreadCount > 0 && <span className={styles.count}>{mailbox.unreadCount}</span>}</DialogTitle>
        <DialogPrimitive.Close aria-label="Закрыть почту"><X size={20} aria-hidden="true" /></DialogPrimitive.Close></header>
      <DialogDescription id="mailbox-description" className={styles.description}>Письма остаются здесь. Отметка прочтения сохраняется при открытии письма.</DialogDescription>
      <MailboxPanel mailbox={mailbox} />
    </DialogPrimitive.Content></DialogPortal></Dialog>;
}
