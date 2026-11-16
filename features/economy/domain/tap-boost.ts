import type { EconomyJob, EconomyState, EconomyView } from "./model";
import { emptyTapBoost, tapBoostPowerBps, TAP_BOOST_MAX_CHARGE, TAP_BOOST_MAX_SECONDS, TAP_BOOST_SECONDS_PER_TAP } from "./tap-boost-model";

function eligible(job: EconomyJob): boolean {
  return job.kind === "production" || job.kind === "exploration" && job.actorId === "miner";
}

/** Applies only work earned since the last settlement. Calling it twice is harmless.
 * Both ends move together: a mining batch retains its unit work and earned units. */
export function settleEconomyTapBoost(state: EconomyState, now: number): boolean {
  const boost = state.tapBoost;
  if (!boost?.jobId || !boost.appliedAt || !boost.expiresAt || boost.powerBps <= 0) return false;
  const job = state.jobs.find(candidate => candidate.id === boost.jobId && eligible(candidate));
  const end = Math.min(now, Date.parse(boost.expiresAt));
  const start = Math.max(Date.parse(boost.appliedAt), job ? Date.parse(job.startedAt) : 0);
  if (!job || end <= start) return false;
  const finish = Date.parse(job.finishesAt);
  if (finish <= start) return false;
  const elapsed = Math.min(end - start, (finish - start) * 10_000 / (10_000 + boost.powerBps));
  const savedMs = Math.floor(elapsed * boost.powerBps / 10_000);
  if (savedMs > 0) {
    job.startedAt = new Date(Date.parse(job.startedAt) - savedMs).toISOString();
    job.finishesAt = new Date(finish - savedMs).toISOString();
  }
  state.tapBoost = { ...boost, appliedAt: new Date(end).toISOString() };
  return true;
}

/** Only accepted game batches call this. Old/offline taps receive no retrospective work. */
export function creditEconomyTapBoost(state: EconomyState, acceptedTaps: number, now: number): boolean {
  if (!Number.isSafeInteger(acceptedTaps) || acceptedTaps <= 0) return false;
  const settled = settleEconomyTapBoost(state, now);
  const previous = state.tapBoost ?? emptyTapBoost();
  const previousActive = previous.expiresAt !== null && Date.parse(previous.expiresAt) > now;
  const previousJob = previousActive ? state.jobs.find(job => job.id === previous.jobId && eligible(job) && Date.parse(job.finishesAt) > now) : undefined;
  const job = previousJob ?? [...state.jobs].filter(candidate => eligible(candidate) && Date.parse(candidate.finishesAt) > now)
    .sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt) || left.id.localeCompare(right.id))[0];
  if (!job) return settled;
  const continuing = previousJob !== undefined;
  const charge = Math.min(TAP_BOOST_MAX_CHARGE, (continuing ? previous.charge : 0) + acceptedTaps);
  const remainingMs = continuing ? Math.max(0, Date.parse(previous.expiresAt!) - now) : 0;
  const durationMs = Math.min(TAP_BOOST_MAX_SECONDS * 1000, remainingMs + acceptedTaps * TAP_BOOST_SECONDS_PER_TAP * 1000);
  state.tapBoost = { charge, powerBps: tapBoostPowerBps(charge), grantedAt: new Date(now).toISOString(),
    appliedAt: new Date(now).toISOString(), expiresAt: new Date(now + durationMs).toISOString(), jobId: job.id };
  return true;
}

/** Read-only clock projection. Persistence settles the original state before each write. */
export function projectEconomyTapBoost<T extends EconomyState>(state: T, now: number): T {
  if (!state.tapBoost?.jobId) return state;
  const projected = { ...state, jobs: state.jobs.map(job => ({ ...job })), tapBoost: { ...state.tapBoost } };
  settleEconomyTapBoost(projected, now);
  return projected;
}

export function tapBoostView(state: EconomyView, now: number) {
  const boost = state.tapBoost ?? emptyTapBoost();
  const job = state.jobs.find(candidate => candidate.id === boost.jobId);
  const active = Boolean(job && boost.expiresAt && Date.parse(boost.expiresAt) > now && Date.parse(job.finishesAt) > now);
  const targetName = job ? job.actorId === "miner" ? "Каменоломня"
    : state.catalog.buildings.find(building => building.id === job.targetId)?.name ?? "Производство" : "Производство";
  return { active, targetName, powerPercent: active ? boost.powerBps / 100 : 0,
    remainingSeconds: active ? Math.ceil((Date.parse(boost.expiresAt!) - now) / 1000) : 0,
    charge: active ? boost.charge : 0, maxPowerPercent: 20, maxSeconds: TAP_BOOST_MAX_SECONDS };
}
