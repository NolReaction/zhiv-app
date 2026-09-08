"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { getWorld, sendWorldCommand } from "./api";
import type { WorldCommand, WorldSnapshot } from "./model";

export function useWorld(owner: string, onSessionLost: () => void) {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const clock = useRef({ server: 0, local: 0 });
  const mounted = useRef(false);
  const current = useRef<WorldSnapshot | null>(null);
  const pending = useRef<WorldCommand | null>(null);
  const working = useRef(false);
  const sessionLost = useRef(onSessionLost);
  useEffect(() => { sessionLost.current = onSessionLost; }, [onSessionLost]);
  const adopt = useCallback((value: WorldSnapshot) => {
    if (!mounted.current) return;
    if (value.ownerPublicId !== owner) { sessionLost.current(); return; }
    if (current.current && value.revision < current.current.revision) return;
    current.current = value; setSnapshot(value);
    clock.current = { server: Date.parse(value.serverTime), local: performance.now() };
    setNow(clock.current.server);
  }, [owner]);
  const refresh = useCallback(async () => {
    if (working.current) return;
    try { const value = await getWorld(); adopt(value); if (mounted.current && !pending.current) setError(null); }
    catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status === 401) sessionLost.current();
      else setError(e instanceof ApiError ? e.message : "Нет связи. Прогресс на сервере сохранён.");
    }
  }, [adopt]);
  useEffect(() => {
    mounted.current = true;
    const kickoff = setTimeout(() => { if (mounted.current) void refresh(); }, 0);
    const visible = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(() => { if (!document.hidden) { setNow(clock.current.server + performance.now() - clock.current.local); } }, 1000);
    const polling = setInterval(visible, 30000);
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible);
    return () => { mounted.current = false; clearTimeout(kickoff); clearInterval(timer); clearInterval(polling); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); };
  }, [refresh]);
  const execute = useCallback(async (command: WorldCommand) => {
    if (working.current) return;
    working.current = true; pending.current = command; setBusy(true); setError(null);
    try {
      const result = await sendWorldCommand(command);
      if (!mounted.current) return;
      adopt(result.snapshot); setNotice(result.message); pending.current = null; setUncertain(false);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status < 500) {
        pending.current = null; setUncertain(false);
        if (e.status === 401) sessionLost.current();
        else { const latest = await getWorld().catch(() => null); if (latest) adopt(latest); }
      } else setUncertain(true);
      if (mounted.current) setError(e instanceof ApiError ? e.message : "Ответ не пришёл. Проверьте результат тем же запросом.");
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }, [adopt]);
  const act = useCallback((action: WorldCommand["action"], target = "") => {
    if (!current.current || pending.current) return;
    void execute({ requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: current.current.revision, action, target });
  }, [execute, owner]);
  const retry = () => { if (pending.current) void execute(pending.current); else void refresh(); };
  return { snapshot, now, busy, uncertain, error, notice, act, retry, refresh };
}
