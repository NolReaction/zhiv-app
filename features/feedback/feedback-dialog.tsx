"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, MessageSquarePlus, Send } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createUuidV4 } from "@/lib/browser-uuid";
import { emptyFeedbackDraft, readFeedbackDraft, writeFeedbackDraft, type FeedbackDraft } from "./feedback-draft";
import { FEEDBACK_MAX_LENGTH, FEEDBACK_MIN_LENGTH, FeedbackError, feedbackCategories, feedbackMessageLength, feedbackRequestSchema, getFeedbackAvailability, submitFeedback,
  type FeedbackAvailability, type FeedbackCategory } from "./feedback-api";
import styles from "./feedback-dialog.module.css";

export function FeedbackDialog({ ownerPublicId }: { ownerPublicId: string }) {
  return <FeedbackDialogContent key={ownerPublicId} ownerPublicId={ownerPublicId} />;
}

function FeedbackDialogContent({ ownerPublicId }: { ownerPublicId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FeedbackDraft>(emptyFeedbackDraft);
  const [availability, setAvailability] = useState<FeedbackAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [draftSaved, setDraftSaved] = useState(true);
  const sendingRef = useRef(false);
  const unsafeDraftRef = useRef(false);
  const draftRef = useRef<FeedbackDraft>(emptyFeedbackDraft());
  const requestRef = useRef<AbortController | null>(null);
  const formId = useId();

  useEffect(() => {
    let active = true;
    const preserveDraft = (event: Event) => {
      if (!unsafeDraftRef.current) return;
      try {
        if (writeFeedbackDraft(ownerPublicId, draftRef.current, window.sessionStorage)) {
          unsafeDraftRef.current = false;
          setDraftSaved(true);
        }
      } catch { /* Keep the current draft until storage becomes available. */ }
      if (unsafeDraftRef.current) event.preventDefault();
    };
    window.addEventListener("zhiv:before-app-reload", preserveDraft);
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const restored = readFeedbackDraft(ownerPublicId, window.sessionStorage);
        draftRef.current = restored;
        setDraft(restored);
      }
      catch { setDraftSaved(false); }
    });
    return () => { active = false; requestRef.current?.abort(); window.removeEventListener("zhiv:before-app-reload", preserveDraft); };
  }, [ownerPublicId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setChecking(true);
      try {
        const result = await getFeedbackAvailability(ownerPublicId, controller.signal);
        if (controller.signal.aborted) return;
        setAvailability(result);
        if (!result.canSubmit && result.nextAllowedAt) {
          const remaining = Date.parse(result.nextAllowedAt) - Date.parse(result.serverTime);
          timer = globalThis.setTimeout(() => setRefreshVersion(value => value + 1), Math.max(1000, remaining + 500));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof FeedbackError && [401, 403, 409].includes(cause.status)) setAvailability(null);
          setError(cause instanceof FeedbackError ? cause.message : "Не удалось проверить доступность. Проверьте соединение и повторите.");
        }
      } finally { if (!controller.signal.aborted) setChecking(false); }
    });
    return () => { controller.abort(); if (timer) globalThis.clearTimeout(timer); };
  }, [open, refreshVersion, ownerPublicId]);

  function save(next: FeedbackDraft) {
    draftRef.current = next;
    setDraft(next);
    let saved = false;
    try { saved = writeFeedbackDraft(ownerPublicId, next, window.sessionStorage); }
    catch { /* Some browsers refuse even accessing sessionStorage. */ }
    setDraftSaved(saved);
    unsafeDraftRef.current = !saved && (!!next.message || !!next.pending);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current) return;
    const parsed = feedbackRequestSchema.safeParse(draft.pending ?? { clientRequestId: createUuidV4(), expectedOwnerPublicId: ownerPublicId, category: draft.category, message: draft.message });
    if (!parsed.success) { setError(`Опишите ситуацию: от ${FEEDBACK_MIN_LENGTH} до ${FEEDBACK_MAX_LENGTH} символов.`); return; }
    if (!draft.pending && !availability?.canSubmit) return;
    sendingRef.current = true;
    setSending(true); setError(null);
    const pending = parsed.data;
    save({ ...draft, message: pending.message, pending });
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const receipt = await submitFeedback(pending, controller.signal);
      if (controller.signal.aborted) return;
      save(emptyFeedbackDraft());
      setSent(true);
      setAvailability({ serverTime: receipt.createdAt, canSubmit: false, nextAllowedAt: receipt.nextAllowedAt });
      setRefreshVersion(value => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof FeedbackError && ([400, 409, 413, 415].includes(cause.status) || (cause.status === 429 && cause.nextAllowedAt))) {
        save({ ...draft, pending: null });
        if (cause.nextAllowedAt) setAvailability({ serverTime: cause.serverTime ?? new Date().toISOString(), canSubmit: false, nextAllowedAt: cause.nextAllowedAt });
        setRefreshVersion(value => value + 1);
      }
      setError(cause instanceof FeedbackError ? cause.message : "Связь прервалась. Повторите отправку: то же сообщение не создаст дубль.");
    } finally {
      sendingRef.current = false;
      if (!controller.signal.aborted) setSending(false);
    }
  }

  const locked = sending || draft.pending !== null;
  const nextDate = availability?.nextAllowedAt ? new Date(availability.nextAllowedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : null;
  const messageLength = feedbackMessageLength(draft.message);
  const valid = messageLength >= FEEDBACK_MIN_LENGTH && messageLength <= FEEDBACK_MAX_LENGTH;
  return <Dialog open={open} onOpenChange={value => { if (!sendingRef.current) { setOpen(value); if (value) setError(null); } }}>
    <DialogTrigger asChild><button type="button" className={styles.trigger}><MessageSquarePlus size={16} aria-hidden="true" />Написать разработчику</button></DialogTrigger>
    <DialogContent className={styles.dialog} onEscapeKeyDown={event => { if (sending) event.preventDefault(); }} onInteractOutside={event => { if (sending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Обратная связь</DialogTitle><DialogDescription>Нашли ошибку или придумали улучшение? Сообщение увидит разработчик. Можно отправить одно обращение за 24 часа.</DialogDescription></DialogHeader>
      {sent && <p className={styles.success} role="status"><Check size={18} aria-hidden="true" />Спасибо! Сообщение отправлено разработчику.</p>}
      {!availability?.canSubmit && nextDate && <p className={styles.notice} role="status">Следующее сообщение можно отправить {nextDate}.</p>}
      <form className={styles.form} onSubmit={event => { void submit(event); }}>
        <label htmlFor={`${formId}-category`}>Тема</label>
        <select id={`${formId}-category`} value={draft.category} disabled={locked} onChange={event => { save({ ...draft, category: event.target.value as FeedbackCategory }); setSent(false); }}>
          {Object.entries(feedbackCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label htmlFor={`${formId}-message`}>Сообщение</label>
        <textarea id={`${formId}-message`} value={draft.message} disabled={locked} maxLength={FEEDBACK_MAX_LENGTH * 2} rows={7} required
          aria-describedby={`${formId}-hint ${formId}-count`} placeholder="Что произошло? Какие действия помогут повторить ошибку? Или опишите свою идею."
          onChange={event => { save({ ...draft, message: event.target.value }); setError(null); setSent(false); }} />
        <div className={styles.hints}><span id={`${formId}-hint`}>От 10 символов. Не отправляйте пароли и коды входа.</span><span id={`${formId}-count`}>{messageLength}/{FEEDBACK_MAX_LENGTH}</span></div>
        {!draftSaved && draft.message && <p className={styles.notice}>Браузер запретил сохранение черновика. Скопируйте текст перед перезагрузкой.</p>}
        {draft.pending && !sending && <p className={styles.notice}>Подтверждение ещё не получено. Повторим это же обращение без дублей.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          {!availability && <button type="button" className={styles.secondary} disabled={checking} onClick={() => { setError(null); setRefreshVersion(value => value + 1); }}>{checking ? "Проверяем…" : "Повторить проверку"}</button>}
          <button type="submit" className={styles.submit} disabled={sending || !valid || (!draft.pending && (!availability?.canSubmit || checking))}><Send size={16} aria-hidden="true" />{sending ? "Отправляем…" : draft.pending ? "Повторить отправку" : "Отправить"}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
