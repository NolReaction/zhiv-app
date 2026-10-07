import { hasUserTextControls } from "@/lib/user-text";

/** Reasons become an immutable audit record; disallow invisible reordering. */
export function validAdminReason(value: string): boolean {
  const reason = value.trim();
  return reason.length >= 8 && reason.length <= 240 && !hasUserTextControls(value);
}
