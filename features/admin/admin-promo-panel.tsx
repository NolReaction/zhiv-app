"use client";

import { useEffect, useRef, useState } from "react";
import { Coins, Copy, Gift, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { economyCatalog } from "@/features/economy/domain/model";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { validAdminReason } from "./admin-input";
import { loadAdminPromos, manageAdminPromo, readPendingAdminPromo, writePendingAdminPromo,
  type AdminPromoCommand, type AdminPromoDefinition, type AdminPromoEntry, type AdminPromos } from "./admin-promo-api";
import { definitionFromPromoDraft, promoDraft, promoItemName, promoPresetEnd, promoStatus, promoStatusLabels,
  promoTime, type PromoDraft, type PromoStatus } from "./admin-promo-model";
import styles from "./admin-promo.module.css";

const number = (value: number) => value.toLocaleString("ru-RU");
type Editor = { entry: AdminPromoEntry | null; mode: "edit" | "toggle" | "delete"; pending?: AdminPromoCommand };
type AccessLost = (error: ApiError) => void;

export function AdminPromoReward({ definition }: { definition: AdminPromoDefinition }) {
  return <ul className={styles.rewards} aria-label="Награда за промокод">
    {definition.reward.coins > 0 && <li><Coins size={16} aria-hidden="true" />{number(definition.reward.coins)} монет</li>}
    {definition.reward.pearls > 0 && <li><span aria-hidden="true">◈</span>{number(definition.reward.pearls)} жемчуга</li>}
    {Object.entries(definition.reward.items).map(([itemId, amount]) => <li key={itemId}>{promoItemName(itemId)} × {number(amount)}</li>)}
  </ul>;
}

export function AdminPromoList({ data, query, status, disabled = false, onEdit, onToggle, onDelete, onCopy }: {
  data: AdminPromos; query: string; status: "all" | PromoStatus;
  disabled?: boolean;
  onEdit: (entry: AdminPromoEntry) => void; onToggle: (entry: AdminPromoEntry) => void;
  onDelete: (entry: AdminPromoEntry) => void; onCopy: (code: string) => void;
}) {
  const codes = data.codes.filter(entry => (!query.trim() || `${entry.definition.code} ${entry.definition.title}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")))
    && (status === "all" || promoStatus(entry.definition, data.serverTime) === status));
  return <div className={styles.cards}>
    {codes.length === 0 && <p className={styles.empty}>{data.codes.length ? "По этому запросу промокодов нет." : "Промокодов пока нет. Создайте первый подарок для игроков."}</p>}
    {codes.map(entry => {
      const value = entry.definition, state = promoStatus(value, data.serverTime);
      return <article className={styles.card} key={value.id} aria-label={`Промокод ${value.code}`}>
        <div className={styles.cardHeader}><div><code className={styles.code}>{value.code}</code><h3>{value.title}</h3></div>
          <span className={styles.status} data-status={state}>{promoStatusLabels[state]}</span></div>
        <AdminPromoReward definition={value} />
        <dl className={styles.dates}><div><dt>Начало</dt><dd>{promoTime(value.startsAt, "Сразу после включения")}</dd></div>
          <div><dt>Окончание</dt><dd>{promoTime(value.endsAt, "Без срока")}</dd></div>
          <div><dt>Активаций</dt><dd>{number(entry.redemptions)} <span>· один раз на игрока</span></dd></div></dl>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={disabled} onClick={() => { if (!disabled) onEdit(entry); }} aria-label={`Изменить ${value.code}`}><Pencil size={15} aria-hidden="true" />Изменить</button>
          <button type="button" className={styles.button} disabled={disabled} onClick={() => { if (!disabled) onToggle(entry); }} aria-label={`${value.enabled ? "Выключить" : "Включить"} ${value.code}`}>{value.enabled ? "Выключить" : "Включить"}</button>
          <button type="button" className={styles.iconButton} onClick={() => onCopy(value.code)} aria-label={`Скопировать ${value.code}`}><Copy size={16} aria-hidden="true" /></button>
          <button type="button" className={styles.deleteButton} disabled={disabled} onClick={() => { if (!disabled) onDelete(entry); }} aria-label={`Удалить ${value.code}`}><Trash2 size={16} aria-hidden="true" /></button>
        </div>
      </article>;
    })}
  </div>;
}

export function AdminPromoReview({ command, entry }: { command: AdminPromoCommand; entry: AdminPromoEntry | null }) {
  const definition = command.definition ?? entry?.definition;
  return <section className={styles.review} aria-label="Проверка изменений промокода">
    <h3>{command.action === "delete" ? "Удаление промокода" : command.action === "create" ? "Новый промокод" : "Изменение промокода"}</h3>
    <strong className={styles.code}>{definition?.code ?? command.promoId}</strong>
    {command.action === "delete" ? <p>Промокод перестанет работать и исчезнет из списка. Уже выданные подарки останутся у игроков. История активаций сохранится; этот код нельзя будет создать повторно.</p> : definition && <>
      <p>{definition.title} · {definition.enabled ? "Включён" : "Выключен"}</p><AdminPromoReward definition={definition} />
      <p>Начало: {promoTime(definition.startsAt, "Сразу после включения")}<br />Окончание: {promoTime(definition.endsAt, "Без срока")}</p>
      {entry && <p>Изменения касаются следующих активаций. Уже получившие подарок игроки не получат его повторно, даже если изменить код или награду.</p>}
    </>}
    <p><strong>Причина:</strong> {command.reason}</p>
  </section>;
}

function PromoEditor({ editor, actorPublicId, serverTime, onClose, onSaved, onAttempt, onAccessLost, returnFocus }: {
  editor: Editor; actorPublicId: string; serverTime: string; onClose: () => void;
  onSaved: (message: string) => void; onAttempt: (command: AdminPromoCommand | null) => void; onAccessLost: AccessLost; returnFocus: () => void;
}) {
  const [draft, setDraft] = useState<PromoDraft>(() => promoDraft(editor.entry,
    editor.pending?.promoId ?? `promo-${createUuidV4()}`, serverTime));
  const [reason, setReason] = useState(editor.pending?.reason ?? (editor.mode === "delete" ? "Завершение акции" : editor.mode === "toggle" ? "Изменение доступности акции" : "Подарок игрокам"));
  const [review, setReview] = useState<AdminPromoCommand | null>(editor.pending ?? null);
  const [attempt, setAttempt] = useState<AdminPromoCommand | null>(editor.pending ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [itemQuery, setItemQuery] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const pending = useRef(false);
  const write = useRef<AbortController | null>(null);
  useEffect(() => () => write.current?.abort(), []);
  const update = <K extends keyof PromoDraft>(key: K, value: PromoDraft[K]) => { setDraft(current => ({ ...current, [key]: value })); setError(""); };
  const deletionCode = editor.entry?.definition.code ?? editor.pending?.promoId ?? "";
  const canDelete = editor.mode !== "delete" || confirmation.trim() === deletionCode || !!attempt;
  const items = economyCatalog.items.filter(item => item.name.toLocaleLowerCase("ru").includes(itemQuery.toLocaleLowerCase("ru"))
    && !draft.items.some(selected => selected.itemId === item.id));

  function prepare() {
    if (pending.current || conflict || !validAdminReason(reason) || !canDelete) return;
    try {
      const definition = editor.mode === "delete" ? undefined : editor.mode === "toggle" && editor.entry
        ? { ...editor.entry.definition, enabled: !editor.entry.definition.enabled } : definitionFromPromoDraft(draft);
      setReview({ requestId: createUuidV4(), action: editor.mode === "delete" ? "delete" : editor.entry ? "update" : "create",
        promoId: draft.id, expectedVersion: editor.entry?.version ?? 0, reason: reason.trim(), ...(definition ? { definition } : {}) });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Проверьте поля промокода"); }
  }
  async function submit() {
    if (pending.current || !review) return;
    const command = attempt ?? review;
    pending.current = true; setBusy(true); setAttempt(command); onAttempt(command); setError("");
    const controller = new AbortController(); write.current = controller;
    try { writePendingAdminPromo(window.sessionStorage, actorPublicId, command); } catch { /* In-memory retry still preserves the exact request. */ }
    try {
      await manageAdminPromo(actorPublicId, command, controller.signal);
      if (controller.signal.aborted) return;
      try { writePendingAdminPromo(window.sessionStorage, actorPublicId, null); } catch { /* A retained receipt remains safe to replay. */ }
      onSaved(command.action === "delete" ? "Промокод удалён. История активаций сохранена." : "Промокод сохранён. Изменения уже действуют.");
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) { onAccessLost(cause); return; }
      if (cause instanceof ApiError && [400, 404, 409, 422].includes(cause.status)) {
        setAttempt(null); setReview(null); onAttempt(null);
        if ([404, 409].includes(cause.status)) setConflict(true);
        try { writePendingAdminPromo(window.sessionStorage, actorPublicId, null); } catch { /* Nothing to mutate locally. */ }
      }
      setError(cause instanceof ApiError ? cause.message : "Ответ не получен. Повторите тот же запрос — изменение не будет выполнено дважды.");
    } finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const title = editor.pending ? "Проверить незавершённый запрос" : editor.mode === "delete" ? "Удалить промокод"
    : editor.mode === "toggle" ? `${editor.entry?.definition.enabled ? "Выключить" : "Включить"} промокод` : editor.entry ? "Изменить промокод" : "Создать промокод";
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <DialogContent className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy || attempt) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Подарок можно получить один раз на профиль. Все даты — по Москве (Europe/Moscow, UTC+03:00).</DialogDescription></DialogHeader>
      <div className={styles.dialogBody}>
        {review ? <><AdminPromoReview command={review} entry={editor.entry} />
          {attempt && <p className={styles.hint}>Этот запрос уже отправлялся. Повторная проверка использует ту же операцию и не создаёт копию. После закрытия запрос можно продолжить в этой вкладке.</p>}</> : <>
          {editor.mode === "edit" ? <>
            <div className={styles.fields}>
              <label className={styles.field}>Код для игрока<input value={draft.code} onChange={event => update("code", event.target.value.toUpperCase())} maxLength={40} placeholder="AUTUMN-GIFT" autoComplete="off" spellCheck={false} /><small>3–40 латинских букв, цифр, - или _</small></label>
              <label className={styles.field}>Название подарка<input value={draft.title} onChange={event => update("title", event.target.value)} maxLength={80} placeholder="Осенний подарок" /></label>
            </div>
            <label className={styles.checkbox}><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />Промокод включён <span>· с учётом срока ниже</span></label>
            <section className={styles.formSection}><h3>Что получит игрок</h3><p className={styles.hint}>Указывайте суммы как в игре: 20 жемчуга = 20 жемчуга у игрока.</p>
              <div className={styles.fields}>
                <label className={styles.field}>Монеты<input type="number" min="0" max="1000000" step="1" value={draft.coins} onChange={event => update("coins", event.target.value)} /></label>
                <label className={styles.field}>Жемчуг<input type="number" min="0" max="10000" step="1" value={draft.pearls} onChange={event => update("pearls", event.target.value)} /></label>
              </div>
              <div className={styles.fields}><label className={styles.field}>Найти предмет<input type="search" value={itemQuery} onChange={event => setItemQuery(event.target.value)} placeholder="Название предмета" /></label>
                <label className={styles.field}>Добавить предмет<select value="" onChange={event => { if (event.target.value) update("items", [...draft.items, { itemId: event.target.value, amount: "1" }]); }}><option value="">{items.length ? "Выберите предмет…" : "Нет подходящих предметов"}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
              {draft.items.map((item, index) => <div className={styles.itemRow} key={item.itemId}><span>{promoItemName(item.itemId)}</span>
                <input type="number" min="1" max="10000" step="1" aria-label={`Количество: ${promoItemName(item.itemId)}`} value={item.amount}
                  onChange={event => update("items", draft.items.map((selected, position) => position === index ? { ...selected, amount: event.target.value } : selected))} />
                <button type="button" className={styles.iconButton} aria-label={`Убрать ${promoItemName(item.itemId)}`} onClick={() => update("items", draft.items.filter((_, position) => position !== index))}><X size={16} aria-hidden="true" /></button></div>)}
              <small className={styles.hint}>До 1 000 000 монет, 10 000 жемчуга и 10 000 предметов суммарно.</small>
            </section>
            <section className={styles.formSection}><h3>Время действия · МСК</h3><div className={styles.fields}>
              <label className={styles.field}>Начало<input type="datetime-local" value={draft.startsAt} onChange={event => update("startsAt", event.target.value)} /><small>Пусто — сразу после включения.</small></label>
              <label className={styles.field}>Окончание<input type="datetime-local" value={draft.endsAt} onChange={event => update("endsAt", event.target.value)} /><small>В этот момент код перестаёт действовать.</small></label>
            </div><div className={styles.actions}><span className={styles.hint}>Срок от начала:</span>{[1, 7, 30].map(days => <button type="button" className={styles.button} key={days} onClick={() => {
              try { update("endsAt", promoPresetEnd(draft.startsAt, serverTime, days)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Проверьте начало акции"); }
            }}>{days === 1 ? "1 день" : `${days} дней`}</button>)}<button type="button" className={styles.button} onClick={() => update("endsAt", "")}>Без срока</button></div></section>
          </> : <section className={styles.review}><strong className={styles.code}>{editor.entry?.definition.code}</strong>
            <p>{editor.mode === "delete" ? "Код исчезнет из списка и перестанет работать. Уже выданные подарки и история сохранятся. Повторно создать этот код будет нельзя."
              : editor.entry?.definition.enabled ? "Новые активации будут остановлены. Уже выданные подарки останутся у игроков." : "Код станет доступен в пределах указанного срока. Убедитесь, что окончание акции ещё не наступило."}</p>
            {editor.entry && <AdminPromoReward definition={editor.entry.definition} />}</section>}
          <label className={styles.field}>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)} minLength={8} maxLength={240} /><small>8–240 символов. Сохранится в журнале администратора.</small></label>
          {editor.mode === "delete" && <label className={styles.field}>Введите {deletionCode} для удаления<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
        </>}
        {error && <p className={styles.error} role="alert">{error}{conflict ? " Закройте окно, обновите список и откройте актуальную запись." : ""}</p>}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => { if (review && !attempt) { setReview(null); setError(""); } else onClose(); }}>{review && !attempt ? "Вернуться к полям" : "Закрыть"}</button>
        {review ? <button type="button" className={editor.mode === "delete" ? styles.danger : styles.primary} disabled={busy} onClick={() => void submit()}>{busy ? "Сохраняем…" : attempt ? "Проверить / повторить" : editor.mode === "delete" ? "Подтвердить удаление" : "Подтвердить и сохранить"}</button>
          : <button type="button" className={styles.primary} disabled={conflict || !validAdminReason(reason) || !canDelete} onClick={prepare}>Проверить изменения</button>}
      </div>
    </DialogContent>
  </Dialog>;
}

export function AdminPromoPanel(props: { actorPublicId: string; onAccessLost: AccessLost }) {
  return <AdminPromoSession key={props.actorPublicId} {...props} />;
}
function AdminPromoSession({ actorPublicId, onAccessLost }: { actorPublicId: string; onAccessLost: AccessLost }) {
  const [data, setData] = useState<AdminPromos | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | PromoStatus>("all");
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [unresolved, setUnresolved] = useState<AdminPromoCommand | null>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const value = await loadAdminPromos(actorPublicId, controller.signal);
        if (controller.signal.aborted) return;
        setData(value); setError("");
        try { const saved = readPendingAdminPromo(window.sessionStorage, actorPublicId); if (saved) setUnresolved(saved); } catch { /* Storage can be disabled. */ }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setData(null); setEditor(null); onAccessLost(cause); return; }
        setError(cause instanceof ApiError ? cause.message : "Промокоды не загрузились. Повторите запрос.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [actorPublicId, version, onAccessLost]);
  function closeEditor() {
    setEditor(null);
    try { const saved = readPendingAdminPromo(window.sessionStorage, actorPublicId); if (saved) setUnresolved(saved); } catch { /* Preserve the in-memory retry. */ }
  }
  function openEditor(value: Editor) { if (!unresolved || value.pending) { editorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setNotice(""); setEditor(value); } }
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(code); setNotice(`Код ${code} скопирован.`); } catch { setNotice(`Скопируйте код вручную: ${code}`); }
  }
  return <div className={styles.stack}>
    <section className={styles.heading}><p>Изменения применяются сразу. Все сроки — по Москве.</p>
      <button type="button" className={styles.primary} disabled={!data || loading || !!unresolved} onClick={() => openEditor({ entry: null, mode: "edit" })}><Plus size={18} aria-hidden="true" />Создать промокод</button></section>
    {data && <div className={styles.metrics}>{(["active", "scheduled", "expired", "disabled"] as const).map(value => <button type="button" key={value} data-selected={status === value} className={styles.metric} onClick={() => setStatus(current => current === value ? "all" : value)}><strong>{number(data.codes.filter(entry => promoStatus(entry.definition, data.serverTime) === value).length)}</strong><span>{promoStatusLabels[value]}</span></button>)}</div>}
    <div className={styles.toolbar}><label className={styles.search}><Search size={17} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти по коду или названию" aria-label="Поиск промокода" /></label>
      <select aria-label="Статус промокода" value={status} onChange={event => setStatus(event.target.value as "all" | PromoStatus)}><option value="all">Все статусы</option>{Object.entries(promoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button type="button" className={styles.button} disabled={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />Обновить</button></div>
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    {unresolved && <div className={styles.warning}><p>Есть запрос без подтверждённого результата. Сначала проверьте его, чтобы продолжить работу.</p><button type="button" className={styles.button} onClick={() => openEditor({ pending: unresolved, mode: unresolved.action === "delete" ? "delete" : "edit", entry: data?.codes.find(entry => entry.definition.id === unresolved.promoId) ?? null })}>Продолжить запрос</button></div>}
    {error && <p role="alert" className={styles.error}>{error}{data ? " Показан последний успешный снимок." : ""}</p>}
    {data ? <><p className={styles.hint}>Снимок: {promoTime(data.serverTime)} · сроки и статусы по Москве · один подарок на профиль</p>
      <AdminPromoList data={data} query={query} status={status} disabled={!!unresolved || loading} onEdit={entry => openEditor({ entry, mode: "edit" })}
        onToggle={entry => openEditor({ entry, mode: "toggle" })} onDelete={entry => openEditor({ entry, mode: "delete" })} onCopy={code => void copy(code)} /></>
      : <p role="status" className={styles.empty}><Gift size={24} aria-hidden="true" />{loading ? "Загружаем промокоды…" : "Список недоступен. Нажмите «Обновить»."}</p>}
    {editor && data && <PromoEditor editor={editor} actorPublicId={actorPublicId} serverTime={data.serverTime}
      onClose={closeEditor} onAttempt={setUnresolved} onSaved={message => { setEditor(null); setUnresolved(null); setNotice(message); setVersion(value => value + 1); }} onAccessLost={onAccessLost} returnFocus={() => editorTrigger.current?.focus()} />}
  </div>;
}
