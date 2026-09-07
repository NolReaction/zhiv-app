import type { UserStatus } from "@/lib/check-in-contract";
import { activeUserStatus, formatStatusUpdatedAt } from "@/lib/user-status";
import styles from "./user-status-display.module.css";

export function UserStatusDisplay({ status, nowMs, inline = false, id }: { id?: string; status?: UserStatus | null; nowMs: number; inline?: boolean }) {
  const active = activeUserStatus(status, nowMs);
  if (!active) return null;
  const Tag = inline ? "span" : "p";
  return <Tag id={id} className={styles.status} data-user-status>
    {active.text}
    <time className={styles.updated} dateTime={active.updatedAt} title={new Date(active.updatedAt).toLocaleString("ru-RU")}>
      {formatStatusUpdatedAt(active.updatedAt, nowMs)}
    </time>
  </Tag>;
}
