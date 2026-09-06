import type { UserStatus } from "@/lib/check-in-contract";
import { activeUserStatus, formatStatusUpdatedAt } from "@/lib/user-status";
import styles from "./user-status-display.module.css";

export function UserStatusDisplay({ status, nowMs }: { status?: UserStatus | null; nowMs: number }) {
  const active = activeUserStatus(status, nowMs);
  if (!active) return null;
  return <p className={styles.status}>
    {active.text}
    <time className={styles.updated} dateTime={active.updatedAt} title={new Date(active.updatedAt).toLocaleString("ru-RU")}>
      {formatStatusUpdatedAt(active.updatedAt, nowMs)}
    </time>
  </p>;
}
