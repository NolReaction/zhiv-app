
"use client";
import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { MeResponse } from "@/lib/check-in-contract";
import { redeemRecoveryCode } from "@/lib/check-in-api";
import { normalizeRecoveryCode } from "@/lib/recovery-code";
import { createRecoveryAttemptStore, recoveryAttemptRejected, recoveryAttemptStorage, type RecoveryAttempt } from "./recovery-attempt";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RecoveryCodeCard } from "./recovery-code-card";
import styles from "./recovery-starter.module.css";
import { TransientNotice } from "@/components/app-notifications";

export function RecoveryStarter({context,isOnline,onRecovered}: {
  context:"onboarding"|"session-lost"|"profile";isOnline:boolean;onRecovered:(me:MeResponse)=>void;
}) {
  const [open,setOpen]=useState(false), [code,setCode]=useState(""), [busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[recovered,setRecovered]=useState<MeResponse|null>(null);
  const [attempts] = useState(() => createRecoveryAttemptStore(recoveryAttemptStorage()));
  const [retryNotice, setRetryNotice] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    attempts.prune();
    const clock = setInterval(attempts.prune, 30_000);
    return () => clearInterval(clock);
  }, [attempts]);
  function close() {
    if(busy)return;
    if(recovered)onRecovered(recovered);
    setOpen(false);setCode("");setError("");setRecovered(null);setRetryNotice("");
  }
  async function redeem(event:React.FormEvent) {
    event.preventDefault();
    if(inFlight.current)return;
    const normalized=normalizeRecoveryCode(code);
    if(!normalized){setError("Введите целиком код, начинающийся с ZHIV-R1-. Это не публичный ID и не код приглашения.");return}
    inFlight.current=true;
    setBusy(true);setError("");
    let attempt: RecoveryAttempt | undefined;
    try {
      attempt=await attempts.prepare(normalized);
      const me=await redeemRecoveryCode(normalized,attempt.retrySecret);
      attempts.clear(attempt);setRecovered(me);setCode("");setRetryNotice("");
    } catch(e) {
      if(attempt && recoveryAttemptRejected(e)) {attempts.clear(attempt);setRetryNotice("");}
      else if(attempt) setRetryNotice(attempt.persisted
        ? "Повторите с тем же кодом в течение 10 минут от первой попытки. Можно закрыть окно или перезагрузить эту вкладку — код потребуется ввести снова."
        : "Браузер не сохранил попытку. Повторите с тем же кодом в этом окне; после перезагрузки повтор может быть недоступен.");
      setError(e instanceof Error?e.message:"Не удалось подключиться. Повторите с тем же кодом.");
    }
    finally {inFlight.current=false;setBusy(false)}
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
          {retryNotice && <p role="status">{retryNotice}</p>}
          <button type="submit" className={styles.primary} disabled={busy || !isOnline || !code.trim()}>{busy?"Восстанавливаем…":"Восстановить профиль"}</button>
        </form>}
        <TransientNotice message={error} kind="error" />
      </DialogContent>
    </Dialog>
  </>;
}
