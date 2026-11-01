import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { worldJobProgress } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-cookbook.module.css";

export function CookbookPot({ economy }: { economy: ReadyEconomy }) {
  const state = economy.snapshot;
  const cooking = state.jobs.some(job => job.kind === "production" && job.targetId === "dryer"
    && !economy.pendingProductionIds?.includes(job.id) && Number.isFinite(Date.parse(job.startedAt))
    && Number.isFinite(Date.parse(job.finishesAt)) && Date.parse(job.startedAt) <= economy.now
    && Date.parse(job.finishesAt) > Date.parse(job.startedAt) && !worldJobProgress(state, job, economy.now).ready);
  return <svg className={styles.pot} viewBox="0 0 100 82" fill="none" aria-hidden="true" data-cookbook-pot={cooking ? "cooking" : "idle"}>
    <g className={styles.steam} stroke="#c8d5b2" strokeWidth="2.5" strokeLinecap="round"><path d="M38 30c-8-8 8-8 0-18" /><path d="M52 25c-8-8 8-8 0-18" /><path d="M66 30c-8-8 8-8 0-18" /></g>
    <path d="m30 73 42-7M30 66l42 7" stroke="#795033" strokeWidth="6" strokeLinecap="round" />
    <path className={styles.fire} d="M43 68c-10-8 2-10 4-20 1 7 7 6 7 13 3-2 4-5 4-8 8 15 2 18-15 15Z" fill="#e2a646" />
    <path d="M25 40h-5v12h9M75 40h5v12h-9" stroke="#84977b" strokeWidth="5" strokeLinejoin="round" />
    <path d="M25 38h50v13c0 12-8 16-25 16s-25-4-25-16V38Z" fill="#324c41" stroke="#99ab85" strokeWidth="2" />
    <ellipse cx="50" cy="38" rx="25" ry="7" fill="#c4974b" stroke="#b4bd8c" strokeWidth="2" />
    <g className={styles.bubbles} fill="#e7c985"><circle cx="39" cy="38" r="2.5" /><circle cx="54" cy="36" r="3" /><circle cx="64" cy="40" r="2" /></g>
    <path className={styles.spoon} d="m59 39 14-22" stroke="#ba8e59" strokeWidth="4" strokeLinecap="round" />
    <path d="M35 49v6" stroke="#80997d" strokeWidth="3" strokeLinecap="round" />
  </svg>;
}
