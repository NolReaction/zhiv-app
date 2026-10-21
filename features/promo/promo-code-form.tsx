"use client";
import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { useId, useRef, useState } from "react";
import { Gift, Ticket } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { formatPearls } from "@/features/economy/domain/money";
import type { EconomyView } from "@/features/economy/domain/model";
import { ApiError } from "@/lib/check-in-api";
import { redeemPromoCode } from "./api";
import { normalizePromoCode, promoRequestSchema, type PromoRequest, type PromoResult } from "./model";
import styles from "./promo-code-form.module.css";

const pendingKey = (owner: string) => gameplayStorageKey(`zhiv:pending-promo:v1:${owner}`);
function saved(owner: string): PromoRequest | null {
  try { const result = promoRequestSchema.safeParse(JSON.parse(sessionStorage.getItem(pendingKey(owner)) ?? "null"));
    return result.success && result.data.ownerPublicId === owner ? result.data : null; } catch { return null; }
}
function persist(owner: string, value: PromoRequest | null) {
  try { if (value) sessionStorage.setItem(pendingKey(owner), JSON.stringify(value)); else sessionStorage.removeItem(pendingKey(owner)); } catch { /* Receipt still survives in component memory. */ }
}
export function PromoCodeForm({ state, onRedeemed }: { state: EconomyView | null; onRedeemed?: () => void | Promise<unknown> }) {
  const [open, setOpen] = useState(false), [code, setCode] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [result, setResult] = useState<PromoResult | null>(null), [uncertain, setUncertain] = useState(false);
  const pending = useRef<PromoRequest | null>(null), sending = useRef(false), id = useId();
  function expand() {
    if (!open && state) { pending.current = saved(state.ownerPublicId); if (pending.current) { setCode(pending.current.code); setUncertain(true); } }
    setOpen(!open);
  }
  async function submit() {
    if (!state || sending.current) return;
    const request = pending.current ?? { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision, code: normalizePromoCode(code) };
    if (!promoRequestSchema.safeParse(request).success) { setError("Введите промокод: от 3 до 40 латинских букв, цифр, - или _."); return; }
    sending.current = true; setBusy(true); setError(""); setResult(null); pending.current = request; persist(request.ownerPublicId, request);
    try {
      const reward = await redeemPromoCode(request);
      pending.current = null; persist(request.ownerPublicId, null); setUncertain(false); setResult(reward); setCode("");
      await Promise.resolve(onRedeemed?.()).catch(() => undefined);
    } catch (cause) {
      const unknown = !(cause instanceof ApiError) || cause.status >= 500 || cause.status === 408 || cause.status === 429;
      if (!unknown) { pending.current = null; persist(request.ownerPublicId, null); }
      setUncertain(unknown);
      setError(unknown ? (cause instanceof ApiError && cause.status === 429 ? cause.message : "Ответ не дошёл. Нажмите «Проверить получение»: подарок не выдастся дважды.") : cause instanceof ApiError ? cause.message : "Не удалось проверить промокод.");
      if (cause instanceof ApiError && cause.body?.code === "ECONOMY_REVISION_CONFLICT") await Promise.resolve(onRedeemed?.()).catch(() => undefined);
    } finally { sending.current = false; setBusy(false); }
  }
  return <div className={styles.promo}>
    <button className={styles.toggle} type="button" onClick={expand} aria-expanded={open} aria-controls={`${id}-form`}>
      <Ticket size={18} aria-hidden="true" />У меня есть промокод<span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open && <form id={`${id}-form`} className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor={`${id}-code`}>Промокод</label>
      <div className={styles.fields}><input id={`${id}-code`} name="promo-code" value={code} onChange={event => { setCode(event.target.value); setError(""); }}
        autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} placeholder="Например, FOREST-GIFT" disabled={busy || uncertain}
        aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
        <button type="submit" disabled={!state || busy || (!uncertain && !code.trim())}>{busy ? "Проверяем..." : uncertain ? "Проверить получение" : "Получить"}</button></div>
      {!state && <p>Промокод станет доступен, когда загрузится полянка.</p>}
      {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      {result && <div className={styles.receipt} role="status"><strong><Gift size={17} aria-hidden="true" />{result.title}</strong><p>{result.replayed ? "Этот подарок уже в вашем хозяйстве." : "Подарок добавлен в ваше хозяйство."}</p>
        <ul>{result.reward.coins > 0 && <li><ItemIcon itemId="coins" size={19} />+{result.reward.coins.toLocaleString("ru-RU")} монет</li>}
          {result.reward.pearls > 0 && <li><ItemIcon itemId="pearls" size={19} />+{formatPearls(result.reward.pearls)} жемчуга</li>}
          {Object.entries(result.reward.items).map(([item, count]) => <li key={item}><ItemIcon itemId={item} size={19} />+{count} {state?.catalog.items.find(entry => entry.id === item)?.name ?? item}</li>)}</ul>
      </div>}
    </form>}
  </div>;
}
