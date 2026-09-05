
"use client";
import {useEffect,useRef,useState} from "react";
import {Copy,Link2} from "lucide-react";
import type {DirectInvitePreview} from "@/lib/check-in-contract";
import {ApiError,previewDirectInvite,redeemDirectInvite} from "@/lib/check-in-api";
import {isCapabilityToken} from "@/lib/capability-token";
import {createUuidV4} from "@/lib/browser-uuid";
import {copyText} from "@/lib/identity-sharing";
import {INVITE_IMPORT_EVENT,inviteCode} from "@/lib/invite-import";
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import styles from "./capability-landing.module.css";
const INVITE_KEY="zhiv.pending-direct-invite.v1";
const INVITE_REDEEM_KEY="zhiv.pending-direct-invite-redeem.v1";
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type InviteRedeemResume={version:1;token:string;idempotencyKey:string};
function readInviteRedeemResume(token: string): InviteRedeemResume | null {
  try {
    const raw = window.sessionStorage.getItem(INVITE_REDEEM_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "token" in value &&
      value.token === token &&
      "idempotencyKey" in value &&
      typeof value.idempotencyKey === "string" &&
      UUID_PATTERN.test(value.idempotencyKey)
    ) return value as InviteRedeemResume;
    window.sessionStorage.removeItem(INVITE_REDEEM_KEY);
    return null;
  } catch {
    clearInviteRedeemResume();
    return null;
  }
}

function persistInviteRedeemResume(value: InviteRedeemResume) {
  try {
    window.sessionStorage.setItem(INVITE_REDEEM_KEY, JSON.stringify(value));
  } catch {
    // The mounted component still reuses its in-memory request key.
  }
}

function clearInviteRedeemResume() {
  try {
    window.sessionStorage.removeItem(INVITE_REDEEM_KEY);
  } catch {
    // Storage may be unavailable.
  }
}


export function CapabilityLanding({authenticated,onInviteAccepted}:{authenticated:boolean;onInviteAccepted:()=>void}) {
  const [pending,setPending]=useState<string|null>(null),[invite,setInvite]=useState<DirectInvitePreview|null>(null);
  const [retired,setRetired]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const [bridgeNotice,setBridgeNotice]=useState<string|null>(null);
  const inviteRedeemResume=useRef<InviteRedeemResume|null>(null);
  const accepted=useRef(onInviteAccepted);
  useEffect(()=>{accepted.current=onInviteAccepted},[onInviteAccepted]);
  function clearInvite() {
    try {window.sessionStorage.removeItem(INVITE_KEY)} catch {}
    clearInviteRedeemResume();inviteRedeemResume.current=null;setPending(null);
  }
  useEffect(()=>{
    let alive=true;
    let generation=0;
    async function readAndOpenCapability() {
      const currentGeneration=++generation;
      try {
        for(const key of ["zhiv.pending-recovery-approval.v2","zhiv.pending-recovery-confirm.v1","zhiv.pending-recovery-link.v1","zhiv.recovery-attempt.v2"])window.sessionStorage.removeItem(key);
      } catch {}
      if(window.location.hash.startsWith("#/recover/")) {
        window.history.replaceState(null,"",window.location.pathname+window.location.search);
        setRetired(true);return;
      }
      const match=/^#\/invite\/([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
      let token=match?.[1]??null;
      if(token) {
        window.history.replaceState(null,"",window.location.pathname+window.location.search);
        try {window.sessionStorage.setItem(INVITE_KEY,token)} catch {}
      } else {
        try {token=window.sessionStorage.getItem(INVITE_KEY)} catch {}
      }
      if(!token || !isCapabilityToken(token))return;
      const value=token;
      inviteRedeemResume.current=readInviteRedeemResume(value);
      setPending(value);setInvite(null);setError(null);setLoading(true);
      try {
        const response=await previewDirectInvite(value);
        if(alive && generation===currentGeneration)setInvite(response);
      } catch(cause) {
        if(!alive || generation!==currentGeneration)return;
        const replay=inviteRedeemResume.current;
        if(authenticated && replay && cause instanceof ApiError && [409,410].includes(cause.status)){
          try {await redeemDirectInvite(value,replay.idempotencyKey);if(alive){clearInvite();accepted.current()}}
          catch(e){if(alive)setError(e instanceof Error?e.message:"Не удалось принять приглашение")}
        } else setError(cause instanceof Error?cause.message:"Ссылка недействительна");
      } finally {if(alive && generation===currentGeneration)setLoading(false)}
    }
    const initialize=window.setTimeout(()=>void readAndOpenCapability(),0);
    const handler=()=>void readAndOpenCapability();
    window.addEventListener(INVITE_IMPORT_EVENT,handler);
    window.addEventListener("hashchange",handler);
    return()=>{alive=false;window.clearTimeout(initialize);window.removeEventListener(INVITE_IMPORT_EVENT,handler);window.removeEventListener("hashchange",handler)};
  },[authenticated]);
  async function acceptInvite() {
    if(!pending || !authenticated || loading)return;
    const resume=inviteRedeemResume.current??{version:1 as const,token:pending,idempotencyKey:createUuidV4()};
    inviteRedeemResume.current=resume;persistInviteRedeemResume(resume);setLoading(true);setError(null);
    try {await redeemDirectInvite(pending,resume.idempotencyKey);clearInvite();onInviteAccepted()}
    catch(e){setError(e instanceof Error?e.message:"Не удалось принять приглашение")}
    finally {setLoading(false)}
  }
  return <Dialog open={pending!==null || retired} onOpenChange={v=>{
    if(v || loading)return;setRetired(false);
    if(authenticated)clearInvite();else setPending(null);
  }}>
    <DialogContent className={styles.dialog} aria-busy={loading}>
      <DialogHeader>
        <span className={styles.icon}><Link2/></span>
        <DialogTitle className={styles.title}>{retired?"Восстановление изменилось":"Личное приглашение"}</DialogTitle>
        <DialogDescription className={styles.description}>{retired?"Ссылки восстановления через друзей больше не действуют. Владелец входит по личному коду восстановления.":invite?invite.inviter.displayName+" приглашает вас в личные связи."+(authenticated?"":" На этом адресе и в этом браузере активной сессии нет."):"Проверяем приглашение…"}</DialogDescription>
      </DialogHeader>
      {retired?<button className={styles.primary} onClick={()=>setRetired(false)}>Понятно</button>:<>
        {invite?<p className={styles.note}>После принятия вы увидите только новые отметки друг друга. Старая история не откроется.</p>:null}
        {invite && pending && !authenticated?<div className={styles.appBridge}>
          <p>Вернитесь туда, где профиль уже открыт — в исходную вкладку или приложение с домашнего экрана. Скопируйте код и выберите «Люди» → «Принять».</p>
          <textarea className={styles.inviteCode} aria-label="Одноразовый код приглашения" readOnly rows={3} value={inviteCode(pending)}/>
          <button className={styles.bridgeCopy} onClick={async()=>setBridgeNotice(await copyText(inviteCode(pending))?"Код скопирован. Откройте «Люди» → «Принять».":"Зажмите код выше и выберите «Скопировать».")}><Copy size={16}/>Скопировать код для приложения</button>
        </div>:null}
        {bridgeNotice?<p className={styles.note} role="status">{bridgeNotice}</p>:null}
        {error?<p className={styles.error} role="alert">{error}</p>:null}
        {authenticated?<button className={styles.primary} disabled={loading || !invite} onClick={()=>void acceptInvite()}>{loading?"Проверяем…":"Принять приглашение"}</button>:<button className={styles.primary} disabled={loading || !invite} onClick={()=>setPending(null)}>Продолжить в этом браузере</button>}
        <button className={styles.secondary} disabled={loading} onClick={clearInvite}>{authenticated?"Не сейчас":"Отказаться от приглашения"}</button>
      </>}
    </DialogContent>
  </Dialog>;
}
