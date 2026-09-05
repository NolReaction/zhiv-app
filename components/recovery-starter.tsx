
"use client";
import { useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { MeResponse } from "@/lib/check-in-contract";
import { redeemRecoveryCode } from "@/lib/check-in-api";
import { normalizeRecoveryCode } from "@/lib/recovery-code";
import { createCapabilityToken } from "@/lib/capability-token";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RecoveryCodeCard } from "./recovery-code-card";
import styles from "./recovery-starter.module.css";

export function RecoveryStarter({context,isOnline,onRecovered}: {
  context:"onboarding"|"session-lost"|"profile";isOnline:boolean;onRecovered:(me:MeResponse)=>void;
}) {
  const [open,setOpen]=useState(false), [code,setCode]=useState(""), [busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[recovered,setRecovered]=useState<MeResponse|null>(null);
  const retry=useRef<{code:string;secret:string}|null>(null);
  function close() {
    if(busy)return;
    if(recovered)onRecovered(recovered);
    setOpen(false);setCode("");setError("");setRecovered(null);retry.current=null;
  }
  async function redeem(event:React.FormEvent) {
    event.preventDefault();
    const normalized=normalizeRecoveryCode(code);
    if(!normalized){setError("Введите целиком код, начинающийся с ZHIV-R1-. Это не публичный ID и не код приглашения.");return}
    retry.current=retry.current?.code===normalized?retry.current:{code:normalized,secret:createCapabilityToken()};
    setBusy(true);setError("");
    try {
      const me=await redeemRecoveryCode(normalized,retry.current.secret);
      setRecovered(me);setCode("");retry.current=null;
    } catch(e) {setError(e instanceof Error?e.message:"Не удалось подключиться. Повторите, не закрывая окно.");}
    finally {setBusy(false)}
  }
  return <>
    <button className={styles.trigger} data-context={context} disabled={!isOnline} onClick={()=>setOpen(true)}><KeyRound size={18}/>{context==="profile"?"Вернуть прежний профиль":"У меня уже есть код восстановления"}</button>
    <Dialog open={open} onOpenChange={v=>{if(!v)close()}}>
      <DialogContent className={styles.dialog} aria-busy={busy}>
        <DialogHeader>
          <DialogTitle className={styles.title}>{recovered?"Профиль восстановлен":"Восстановление по коду"}</DialogTitle>
          <DialogDescription className={styles.description}>{recovered?"Прежние сессии закрыты, использованный код больше не действует. Сохраните новый код.":"Введите личный код, который вы заранее сохранили в профиле. Отметки, люди и группы останутся; прежние сессии закроются."}</DialogDescription>
        </DialogHeader>
        {recovered ? <>
          <RecoveryCodeCard isOnline={isOnline} onSessionLost={close}/>
          <button className={styles.primary} onClick={close}>Продолжить</button>
        </> : <form className={styles.codeForm} onSubmit={e=>void redeem(e)}>
          <label htmlFor="restore-code">Личный код восстановления</label>
          <input id="restore-code" className={styles.codeInput} value={code} onChange={e=>setCode(e.target.value)} placeholder="ZHIV-R1-…" type="password" maxLength={80} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}/>
          <p>Нет кода? Если профиль ещё открыт на другом устройстве, создайте код там. Без кода и активной сессии восстановление невозможно.</p>
          <button type="submit" className={styles.primary} disabled={busy || !isOnline || !code.trim()}>{busy?"Восстанавливаем…":"Восстановить профиль"}</button>
        </form>}
        {error?<p role="alert" className={styles.error}>{error}</p>:null}
      </DialogContent>
    </Dialog>
  </>;
}
