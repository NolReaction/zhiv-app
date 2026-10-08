import { Check, Fish, Hammer, Mountain, Trees } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { activityStatus, activityTime, type WorldActivity } from "./world-activity";
import styles from "./world-activity-badge.module.css";

/** Decorative overlay: the surrounding check-in button retains its original action. */
export function WorldActivityBadge({ activity }: { activity: WorldActivity }) {
  const Icon = activity.kind === "fishing" ? Fish : activity.kind === "cave" ? Mountain : activity.kind === "production" ? Hammer : Trees;
  const compactStatus = activity.collectionPhase === "harvesting" ? "Сбор ягод" : activity.ready ? "Готово" : activityTime(activity.remainingSeconds);
  return <span className={styles.badge} data-world-activity={activity.kind} data-collection-phase={activity.collectionPhase} data-ready={activity.ready || undefined}>
    <span className={styles.dial}>
      <svg className={styles.ring} viewBox="0 0 52 52" aria-hidden="true" focusable="false">
        <circle className={styles.track} cx="26" cy="26" r="23" />
        <circle className={styles.fill} cx="26" cy="26" r="23" pathLength="100" strokeDasharray="100" strokeDashoffset={(1 - activity.progress) * 100} />
      </svg>
      <span className={styles.icon}>{activity.kind === "production" && activity.itemId ? <ItemIcon itemId={activity.itemId} size={28} /> : <Icon size={25} aria-hidden="true" />}</span>
      {activity.ready && <span className={styles.check}><Check size={11} aria-hidden="true" /></span>}
    </span>
    <span className={styles.text}><span>{activity.label}</span><strong><span className={styles.fullStatus}>{activityStatus(activity)}</span><span className={styles.compactStatus}>{compactStatus}</span></strong></span>
  </span>;
}

export function WorldActivityDescription({ activity, id }: { activity: WorldActivity; id: string }) {
  return <span id={id} className={styles.sr} role="progressbar" aria-label={activity.label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={activity.collectionPhase === "harvesting" ? undefined : Math.round(activity.progress * 100)}
    aria-valuetext={activityStatus(activity)}>{activity.label}. {activityStatus(activity)}. {activity.ready ? "Откройте мир, чтобы забрать." : ""}</span>;
}
