import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { gameRewardClaimSchema, type GameRewardClaim, type GameRewardResult, type GameRewards } from "./game-rewards-api";
import type { GameAchievementId } from "./game-api";

type Transport = { get: (signal: AbortSignal) => Promise<GameRewards>; send: (body: GameRewardClaim, signal: AbortSignal) => Promise<GameRewardResult> };
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type View = { data: GameRewards | null; loading: boolean; busy: boolean; uncertain: boolean; pending: GameRewardClaim | null;
  error: string; result: GameRewardResult | null; retryAt: number; readVersion: number };

/** One pending receipt per account is shared by daily and achievement claim controls. */
export function createGameRewardsSession(owner: string | null, transport: Transport, storage?: StoragePort) {
  let view: View = { data: null, loading: false, busy: false, uncertain: false, pending: null, error: "", result: null, retryAt: 0, readVersion: 0 };
  let subscribers = 0, epoch = 0, sequence = 0, read: Promise<void> | null = null;
  let serverClock = Date.now(), localClock = performance.now();
  const key = `zhiv:game-rewards:pending:v1:${owner}`;
  const listeners = new Set<() => void>(), authListeners = new Map<() => void, number>(), requests = new Set<AbortController>();
  const publish = (patch: Partial<View>) => { view = { ...view, ...patch }; listeners.forEach(listener => listener()); };
  const valid = (generation: number) => subscribers > 0 && generation === epoch;
  const now = () => serverClock + performance.now() - localClock;
  const lost = () => authListeners.forEach((_, listener) => listener());
  function remember(pending: GameRewardClaim | null) {
    try { if (pending) storage?.setItem(key, JSON.stringify(pending)); else storage?.removeItem(key); } catch { /* The exact receipt remains in memory. */ }
    publish({ pending });
  }
  function restore() {
    if (!owner || view.pending) return;
    try {
      const raw = storage?.getItem(key);
      if (!raw) return;
      const parsed = gameRewardClaimSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.ownerPublicId === owner) publish({ pending: parsed.data, uncertain: true,
        error: "Остался неподтверждённый запрос. Проверьте получение награды." });
      else storage?.removeItem(key);
    } catch { /* Invalid local data cannot manufacture a claim. */ }
  }
  function adopt(data: GameRewards) {
    if (data.ownerPublicId !== owner) { lost(); throw new ApiError("Сеанс аккаунта изменился", 502); }
    if (view.data && Date.parse(data.serverTime) < Date.parse(view.data.serverTime)) return;
    serverClock = Date.parse(data.serverTime); localClock = performance.now();
    publish({ data, readVersion: view.readVersion + 1 });
  }
  function refresh(): Promise<void> {
    if (!subscribers || !owner || view.busy || now() < view.retryAt) return Promise.resolve();
    if (read) return read;
    const generation = epoch, stamp = ++sequence, controller = new AbortController();
    requests.add(controller); publish({ loading: true });
    const task = (async () => {
      try {
        const data = await transport.get(controller.signal);
        if (valid(generation) && stamp === sequence) { adopt(data); if (!view.pending) publish({ error: "", retryAt: 0 }); }
      } catch (cause) {
        if (valid(generation) && stamp === sequence) {
          if (cause instanceof ApiError && cause.status === 401) lost();
          if (!view.pending) publish({ error: cause instanceof ApiError ? cause.message : "Не удалось обновить награды. Проверьте подключение.",
            ...(cause instanceof ApiError && cause.status === 429 ? { retryAt: now() + Math.max(1000, cause.retryAfterMs ?? 60_000) } : {}) });
        }
      } finally {
        requests.delete(controller);
        if (valid(generation) && stamp === sequence) publish({ loading: false });
      }
    })();
    read = task; void task.finally(() => { if (read === task) read = null; }); return task;
  }
  async function execute(body: GameRewardClaim): Promise<GameRewardResult | undefined> {
    if (!subscribers || view.busy || body.ownerPublicId !== owner || now() < view.retryAt) return;
    const generation = epoch, controller = new AbortController();
    requests.add(controller); ++sequence; read = null; remember(body);
    publish({ loading: false, busy: true, error: "", result: null });
    try {
      const result = await transport.send(body, controller.signal);
      if (!valid(generation)) return;
      const matching = result.requestId === body.requestId && result.rewards.ownerPublicId === owner && result.economy.ownerPublicId === owner
        && result.claim.kind === body.kind && (body.kind === "daily" || result.claim.kind === "achievement"
          && result.claim.achievementId === body.achievementId && result.claim.level === body.level);
      if (!matching) throw new ApiError("Ответ о награде не совпал с запросом. Проверьте его ещё раз.", 502);
      adopt(result.rewards); remember(null); publish({ uncertain: false, result, retryAt: 0 }); return result;
    } catch (cause) {
      if (!valid(generation)) return;
      const definitive = cause instanceof ApiError && cause.status < 500 && ![408, 429].includes(cause.status);
      if (definitive) remember(null);
      publish({ uncertain: !definitive, error: cause instanceof ApiError ? cause.message : "Ответ не пришёл. Проверка повторит тот же запрос без повторной выдачи.",
        ...(cause instanceof ApiError && cause.status === 429 ? { retryAt: now() + Math.max(1000, cause.retryAfterMs ?? 60_000) } : {}) });
      if (cause instanceof ApiError && cause.status === 401) lost();
      else if (definitive) {
        const data = await transport.get(controller.signal).catch(() => null);
        if (valid(generation) && data) { try { adopt(data); } catch { /* Keep the explicit error. */ } }
      }
    } finally { requests.delete(controller); if (valid(generation)) publish({ busy: false }); }
  }
  return {
    getSnapshot: () => view, now,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onSessionLost: (listener: () => void) => {
      authListeners.set(listener, (authListeners.get(listener) ?? 0) + 1);
      return () => { const count = authListeners.get(listener) ?? 0; if (count <= 1) authListeners.delete(listener); else authListeners.set(listener, count - 1); };
    },
    activate: () => {
      if (subscribers++ === 0) { ++epoch; restore(); }
      return () => { if (--subscribers === 0) { ++epoch; requests.forEach(request => request.abort()); requests.clear(); read = null;
        publish({ loading: false, busy: false, uncertain: Boolean(view.pending) }); } };
    },
    refresh,
    claimDaily: () => owner && view.data?.daily.claimable && !view.pending ? execute({ requestId: createUuidV4(), ownerPublicId: owner, kind: "daily" }) : Promise.resolve(undefined),
    claimAchievement: (achievementId: GameAchievementId, level: number) => owner && !view.pending
      && view.data?.achievementRewards.some(row => row.achievementId === achievementId && row.level === level && row.eligible)
      ? execute({ requestId: createUuidV4(), ownerPublicId: owner, kind: "achievement", achievementId, level }) : Promise.resolve(undefined),
    retry: () => view.pending ? execute(view.pending) : refresh().then(() => undefined),
  };
}
