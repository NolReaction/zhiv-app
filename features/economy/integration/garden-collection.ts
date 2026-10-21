import type { EconomyCommand, EconomyJob, EconomyView } from "@/features/economy/domain/model";
import type { EconomySceneGarden, EconomySceneGardenOrder, GardenHarvestEvent, GardenHarvestRequest } from "@/features/world/state/economy/economy-garden-state";
import { economyActorConflict } from "@/features/economy/domain/actor-availability";
import { GARDEN_BERRY_ITEM_IDS, hasGardenBerryReward } from "@/features/economy/domain/garden-berries";

export function isBerryProduction(job: EconomyJob) {
  return job.kind === "production" && job.targetId === "garden"
    && hasGardenBerryReward(job.rewards);
}

function gardenOrder(job: EconomyJob): EconomySceneGardenOrder {
  return { jobId: job.id, itemId: GARDEN_BERRY_ITEM_IDS.find(id => (job.rewards[id] ?? 0) > 0),
    startedAt: job.startedAt, finishesAt: job.finishesAt, collection: job.collection ?? undefined };
}

export function economyGardenCrop(snapshot: EconomyView | null, preferredJobId?: string | null): EconomySceneGarden | null | undefined {
  if (!snapshot) return undefined;
  // Several beds may grow together. The one being gathered owns the actor;
  // otherwise show the earliest crop so a later order cannot hide ripe berries.
  const jobs = snapshot.jobs.filter(isBerryProduction)
    .sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt) || left.id.localeCompare(right.id));
  const job = jobs.find(item => item.id === preferredJobId) ?? jobs.find(item => item.collection?.startedAt) ?? jobs[0];
  if (!job) return null;
  // Ordinary stations have three slots. Retain a bounded set of historical paid
  // jobs too, always including a requested harvest even beyond the visible slots.
  const visibleJobs = jobs.slice(0, 32);
  if (!visibleJobs.includes(job)) visibleJobs[visibleJobs.length - 1] = job;
  return { ...gardenOrder(job), orders: visibleJobs.map(gardenOrder) };
}

/** All ripe, unstarted berries are one harvest; later ripening work stays outside. */
function hasHarvestStage(snapshot: EconomyView, job: EconomyJob) {
  return Boolean(job.collection ?? snapshot.catalog?.recipes.find(recipe => recipe.id === job.recipeId)?.collection);
}
export function readyGardenHarvest(snapshot: EconomyView, now: number) {
  return snapshot.jobs.filter(job => isBerryProduction(job) && hasHarvestStage(snapshot, job) && !job.collection?.startedAt && Date.parse(job.finishesAt) <= now);
}

function harvestMembers(snapshot: EconomyView, job: EconomyJob) {
  const batchId = job.collection?.batchId;
  return batchId ? snapshot.jobs.filter(item => isBerryProduction(item) && item.collection?.batchId === batchId) : [job];
}
const harvestSize = (jobs: EconomyJob[]) => jobs.reduce((total, job) => total + Object.values(job.rewards).reduce((sum, amount) => sum + amount, 0), 0);

type Input = { snapshot: EconomyView | null; now: number; busy: boolean; uncertain: boolean; retryAt: number; error?: string | null; sceneAvailable: boolean };
type Act = (action: EconomyCommand["action"], targetId: string) => boolean | void;
// A forest session can outlive a UI controller for the same account. Its event
// channels require monotonic IDs even after the controller is recreated.
let requestSequence = 0;
export type GardenCollectionView = {
  jobId: string | null;
  jobIds: string[];
  phase: "idle" | "starting" | "walking" | "waiting" | "paused" | "claiming" | "claim-ready";
  request: GardenHarvestRequest | null;
};

/** Presentation waits for one basket deposit. A saved accepted batch survives a
 * full reload and uses the same server deadline, independently of scene events. */
export function createGardenCollectionController(expectedOwner?: string | null) {
  let view: GardenCollectionView = { jobId: null, jobIds: [], phase: "idle", request: null };
  let input: Input | null = null, act: Act = () => false, recoverPending: (() => boolean) | undefined, sawBusy = false;
  let owner = expectedOwner, active = true, recoveredReceipt = false;
  let requestedAt = 0, acknowledged = false;
  const listeners = new Set<() => void>();
  const publish = (next: GardenCollectionView) => { view = next; listeners.forEach(listener => listener()); };
  const clear = () => { if (view.jobId) publish({ jobId: null, jobIds: [], phase: "idle", request: null }); sawBusy = false; acknowledged = false; };
  const locked = () => !active || !input?.snapshot || input.busy || input.uncertain || input.retryAt > input.now;
  const orderedMembers = (job: EconomyJob) => [job, ...harvestMembers(input!.snapshot!, job).filter(item => item.id !== job.id)];
  function recoverReceipt() {
    if (!input || input.busy) return;
    if (!input.uncertain) { recoveredReceipt = false; return; }
    // Only the session knows the persisted command. It retries the exact receipt
    // for a garden action, never a fresh write or an unrelated market operation.
    if (!recoveredReceipt && input.retryAt <= input.now && recoverPending?.()) recoveredReceipt = true;
  }
  function walk(job: EconomyJob) {
    requestedAt = input!.now; acknowledged = false;
    const jobIds = orderedMembers(job).map(item => item.id);
    publish({ jobId: job.id, jobIds, phase: "walking", request: { jobId: job.id, jobIds, requestId: ++requestSequence } });
  }
  function claim(job: EconomyJob) {
    if (!input || locked()) return false;
    const members = orderedMembers(job);
    if (members.some(item => !item.collection?.finishesAt || Date.parse(item.collection.finishesAt) > input!.now)) return false;
    if (harvestSize(members) > input.snapshot!.storage.available) {
      if (view.phase !== "claim-ready") publish({ ...view, phase: "claim-ready", request: null });
      return false;
    }
    sawBusy = false;
    publish({ jobId: job.id, jobIds: members.map(item => item.id), phase: "claiming", request: view.request });
    const accepted = act(job.collection?.batchId ? "claim_garden_collection" : "claim_job", job.collection?.batchId ?? job.id);
    if (accepted === false) publish({ ...view, phase: "claim-ready", request: null });
    return accepted !== false;
  }
  function reconcile() {
    recoverReceipt();
    if (!input?.snapshot) return;
    const job = input.snapshot.jobs.find(item => item.id === view.jobId)
      ?? input.snapshot.jobs.find(item => view.jobIds.includes(item.id) && item.collection?.startedAt)
      ?? (!view.jobId ? input.snapshot.jobs.find(item => isBerryProduction(item) && item.collection?.startedAt) : undefined);
    if (!job) { clear(); return; }
    if (input.busy) { sawBusy = true; return; }
    if (input.uncertain) return;
    if (view.phase === "starting") {
      if (job.collection?.startedAt) {
        sawBusy = false;
        if (input.sceneAvailable) walk(job);
        else publish({ jobId: job.id, jobIds: orderedMembers(job).map(item => item.id), phase: "waiting", request: null });
      } else if (sawBusy || input.error) { clear(); return; }
      else return;
    } else if (view.phase === "claiming") {
      if (sawBusy || input.error) publish({ ...view, phase: "claim-ready", request: null });
      return;
    } else if (!view.jobId && job.collection?.startedAt) {
      publish({ jobId: job.id, jobIds: orderedMembers(job).map(item => item.id), phase: "waiting", request: null });
    }
    if (["walking", "paused"].includes(view.phase) && !input.sceneAvailable) publish({ ...view, phase: "waiting", request: null });
    // Asset/loading failure may prevent a canvas from acknowledging a request.
    // An acknowledged walk retains its real deposit callback in this session.
    if (view.phase === "walking" && !acknowledged && input.now - requestedAt >= 15_000)
      publish({ ...view, phase: "waiting", request: null });
    if (view.phase === "waiting" && job.collection?.finishesAt && input.now >= Date.parse(job.collection.finishesAt)) claim(job);
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    update(next: Input, command: Act, retryPending?: () => boolean) {
      active = true; input = next; act = command; recoverPending = retryPending;
      if (owner === null) { clear(); active = false; input = null; return; }
      if (next.snapshot && owner === undefined) owner = next.snapshot.ownerPublicId;
      if (next.snapshot && owner !== next.snapshot.ownerPublicId) { clear(); active = false; input = null; return; }
      if (!next.snapshot) { recoverReceipt(); clear(); return; }
      reconcile();
    },
    deactivate() { active = false; },
    start(jobId: string) {
      if (!input?.snapshot || locked()) return false;
      const job = input.snapshot.jobs.find(item => item.id === jobId && isBerryProduction(item));
      if (!job || !hasHarvestStage(input.snapshot, job) || Date.parse(job.finishesAt) > input.now || ["starting", "walking", "waiting", "claiming"].includes(view.phase)) return false;
      const members = job.collection?.startedAt ? harvestMembers(input.snapshot, job) : readyGardenHarvest(input.snapshot, input.now);
      if (harvestSize(members) > input.snapshot.storage.available) return false;
      if (input.snapshot.jobs.some(item => !members.some(member => member.id === item.id) && item.collection?.startedAt)) return false;
      if (job.collection?.startedAt) {
        if (view.phase === "paused" && input.sceneAvailable) walk(job);
        else { publish({ jobId, jobIds: orderedMembers(job).map(item => item.id), phase: "waiting", request: null }); reconcile(); }
      } else {
        if (economyActorConflict(input.snapshot.jobs.filter(item => !members.some(member => member.id === item.id)), "collection", input.now)) return false;
        sawBusy = false;
        publish({ jobId, jobIds: [jobId, ...members.filter(item => item.id !== jobId).map(item => item.id)], phase: "starting", request: null });
        if (act("start_garden_collection", jobId) === false) { clear(); return false; }
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
  if (!isBerryProduction(job) || !hasHarvestStage(snapshot, job)) return null;
  const growing = now < Date.parse(job.finishesAt), started = Boolean(job.collection?.startedAt);
  const selected = collection?.jobId === job.id || collection?.jobIds?.includes(job.id);
  const phase = selected ? collection!.phase : "idle";
  const collecting = ["starting", "walking", "waiting", "claiming"].includes(phase)
    || started && phase === "idle" && now < Date.parse(job.collection!.finishesAt!);
  const members = started ? harvestMembers(snapshot, job) : readyGardenHarvest(snapshot, now);
  const storageShortfall = Math.max(0, harvestSize(members) - snapshot.storage.available);
  const conflict = !started ? economyActorConflict(snapshot.jobs.filter(item => !members.some(member => member.id === item.id)), "collection", now) : null;
  const away = Boolean(conflict);
  const label = phase === "claiming" ? "Урожай отправляется в кладовую" : collecting ? "Мохлик собирает урожай"
    : growing ? "Ягоды растут" : phase === "paused" ? "Сбор приостановлен" : started ? "Урожай собран" : "Ягоды созрели";
  return { growing, started, collecting, away, awayReason: conflict?.message ?? null, label, storageShortfall, rewardCount: harvestSize(members), count: members.length,
    button: growing ? "Растут" : collecting ? "Собирает…" : phase === "paused" ? "Продолжить" : started ? "В кладовую" : members.length > 1 ? `Собрать всё (${members.length})` : "Собрать",
    disabled: growing || collecting || away || storageShortfall > 0 };
}
