import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { worldResultSchema, worldSnapshotSchema, type WorldCommand } from "./model";

async function request<T>(path: string, schema: z.ZodType<T>, command?: WorldCommand, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 8000);
  try {
    const response = await fetch(path, {
      method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(body);
      throw new ApiError(error.success ? error.data.message : "Не удалось связаться с миром", response.status, error.success ? error.data : undefined);
    }
    const result = schema.safeParse(body);
    if (!result.success) throw new ApiError("Обновите приложение: мир получил новую версию", 502);
    return result.data;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
export const getWorld = (signal?: AbortSignal) => request("/api/v1/world", worldSnapshotSchema, undefined, signal);
export const sendWorldCommand = (command: WorldCommand, signal?: AbortSignal) => request("/api/v1/world/commands", worldResultSchema, command, signal);
