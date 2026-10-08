import type { EconomyJob } from "@/features/economy/domain/model";
import styles from "./production-activity.module.css";

export function productionIsActive(job: EconomyJob, now: number) {
  const start = Date.parse(job.startedAt), finish = Date.parse(job.finishesAt);
  return job.kind === "production" && Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(finish)
    && finish > start && now >= start && now < finish;
}

/** A small illustration of work in progress, never a second job clock. */
export function ProductionActivity({ job, now }: { job: EconomyJob; now: number }) {
  if (!productionIsActive(job, now)) return null;
  const station = job.targetId;
  const cooking = station === "dryer";
  return <svg className={styles.scene} viewBox="0 0 64 48" width="56" height="42" aria-hidden="true" focusable="false" data-production-activity={station}>
    <ellipse cx="32" cy="43" rx="25" ry="3" fill="#837a5130" />
    {cooking ? <>
      <g className={styles.steam} fill="none" stroke="#829585" strokeWidth="2" strokeLinecap="round"><path d="M24 16c-5-5 5-6 1-11" /><path d="M34 14c-4-4 5-6 2-11" /><path d="M43 17c-4-4 4-5 2-9" /></g>
      <path d="m20 42 6-9 6 10 6-10 7 9" fill="#d19846" />
      <path d="M17 24h32v9c0 13-32 13-32 0Z" fill="#6e8473" stroke="#394d3e" strokeWidth="2" />
      <path d="M17 26h-5v7h6m31-7h5v7h-6" fill="none" stroke="#394d3e" strokeWidth="2" />
      <ellipse cx="33" cy="24" rx="16" ry="4" fill="#bf9955" stroke="#394d3e" strokeWidth="2" />
      <g className={styles.bubbles} fill="#eed790"><circle cx="26" cy="23" r="2" /><circle cx="37" cy="24" r="2.4" /><circle cx="44" cy="23" r="1.5" /></g>
      <path d="m40 22 9-13" stroke="#876544" strokeWidth="3" strokeLinecap="round" />
      <path d="M23 32v4" stroke="#a6bda2" strokeWidth="2" strokeLinecap="round" />
    </> : station === "garden" ? <>
      <path d="M9 40c10-8 35-8 46 0Z" fill="#9b7850" stroke="#6b5940" strokeWidth="2" />
      <g className={styles.growing}><path d="M32 38V18" stroke="#526c45" strokeWidth="3" /><path d="M32 29C16 31 14 17 17 15c9 0 15 5 15 14Zm0-5C47 25 51 13 48 11c-9 0-16 5-16 13Z" fill="#7e9758" stroke="#526c45" strokeWidth="2" /><circle cx="24" cy="23" r="3" fill="#ad665d" /><circle cx="41" cy="18" r="3" fill="#be7a63" /></g>
      <path d="m14 37 4 1m24 0 6 1" stroke="#c4a471" strokeWidth="2" strokeLinecap="round" />
    </> : station === "kiln" ? <>
      <g className={styles.steam} fill="none" stroke="#9b9b86" strokeWidth="2" strokeLinecap="round"><path d="M31 12c-3-4 4-5 1-9" /><path d="M39 12c-3-4 4-5 2-8" /></g>
      <path d="M16 42V25c0-19 34-19 34 0v17Z" fill="#b9986b" stroke="#735c40" strokeWidth="2" /><path d="M25 42V30c0-11 17-11 17 0v12Z" fill="#4e5441" />
      <path className={styles.flame} d="M28 40c-5-6 2-8 3-15 5 4 2 7 5 8l4-6c6 10 0 17-12 13Z" fill="#d99142" /><path d="M19 24h7m14-5h7M20 34h5m17 0h7" stroke="#80684b" strokeWidth="2" />
    </> : <>
      {station === "quarry" ? <path d="m12 42 5-15 12-8 18 8 7 15Z" fill="#adb4a1" stroke="#667465" strokeWidth="2" /> : <><path d="m12 32 36-5 6 12-37 4Z" fill="#bb9660" stroke="#765b3c" strokeWidth="2" /><path d="m20 37 24-3m-19-3 3 10" stroke="#87693e" strokeWidth="1.5" /></>}
      <g className={styles.tool}><path d="m34 32 12-22" stroke="#8c6946" strokeWidth="4" strokeLinecap="round" />{station === "quarry" ? <path d="M31 12c12-9 23 0 24 7l-13-7-11 3Z" fill="#6b817b" stroke="#40554e" strokeWidth="1.5" /> : station === "woodlot" ? <path d="m44 8 9 5-6 13-8-8Z" fill="#92a393" stroke="#40554e" strokeWidth="2" /> : <path d="m35 7 15 7-4 8-15-7Z" fill="#7e9381" stroke="#40554e" strokeWidth="2" />}</g>
      <g className={styles.chips} stroke="#b59356" strokeWidth="2" strokeLinecap="round"><path d="m23 26-3-3m8 0-1-4m14 9 3-2" /></g>
    </>}
  </svg>;
}
