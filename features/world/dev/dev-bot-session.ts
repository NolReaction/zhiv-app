import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { devBotCommandSchema, type DevBotAction, type DevBotCommand, type DevBotResult, type DevBotsSnapshot } from "./dev-bot-model";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Transport = {
  get: (owner: string, signal: AbortSignal) => Promise<DevBotsSnapshot>;
  send: (command: DevBotCommand, signal: AbortSignal) => Promise<DevBotResult>;
};
type View = { snapshot: DevBotsSnapshot | null; busy: boolean; loading: boolean; uncertain: boolean; error: string | null; notice: string };

/** DEV grants and account creation still need exact-request recovery after a lost response. */
export function createDevBotSession(owner: string | null, transport: Transport, storage?: Storage | null,
  available = () => typeof navigator === "undefined" || navigator.onLine !== false) {
  const initial: View = { snapshot: null, busy: false, loading: false, uncertain: false, error: null, notice: "" };
  let view = initial, active = false, epoch = 0, sequence = 0, pending: DevBotCommand | null = null;
  const key = `zhiv:dev:bots:pending:v1:${owner}`;
  const listeners = new Set<() => void>(), requests = new Set<AbortController>();
  const publish = (patch: Partial<View>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
  const save = (command: DevBotCommand | null) => {
    pending = command;
    try { if (command) storage?.setItem(key, JSON.stringify(command)); else storage?.removeItem(key); } catch { /* Private browsing can disable storage. */ }
  };
  const restore = () => {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return;
      const parsed = devBotCommandSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.ownerPublicId === owner) pending = parsed.data;
      else storage?.removeItem(key);
    } catch { try { storage?.removeItem(key); } catch { /* No writable session storage. */ } }
  };
  const message = (error: unknown) => error instanceof Error ? error.message : "Не удалось выполнить команду бота.";
  const valid = (generation: number) => active && epoch === generation;
  async function refresh() {
    if (!owner || !active || view.busy) return;
    if (!available()) { publish({ snapshot: null, loading: false, error: "Для управления ботами нужен интернет." }); return; }
    const generation = epoch, id = ++sequence, controller = new AbortController(); requests.add(controller);
    publish({ loading: true, error: null });
    try {
      const snapshot = await transport.get(owner, controller.signal);
      if (valid(generation) && id === sequence) {
        if (snapshot.ownerPublicId !== owner) throw new ApiError("Аккаунт изменился. Обновите страницу.", 502);
        publish({ snapshot, loading: false });
      }
    } catch (error) {
      if (valid(generation) && id === sequence) publish({ snapshot: null, loading: false, error: message(error) });
    } finally { requests.delete(controller); }
  }
  async function execute(command: DevBotCommand): Promise<DevBotResult | null> {
    if (!active || view.busy || !owner || command.ownerPublicId !== owner) return null;
    if (!available()) { publish({ error: "Для управления ботами нужен интернет." }); return null; }
    const generation = epoch, controller = new AbortController(); requests.add(controller); ++sequence;
    save(command); publish({ busy: true, loading: false, error: null, notice: "" });
    try {
      const result = await transport.send(command, controller.signal);
      if (!valid(generation)) return null;
      if (result.snapshot.ownerPublicId !== owner || command.action !== "create" && result.botId !== command.botId)
        throw new ApiError("Ответ относится к другому профилю или боту. Проверьте прежний запрос.", 502);
      save(null); publish({ snapshot: result.snapshot, uncertain: false, notice: result.message });
      return result;
    } catch (error) {
      if (!valid(generation)) return null;
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      if (definitive) save(null);
      publish({ error: message(error), uncertain: !definitive });
      return null;
    } finally {
      requests.delete(controller);
      if (valid(generation)) publish({ busy: false });
    }
  }
  return {
    getSnapshot: () => view, getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      active = true; ++epoch; restore(); publish({ uncertain: Boolean(pending) }); void refresh();
      return () => { active = false; ++epoch; ++sequence; for (const request of requests) request.abort(); requests.clear(); publish({ snapshot: null, busy: false, loading: false }); };
    },
    refresh,
    command(action: DevBotAction): Promise<DevBotResult | null> {
      if (!owner || !active || !view.snapshot || view.loading || view.busy || pending) return Promise.resolve(null);
      const parsed = devBotCommandSchema.safeParse({ ...action, ownerPublicId: owner, requestId: createUuidV4() });
      if (!parsed.success) { publish({ error: "Проверьте параметры команды для бота." }); return Promise.resolve(null); }
      return execute(parsed.data);
    },
    retry: () => pending ? execute(pending) : Promise.resolve(null),
  };
}
