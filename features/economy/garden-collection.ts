import type { EconomyCommand, EconomyJob, EconomyView } from "./model";
import type { EconomySceneGarden, GardenHarvestEvent, GardenHarvestRequest } from "@/features/world/economy-garden-state";
import { economyActorConflict } from "./actor-availability";

export function isBerryProduction(job: EconomyJob) {
  return job.kind === "production" && job.targetId === "garden" && (job.rewards.berries ?? 0) > 0;
}

export function economyGardenCrop(snapshot: EconomyView | null, preferredJobId?: string | null): EconomySceneGarden | null | undefined {
  if (!snapshot) return undefined;
  const jobs = snapshot.jobs.filter(isBerryProduction);
  const job = jobs.find(item => item.id === preferredJobId) ?? jobs.find(item => item.collection?.startedAt) ?? jobs[0];
  return job ? { jobId: job.id, startedAt: job.startedAt, finishesAt: job.finishesAt,
    collection: job.collection ?? undefined } : null;
}

type Input = { snapshot: EconomyView | null; now: number; busy: boolean; uncertain: boolean; retryAt: number; error?: string | null; sceneAvailable: boolean };
type Act = (action: EconomyCommand["action"], targetId: string) => void;
// A forest session can outlive a UI controller for the same account. Its event
// channels require monotonic IDs even after the controller is recreated.
let requestSequence = 0;
export type GardenCollectionView = {
  jobId: string | null;
  phase: "idle" | "starting" | "walking" | "waiting" | "paused" | "claiming" | "claim-ready";
  request: GardenHarvestRequest | null;
};

/** Presentation waits for the basket deposit; inventory changes only through the
 * ordinary server command/receipt. Reloads can finish an already accepted task. */
export function createGardenCollectionController(expectedOwner?: string | null) {
  let view: GardenCollectionView = { jobId: null, phase: "idle", request: null };
  let input: Input | null = null, act: Act = () => {}, sawBusy = false;
  let owner = expectedOwner, active = true;
  let requestedAt = 0, acknowledged = false;
  const listeners = new Set<() => void>();
  const publish = (next: GardenCollectionView) => { view = next; listeners.forEach(listener => listener()); };
  const clear = () => { if (view.jobId) publish({ jobId: null, phase: "idle", request: null }); sawBusy = false; acknowledged = false; };
  const locked = () => !active || !input?.snapshot || input.busy || input.uncertain || input.retryAt > input.now;
  function walk(jobId: string) {
    requestedAt = input!.now; acknowledged = false;
    publish({ jobId, phase: "walking", request: { jobId, requestId: ++requestSequence } });
  }
  function claim(job: EconomyJob) {
    if (!input || locked() || Date.parse(job.collection?.finishesAt ?? "") > input.now) return;
    const total = Object.values(job.rewards).reduce((sum, amount) => sum + amount, 0);
    if (total > input.snapshot!.storage.available) {
      if (view.phase !== "claim-ready") publish({ ...view, phase: "claim-ready", request: null });
      return;
    }
    sawBusy = false;
    publish({ jobId: job.id, phase: "claiming", request: view.request });
    act("claim_job", job.id);
  }
  function reconcile() {
    if (!input?.snapshot) return;
    const job = input.snapshot.jobs.find(item => item.id === view.jobId)
      ?? (!view.jobId ? input.snapshot.jobs.find(item => isBerryProduction(item) && item.collection?.startedAt) : undefined);
    if (!job) { clear(); return; }
    if (input.busy) { sawBusy = true; return; }
    if (input.uncertain) return;
    if (view.phase === "starting") {
      if (job.collection?.startedAt) {
        sawBusy = false;
        if (input.sceneAvailable) walk(job.id);
        else publish({ jobId: job.id, phase: "waiting", request: null });
      } else if (sawBusy || input.error) { clear(); return; }
      else return;
    } else if (view.phase === "claiming") {
      if (sawBusy || input.error) publish({ ...view, phase: "claim-ready", request: null });
      return;
    } else if (!view.jobId && job.collection?.startedAt) {
      publish({ jobId: job.id, phase: "waiting", request: null });
    }
    if (["walking", "paused"].includes(view.phase) && !input.sceneAvailable) publish({ ...view, phase: "waiting", request: null });
    // Asset/loading failure may prevent a canvas from acknowledging a request.
    // Once accepted, even a long walk retains its real deposit callback.
    if (view.phase === "walking" && !acknowledged && input.now - requestedAt >= 15_000)
      publish({ ...view, phase: "waiting", request: null });
    if (view.phase === "waiting" && job.collection?.finishesAt && input.now >= Date.parse(job.collection.finishesAt)) claim(job);
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    update(next: Input, command: Act) {
      active = true; input = next; act = command;
      if (!next.snapshot) { clear(); return; }
      if (owner === undefined) owner = next.snapshot.ownerPublicId;
      if (owner !== next.snapshot.ownerPublicId) { clear(); active = false; input = null; return; }
      reconcile();
    },
    deactivate() { active = false; },
    start(jobId: string) {
      if (!input?.snapshot || locked()) return false;
      const job = input.snapshot.jobs.find(item => item.id === jobId && isBerryProduction(item));
      if (!job || Date.parse(job.finishesAt) > input.now || ["starting", "walking", "waiting", "claiming"].includes(view.phase)) return false;
      if (Object.values(job.rewards).reduce((total, amount) => total + amount, 0) > input.snapshot.storage.available) return false;
      if (input.snapshot.jobs.some(item => item.id !== job.id && item.collection?.startedAt)) return false;
      if (job.collection?.startedAt) {
        if (view.phase === "paused" && input.sceneAvailable) {
          walk(jobId);
        } else { publish({ jobId, phase: "waiting", request: null }); reconcile(); }
      } else {
        if (economyActorConflict(input.snapshot.jobs.filter(item => item.id !== job.id), "collection", input.now)) return false;
        sawBusy = false; publish({ jobId, phase: "starting", request: null }); act("start_collection", jobId);
      }
      return true;
    },
    sceneEvent(event: GardenHarvestEvent) {
      if (!active) return;
      if (!view.request || event.jobId !== view.request.jobId || event.requestId !== view.request.requestId || view.phase !== "walking") return;
      if (event.status === "started") { acknowledged = true; return; }
      publish({ ...view, phase: event.status === "interrupted" ? "paused" : "waiting",
        request: event.status === "completed" ? view.request : null });
      reconcile();
    },
  };
}

export function berryCollectionStatus(job: EconomyJob, snapshot: EconomyView, now: number, collection: GardenCollectionView | null) {
  if (!isBerryProduction(job)) return null;
  const growing = now < Date.parse(job.finishesAt), started = Boolean(job.collection?.startedAt);
  const phase = collection?.jobId === job.id ? collection.phase : "idle";
  const collecting = ["starting", "walking", "waiting", "claiming"].includes(phase)
    || started && phase === "idle" && now < Date.parse(job.collection!.finishesAt!);
  const conflict = !started ? economyActorConflict(snapshot.jobs.filter(item => item.id !== job.id), "collection", now) : null;
  const away = Boolean(conflict);
  const label = phase === "claiming" ? "Урожай отправляется в кладовую" : collecting ? "Мохлик собирает урожай"
    : growing ? "Ягоды растут" : phase === "paused" ? "Сбор приостановлен" : started ? "Урожай собран" : "Ягоды созрели";
  return { growing, started, collecting, away, awayReason: conflict?.message ?? null, label,
    button: growing ? "Растут" : collecting ? "Собирает…" : phase === "paused" ? "Продолжить" : started ? "В кладовую" : "Собрать",
    disabled: growing || collecting || away };
}
