function factors(duration: number, foodBps: number, tradeBps: number, work: number | null | undefined, skillBps: number) {
  if (!Number.isSafeInteger(duration) || duration < 0 || !Number.isInteger(foodBps) || foodBps < 0 || foodBps > 10000
    || !Number.isInteger(tradeBps) || tradeBps < 0 || tradeBps > 1000
    || !Number.isInteger(skillBps) || skillBps < 0 || skillBps > 500
    || work != null && (!Number.isSafeInteger(work) || work < 0)) throw new RangeError("Invalid construction meal budget");
  return { duration: BigInt(duration), trade: BigInt(10000 + tradeBps), fed: BigInt(10000 + tradeBps + foodBps), skill: BigInt(10000 + skillBps) };
}

/** One serving covers only its paid baseline work. Missing budgets preserve old servings. */
export function builderWorkDuration(seconds: number, foodBps: number, tradeBps: number, workSeconds?: number | null, skillBps = 0): number {
  const { duration, trade, fed, skill } = factors(seconds, foodBps, tradeBps, workSeconds, skillBps);
  const covered = BigInt(Math.min(seconds, workSeconds ?? seconds));
  const numerator = ((duration - covered) * fed + covered * trade) * BigInt(100_000_000);
  const denominator = trade * fed * skill;
  return Number((numerator + denominator - BigInt(1)) / denominator);
}

/** Add food to remaining wall time using the professional bonuses frozen on the job.
 * Inputs use the same unit (milliseconds at runtime). Floor saved time so a quote
 * never promises a finish before the exact rational result. */
export function fedConstructionDuration(remaining: number, foodBps: number, tradeBps: number, workBudget?: number | null, skillBps = 0): number {
  const { duration, trade, fed, skill } = factors(remaining, foodBps, tradeBps, workBudget, skillBps);
  const remainingWork = duration * trade * skill;
  const budgetWork = workBudget == null ? remainingWork : BigInt(workBudget) * BigInt(100_000_000);
  const covered = budgetWork < remainingWork ? budgetWork : remainingWork;
  const saved = covered * BigInt(foodBps) / (trade * fed * skill);
  return Number(duration - saved);
}

/** Snapshot the covered baseline seconds without floating-point overflow. */
export function builderMealWorkUsed(remainingMs: number, tradeBps: number, skillBps: number, workSeconds: number): number {
  const { duration, trade, skill } = factors(remainingMs, 0, tradeBps, workSeconds, skillBps);
  const denominator = BigInt(100_000_000_000);
  const seconds = (duration * trade * skill + denominator - BigInt(1)) / denominator;
  return Number(seconds < BigInt(workSeconds) ? seconds : BigInt(workSeconds));
}
