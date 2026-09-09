
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
import { TransientNotice } from "@/components/app-notifications";

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
    <button className={styles.trigger} data-context={context} disabled={!isOnline} onClick={()=>setOpen(true)}>{context==="profile" && <KeyRound size={18}/>} {context==="profile"?"Вернуть прежний профиль":"Не получается войти?"}</button>
    <Dialog open={open} onOpenChange={v=>{if(!v)close()}}>
      <DialogContent className={styles.dialog} aria-busy={busy}>
        <DialogHeader>
          <DialogTitle className={styles.title}>{recovered?"Профиль восстановлен":"Восстановление по коду"}</DialogTitle>
          <DialogDescription className={styles.description}>{recovered?"Вы снова в своём профиле. Старый код использован, а вход на других устройствах завершён. При желании создайте новый резервный код.":"Введите заранее сохранённый резервный код. Мы вернём ваш профиль с отметками, людьми и группами."}</DialogDescription>
        </DialogHeader>
        {recovered ? <>
          <RecoveryCodeCard isOnline={isOnline} onSessionLost={close}/>
          <button className={styles.primary} onClick={close}>Продолжить</button>
        </> : <form className={styles.codeForm} onSubmit={e=>void redeem(e)}>
          <label htmlFor="restore-code">Резервный код</label>
          <input id="restore-code" className={styles.codeInput} value={code} onChange={e=>setCode(e.target.value)} placeholder="ZHIV-R1-…" type="password" maxLength={80} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy}/>
          <p>После восстановления потребуется заново войти на других устройствах. Код сработает только один раз.</p>
          <p>Есть доступ к привязанному ВК или почте? Используйте обычный вход — код не понадобится.</p>
          <button type="submit" className={styles.primary} disabled={busy || !isOnline || !code.trim()}>{busy?"Восстанавливаем…":"Восстановить профиль"}</button>
        </form>}
        <TransientNotice message={error} kind="error" />
      </DialogContent>
    </Dialog>
  </>;
}
