import { z } from "zod";
import type {
  ApiErrorResponse,
  CheckInResponse,
  CooldownResponse,
  MeResponse,
} from "@/lib/check-in-contract";

const userSchema = z.object({
  publicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  displayName: z.string().min(1).max(50),
});

const meSchema: z.ZodType<MeResponse> = z.object({
  user: userSchema,
  lastCheckInAt: z.string().datetime().nullable(),
  serverTime: z.string().datetime(),
});

const checkInSchema: z.ZodType<CheckInResponse> = z.object({
  eventId: z.string().uuid(),
  checkedAt: z.string().datetime(),
  serverTime: z.string().datetime(),
  nextAllowedAt: z.string().datetime(),
  replayed: z.boolean(),
});

const cooldownSchema: z.ZodType<CooldownResponse> = z.object({
  code: z.literal("CHECK_IN_COOLDOWN"),
  checkedAt: z.string().datetime(),
  serverTime: z.string().datetime(),
  nextAllowedAt: z.string().datetime(),
});

const errorSchema: z.ZodType<ApiErrorResponse> = z.object({
  code: z.string(),
  message: z.string(),
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: ApiErrorResponse | CooldownResponse,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    signal: init?.signal ?? AbortSignal.timeout(8_000),
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => undefined)
    : undefined;

  if (!response.ok) {
    const knownError = cooldownSchema.safeParse(body).success
      ? cooldownSchema.parse(body)
      : errorSchema.safeParse(body).success
        ? errorSchema.parse(body)
        : undefined;
    const message =
      knownError && "message" in knownError
        ? knownError.message
        : "Не удалось связаться с сервером";
    throw new ApiError(message, response.status, knownError);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Сервер вернул некорректный ответ", 502);
  }
  return parsed.data;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>("/api/v1/me", meSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function bootstrap(displayName: string, idempotencyKey: string): Promise<MeResponse> {
  return request<MeResponse>("/api/v1/bootstrap", meSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ displayName }),
  });
}

export function createCheckIn(idempotencyKey: string): Promise<CheckInResponse> {
  return request<CheckInResponse>("/api/v1/check-ins", checkInSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}
