import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { retryAfterMs, withRequestDeadline } from "@/lib/request-deadline";
import {
  earthPeopleResponseSchema, earthPositionReceiptSchema, earthPositionStoppedSchema, earthSharingSettingsSchema,
  type EarthPositionStop, type EarthPositionWrite, type EarthSharingWrite,
} from "@/lib/earth-sharing-contract";

const apiErrorSchema = z.object({ code: z.string(), message: z.string() });

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  return withRequestDeadline(8_000, init.signal, async signal => {
    const response = await fetch(path, {
      ...init, signal, cache: "no-store", credentials: "same-origin",
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    const body: unknown = (response.headers.get("content-type") ?? "").includes("application/json")
      ? await response.json().catch(() => undefined) : undefined;
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      throw new ApiError(error.success ? error.data.message : response.status === 429
        ? "Слишком часто. Подождите немного." : "Не удалось обновить доступ к геопозиции", response.status,
      error.success ? error.data : undefined, response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("Сервер вернул некорректные данные карты", 502, undefined, response.headers.get("X-Request-ID"));
    return parsed.data;
  });
}

export function getEarthSharing(signal?: AbortSignal) {
  return request("/api/v1/earth/sharing", earthSharingSettingsSchema, { signal });
}

export function updateEarthSharing(write: EarthSharingWrite, key: string, signal?: AbortSignal) {
  return request("/api/v1/earth/sharing", earthSharingSettingsSchema, {
    method: "PUT", body: JSON.stringify(write), headers: { "Idempotency-Key": key }, signal, keepalive: write.mode !== "SHARING",
  });
}

export function publishEarthPosition(write: EarthPositionWrite, key: string, signal?: AbortSignal) {
  return request("/api/v1/earth/location", earthPositionReceiptSchema, {
    method: "PUT", body: JSON.stringify(write), headers: { "Idempotency-Key": key }, signal,
  });
}

export function stopEarthPublication(write: EarthPositionStop, key: string, signal?: AbortSignal) {
  return request("/api/v1/earth/location", earthPositionStoppedSchema, {
    method: "DELETE", body: JSON.stringify(write), headers: { "Idempotency-Key": key }, signal, keepalive: true,
  });
}

export function getEarthPeople(signal?: AbortSignal) {
  return request("/api/v1/earth/people", earthPeopleResponseSchema, { signal });
}
