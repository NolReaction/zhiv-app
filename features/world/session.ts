import { reportIncident, incidentCode } from "@/lib/client-incidents";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import type { WorldCommand, WorldSnapshot } from "./model";

type Transport = {
  get: (signal: AbortSignal) => Promise<WorldSnapshot>;
  send: (command: WorldCommand, signal: AbortSignal) => Promise<{ snapshot: WorldSnapshot; message: string }>;
};
type View = { snapshot: WorldSnapshot | null; error: string | null; notice: string; busy: boolean; uncertain: boolean; feedbackAt: number };

/** One account session survives opening/closing the map; receipts never belong to a renderer. */
export function createWorldSession(owner: string | null, transport: Transport, onSessionLost: () => void) {
  let view: View = { snapshot: null, error: null, notice: "", busy: false, uncertain: false, feedbackAt: 0 };
  let pending: WorldCommand | null = null;
  let active = false, epoch = 0, readSequence = 0;
  let serverClock = Date.now(), localClock = performance.now();
  const listeners = new Set<() => void>(), requests = new Set<AbortController>();
  const publish = (patch: Partial<View>) => {
    if (patch.notice || patch.error && patch.error !== view.error) patch.feedbackAt = Date.now();
    view = { ...view, ...patch }; listeners.forEach(listener => listener());
  };
  const valid = (generation: number) => active && generation === epoch;
  function adopt(value: WorldSnapshot) {
    if (value.ownerPublicId !== owner) { onSessionLost(); return false; }
    if (view.snapshot && value.revision < view.snapshot.revision) return true;
    serverClock = Date.parse(value.serverTime); localClock = performance.now();
    publish({ snapshot: value }); return true;
  }
  const controller = () => { const request = new AbortController(); requests.add(request); return request; };
  async function refresh() {
    if (!active || !owner || view.busy) return;
    const generation = epoch, sequence = ++readSequence, request = controller();
    try {
      const snapshot = await transport.get(request.signal);
      if (valid(generation) && sequence === readSequence && adopt(snapshot) && !pending) publish({ error: null });
    } catch (error) {
      if (!valid(generation) || sequence !== readSequence) return;
      reportIncident(owner, "world", incidentCode(error), 0, error);
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (!pending) publish({ error: error instanceof ApiError ? error.message : "Нет связи. Сохранённый мир появится после подключения." });
    } finally { requests.delete(request); }
  }
  async function execute(command: WorldCommand) {
    if (!active || view.busy || command.ownerPublicId !== owner) return;
    const generation = epoch, request = controller();
    ++readSequence;
    pending = command; publish({ busy: true, error: null, notice: "" });
    try {
      const result = await transport.send(command, request.signal);
      if (!valid(generation)) return;
      if (adopt(result.snapshot)) { pending = null; publish({ notice: result.message, uncertain: false }); }
    } catch (error) {
      if (!valid(generation)) return;
      if (owner) reportIncident(owner, "world", incidentCode(error), 0, error);
      const definitive = error instanceof ApiError && error.status < 500;
      if (definitive) pending = null;
      publish({ uncertain: !definitive, error: error instanceof ApiError ? error.message : "Ответ не пришёл. Проверьте результат тем же запросом." });
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else if (definitive) {
        const snapshot = await transport.get(request.signal).catch(() => null);
        if (valid(generation) && snapshot) adopt(snapshot);
      }
    } finally {
      requests.delete(request);
      if (valid(generation)) publish({ busy: false });
    }
  }
  return {
    setSessionLost(callback: () => void) { onSessionLost = callback; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    now: () => serverClock + performance.now() - localClock,
    activate() {
      active = true;
      return () => {
        active = false; epoch++; readSequence++;
        requests.forEach(request => request.abort()); requests.clear();
        if (view.busy) publish({ busy: false, uncertain: Boolean(pending) });
      };
    },
    refresh,
    act(action: WorldCommand["action"], target = "") {
      if (!owner || !view.snapshot || pending || !active) return;
      void execute({ requestId: createUuidV4(), ownerPublicId: owner, expectedRevision: view.snapshot.revision, action, target });
    },
    retry: () => pending ? execute(pending) : refresh(),
  };
}
