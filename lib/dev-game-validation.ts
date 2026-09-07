import { isValidPublicId } from "@/lib/check-in-presentation";
import type { GameBatchRequest, GameSessionRequest, GameVisibilityRequest, GameLeaderboardScope } from "@/lib/game-api";

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function owner(value: unknown): value is string {
  return typeof value === "string" && isValidPublicId(value);
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER - 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function parseDevGameSession(value: unknown): GameSessionRequest | null {
  if (!exact(value, ["requestId", "ownerPublicId"]) || !uuid(value.requestId) || !owner(value.ownerPublicId)) return null;
  return { requestId: value.requestId.toLowerCase(), ownerPublicId: value.ownerPublicId };
}
export function parseDevGameBatch(value: unknown): GameBatchRequest | null {
  if (!exact(value, ["sessionId", "sequence", "tapCount", "runId"]) || !uuid(value.sessionId)
    || !uuid(value.runId) || !integer(value.sequence, 1) || !integer(value.tapCount, 1, 60)) return null;
  return { sessionId: value.sessionId.toLowerCase(), sequence: value.sequence, tapCount: value.tapCount, runId: value.runId.toLowerCase() };
}
export function parseDevGameVisibility(value: unknown): GameVisibilityRequest | null {
  if (!exact(value, ["ownerPublicId", "leaderboardOptIn", "expectedVersion"]) || !owner(value.ownerPublicId)
    || typeof value.leaderboardOptIn !== "boolean" || !integer(value.expectedVersion, 0)) return null;
  return { ownerPublicId: value.ownerPublicId, leaderboardOptIn: value.leaderboardOptIn, expectedVersion: value.expectedVersion };
}

export function parseDevGameScope(searchParams: URLSearchParams): GameLeaderboardScope | null {
  const values = searchParams.getAll("scope");
  if (values.length === 0) return "global";
  return values.length === 1 && (values[0] === "global" || values[0] === "friends") ? values[0] : null;
}
