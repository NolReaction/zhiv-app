import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { ACTIVITY_HEARTBEAT_MS, ACTIVITY_IDLE_MS, type PresenceCommand, type PresenceView } from "./model";
export type ActivityMode = "connecting" | "active" | "offline" | "away" | "hidden" | "error";
export type ActivityView = { mode: ActivityMode; error: string | null; retryAt: number; online: boolean };
type Options = {
  send: (command: PresenceCommand, signal: AbortSignal) => Promise<PresenceView>;
  reconcile: () => Promise<boolean>;
  connected: (id: string | null) => void;
  sessionLost: () => void;
  now?: () => number;
};
/** Input, server lease and reconciliation are separate: timers or AI never count as player input. */
export function createActivitySession(options: Options) {
  const now = options.now ?? Date.now;
  let view: ActivityView = { mode: "connecting", error: null, retryAt: 0, online: true };
  let running = false, online = true, visible = true, generation = 0;
  let lastInput = now(), acknowledgedInput = lastInput - 1, lastBeat = -Infinity;
  let presenceId: string | null = null, sequence = 0, pendingResume: PresenceCommand | null = null;
  let request: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ActivityView>) => { view = { ...view, ...patch }; listeners.forEach(listener => listener()); };
  const idle = () => now() - lastInput >= ACTIVITY_IDLE_MS;
  function disconnect(mode: ActivityMode, notify = true) {
    const previous = presenceId;
    ++generation; request?.abort(); request = null; presenceId = null; pendingResume = null;
    options.connected(null);
    publish({ mode, error: null, retryAt: 0 });
    if (previous && notify && online) {
      const controller = new AbortController();
      void options.send({ kind: "suspend", presenceId: previous, sequence: ++sequence, active: false }, controller.signal).catch(() => {});
    }
  }
  async function connect(explicit: boolean) {
    if (!running || request || !online || !visible || now() < view.retryAt) return;
    if (explicit) lastInput = now();
    else if (view.mode === "away" || idle()) { disconnect("away"); return; }
    const epoch = ++generation, controller = new AbortController(); request = controller;
    const command = pendingResume ?? { kind: "resume" as const, presenceId: createUuidV4(), sequence: 0, active: true };
    pendingResume = command;
    options.connected(null); publish({ mode: "connecting", error: null, retryAt: 0 });
    try {
      const answer = await options.send(command, controller.signal);
      if (!running || epoch !== generation) return;
      if (answer.presenceId !== command.presenceId) throw new Error("Presence owner mismatch");
      if (answer.status !== "active") {
        pendingResume = null;
        publish({ mode: answer.status === "idle" ? "away" : "error", error: answer.status === "idle" ? null : "Подключение истекло. Повторите вход в игру.", retryAt: 0 });
        return;
      }
      presenceId = command.presenceId; sequence = 0; pendingResume = null;
      acknowledgedInput = lastInput; lastBeat = now(); options.connected(presenceId);
      const ready = await options.reconcile();
      if (!running || epoch !== generation) return;
      if (idle()) { disconnect("away"); return; }
      if (!ready) throw new Error("Не удалось сверить сохранённые действия. Повторите проверку.");
      publish({ mode: "active", error: null, retryAt: 0 });
    } catch (error) {
      if (!running || epoch !== generation) return;
      if (presenceId) {
        const id = presenceId; presenceId = null;
        void options.send({ kind: "suspend", presenceId: id, sequence: ++sequence, active: false }, new AbortController().signal).catch(() => {});
      }
      options.connected(null);
      if (error instanceof ApiError && error.status === 401) options.sessionLost();
      publish({ mode: online ? "error" : "offline", error: error instanceof ApiError ? error.message : "Не удалось сверить сохранённые действия. Повторите проверку.",
        retryAt: now() + (error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000) : 3000) });
    } finally { if (request === controller) request = null; }
  }
  async function heartbeat() {
    if (!running || request || !presenceId || view.mode !== "active" || !online || !visible) return;
    if (idle()) { disconnect("away"); return; }
    const epoch = generation, controller = new AbortController(); request = controller;
    const inputAt = lastInput, command = { kind: "heartbeat" as const, presenceId, sequence: ++sequence, active: inputAt > acknowledgedInput };
    lastBeat = now();
    try {
      const answer = await options.send(command, controller.signal);
      if (!running || epoch !== generation) return;
      if (answer.presenceId !== command.presenceId) throw new Error("Presence owner mismatch");
      if (answer.status !== "active") { disconnect(answer.status === "idle" ? "away" : "error", false); return; }
      acknowledgedInput = inputAt;
    } catch (error) {
      if (!running || epoch !== generation) return;
      disconnect("error", false);
      if (error instanceof ApiError && error.status === 401) options.sessionLost();
      publish({ error: "Потеряна связь с сервером. Сверим сохранённые действия перед продолжением.",
        retryAt: now() + (error instanceof ApiError && error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 60_000) : 3000) });
    } finally { if (request === controller) request = null; }
  }
  return {
    configure(callbacks: Pick<Options, "reconcile" | "connected" | "sessionLost">) { options = { ...options, ...callbacks }; },
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    getSnapshot: () => view,
    start(isOnline: boolean, isVisible: boolean) { running = true; online = isOnline; visible = isVisible; lastInput = now(); publish({ online });
      if (!online) publish({ mode: "offline" }); else if (!visible) publish({ mode: "hidden" }); else void connect(false);
      return () => { running = false; disconnect("hidden"); };
    },
    input() { if (!running || !online || !visible || view.mode !== "active") return;
      if (idle()) disconnect("away"); else { lastInput = now(); if (lastInput - acknowledgedInput >= ACTIVITY_IDLE_MS - 60_000) void heartbeat(); }
    },
    check() { if (!running) return; if (view.mode !== "away" && idle()) { disconnect("away"); return; }
      if (view.mode === "active" && now() - lastBeat >= ACTIVITY_HEARTBEAT_MS) void heartbeat();
    },
    environment(isOnline: boolean, isVisible: boolean) {
      online = isOnline; visible = isVisible; publish({ online });
      if (!running) return;
      if (idle() || view.mode === "away") { disconnect("away"); return; }
      if (!online) disconnect("offline", false);
      else if (!visible) disconnect("hidden");
      else if (view.mode !== "active" && view.mode !== "connecting") void connect(false);
    },
    expired() { if (running) disconnect(idle() ? "away" : "error", false); },
    resume: () => connect(true),
    retry: () => connect(false),
  };
}
