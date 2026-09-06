
"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { activateRecoveryCode, getRecoveryCodeState, ApiError } from "@/lib/check-in-api";
import { createRecoveryCode } from "@/lib/recovery-code";
import { copyTextFromVisibleField } from "@/lib/identity-sharing";
import styles from "./recovery-starter.module.css";

export function RecoveryCodeCard({isOnline, onSessionLost}: {isOnline:boolean; onSessionLost:()=>void}) {
  const fieldId = useId();
  const titleId = useId();
  const codeField = useRef<HTMLTextAreaElement>(null);
  const [active,setActive]=useState<boolean|null>(null);
  const [code,setCode]=useState("");
  const [saved,setSaved]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    let live=true;
    getRecoveryCodeState().then(s=>{if(live)setActive(s.active)}).catch(e=>{
      if(!live)return;
      if(e instanceof ApiError && e.status===401)onSessionLost();
      else setNotice("Не удалось проверить код. Повторите открытие профиля.");
    });
    return()=>{live=false};
  },[onSessionLost]);
  async function activate() {
    setBusy(true); setNotice("");
    try {
      await activateRecoveryCode(code); setActive(true); setCode(""); setSaved(false);
      setNotice("Код активирован. Храните его отдельно от этого устройства.");
    } catch(e) {
      if(e instanceof ApiError && e.status===401)onSessionLost();
      setNotice(e instanceof Error?e.message:"Не удалось активировать код. Повторите с тем же кодом.");
    } finally {setBusy(false)}
  }
  async function copyCode() {
    const field = codeField.current;
    if (!field) return;
    const outcome = await copyTextFromVisibleField(code, field);
    setNotice(outcome === "confirmed"
      ? "Код скопирован. Вставьте его в менеджер паролей и проверьте сохранение."
      : outcome === "legacy"
        ? "Код выделен. Проверьте вставку. Если код не вставляется, выберите «Скопировать» в меню выделения."
        : "Зажмите код и выберите «Скопировать», затем вставьте и проверьте сохранение.");
  }
  return <section className={styles.codeCard} aria-labelledby={titleId}>
    <h2 id={titleId}><ShieldCheck size={20}/> Код восстановления</h2>
    <p>Личный одноразовый ключ от профиля. Сохраните в менеджере паролей или на бумаге. Никому не отправляйте — даже близким.</p>
    <p>{active===null?"Проверяем…":active?"Код настроен. Показать прежний код нельзя.":"Код ещё не настроен. При потере сессии без кода вернуть профиль не получится."}</p>
    {!code ? <button className={styles.primary} disabled={!isOnline || active===null} onClick={()=>{
      setCode(createRecoveryCode());setSaved(false);setNotice("");
    }}>{active?"Заменить код":"Создать код"}</button> : <>
      <label htmlFor={fieldId}>Сохраните этот код, затем активируйте</label>
      <textarea id={fieldId} ref={codeField} className={styles.codeInput} readOnly rows={3} value={code} autoComplete="off" spellCheck={false}/>
      <button type="button" className={styles.copyButton} onClick={()=>void copyCode()}>Скопировать код</button>
      <label className={styles.confirm}><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)}/> Я сохранил код в безопасном месте</label>
      <button className={styles.primary} disabled={!saved || busy || !isOnline} onClick={()=>void activate()}>{busy?"Активируем…":"Активировать код"}</button>
      <p>После активации прежний код перестанет работать. Сам код не сохраняется в браузере или базе сервера.</p>
    </>}
    {notice?<p role="status">{notice}</p>:null}
  </section>;
}
