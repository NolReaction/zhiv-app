import { ApiError } from "@/lib/check-in-api";

const definitiveCodes = new Set([
  "INVALID_ADMIN_GRANT", "INVALID_ADMIN_ADJUSTMENT", "INVALID_ADMIN_DELIVERY", "INVALID_ADMIN_QUERY", "INVALID_ADMIN_MAIL", "INVALID_MAIL_BROADCAST", "INVALID_MAIL_REQUEST",
  "ADMIN_USER_NOT_FOUND", "ADMIN_MAIL_AUDIENCE_LIMIT", "ADMIN_ECONOMY_NOT_INITIALIZED", "ECONOMY_REVISION_CONFLICT",
  "ADMIN_ADJUSTMENT_INSUFFICIENT_BALANCE", "ECONOMY_CAPACITY", "ECONOMY_STORAGE_FULL", "ADMIN_UPGRADE_DOWNGRADE",
  "ADMIN_UPGRADE_BUSY", "ADMIN_UPGRADE_REQUIREMENTS", "ADMIN_RESOURCE_RETIRED", "ADMIN_PROTECTED_ACCOUNT",
]);
/** A bare HTTP 409/400, lock contention or a lost acknowledgement cannot authorize a new UUID. */
export function definitiveAdminWriteFailure(cause: unknown): boolean {
  return cause instanceof ApiError && [400, 404, 409, 422].includes(cause.status)
    && !!cause.body && "code" in cause.body && definitiveCodes.has(cause.body.code);
}
