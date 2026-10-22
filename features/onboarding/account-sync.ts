import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { mergeOnboardingStatus, type OnboardingAccount, type OnboardingCourse, type OnboardingDecision, type OnboardingStatus } from "@/lib/onboarding-contract";

type LocalStore = { getSnapshot(): { loaded: boolean; progress: { status: string } | null }; subscribe(listener: () => void): () => void };
type Options = { owner: string; course: OnboardingCourse; local: LocalStore;
  adopt: (status: OnboardingStatus) => void;
  request: (owner: string, decision?: OnboardingDecision, signal?: AbortSignal) => Promise<OnboardingAccount>;
  storage?: Pick<Storage, "getItem" | "setItem">; now?: () => number };
const replayMemory = new Map<string, boolean>();
const terminal = (status?: string): OnboardingStatus | null => status === "completed" || status === "skipped" ? status : null;

/** Terminal decisions are monotonic account data; in-progress exercises and explicit replay stay on this device. */
export function createOnboardingAccountSync(options: Options) {
  const { owner, course, local, adopt, request, storage } = options;
  const key = gameplayStorageKey(`zhiv.onboarding-replay.v1:${owner}:${course}`);
  let replay = replayMemory.get(key) ?? false;
  if (!replayMemory.has(key)) try { replay = storage?.getItem(key) === "true"; } catch { /* Session memory remains available. */ }
  let snapshot = false, connected = false, controller: AbortController | null = null;
  let account: OnboardingStatus | null = null, loaded = false, notBefore = 0, replayVersion = 0;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const emit = () => {
    const next = replay || loaded;
    if (next === snapshot) return;
    snapshot = next; for (const listener of listeners) listener();
  };
  const setReplay = (value: boolean) => {
    replayVersion++;
    replay = value;
    try { if (!storage) throw new Error("No storage"); storage.setItem(key, String(value)); replayMemory.delete(key); }
    catch { replayMemory.set(key, value); }
    emit();
  };
  const reconcile = () => {
    const status = terminal(local.getSnapshot().progress?.status);
    if (replay && status && loaded && mergeOnboardingStatus(account, status) === account) setReplay(false);
    if (!replay && account && mergeOnboardingStatus(status, account) !== status) adopt(account);
    emit();
  };
  const refresh = async () => {
    if (!connected || controller || !local.getSnapshot().loaded || now() < notBefore) return;
    const operation = new AbortController(); controller = operation;
    const startedReplayVersion = replayVersion;
    try {
      const localStatus = terminal(local.getSnapshot().progress?.status);
      const decision = localStatus && (!loaded || mergeOnboardingStatus(account, localStatus) !== account)
        ? { ownerPublicId: owner, course, status: localStatus } : undefined;
      const response = await request(owner, decision, operation.signal);
      if (!connected || operation.signal.aborted || response.ownerPublicId !== owner) return;
      account = mergeOnboardingStatus(account, response[course]); loaded = true;
      if (decision && replayVersion === startedReplayVersion && terminal(local.getSnapshot().progress?.status)) setReplay(false);
      reconcile();
    } catch (error) {
      if (!operation.signal.aborted) {
        const retry = typeof error === "object" && error !== null && "retryAfterMs" in error ? Number(error.retryAfterMs) : NaN;
        notBefore = now() + Math.max(30_000, Number.isFinite(retry) ? retry : 0);
      }
      // A failed first read does not offer an already completed course as new.
      // Explicit replay remains available; gameplay itself is never blocked.
    } finally {
      if (controller === operation) controller = null;
    }
    const latest = terminal(local.getSnapshot().progress?.status);
    if (connected && loaded && latest && mergeOnboardingStatus(account, latest) !== account && now() >= notBefore) void refresh();
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      connected = true; emit();
      const unsubscribe = local.subscribe(() => { reconcile(); void refresh(); });
      void refresh();
      return () => { connected = false; controller?.abort(); controller = null; unsubscribe(); };
    },
    refresh,
    replay: () => setReplay(true),
  };
}
