import { NextResponse } from "next/server";
import { FOREST_MEMORY_BODY_BYTES } from "@/features/world/forest-memory-model";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { getDevIdentity } from "@/lib/dev/api-store";
import { DevForestMemoryError } from "@/lib/dev/forest-memory-store";

export function forestMemoryError(code = "INVALID_FOREST_MEMORY", status = 400, message = "Не удалось выполнить запрос памяти Мохлика") {
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}

export async function devForestMemoryContext(request: Request, write = false) {
  const rejected = guardDevApi(request, write, FOREST_MEMORY_BODY_BYTES);
  if (rejected) return { response: rejected };
  const token = await devSessionToken();
  if (!getDevIdentity(token)) return { response: forestMemoryError("UNAUTHORIZED", 401) };
  return { token };
}

/** Enforce the byte limit while reading, including absent or false Content-Length. */
export async function readDevForestMemoryBody(request: Request) {
  if (!request.body) return { response: forestMemoryError() };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "", bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > FOREST_MEMORY_BODY_BYTES) {
        await reader.cancel();
        return { response: forestMemoryError("BODY_TOO_LARGE", 413) };
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return { body: JSON.parse(body) as unknown };
  } catch {
    return { response: forestMemoryError() };
  } finally { reader.releaseLock(); }
}

export function devForestMemoryResponse<T>(operation: () => T) {
  try { return NextResponse.json(operation(), { headers: NO_STORE_HEADERS }); }
  catch (error) {
    if (error instanceof DevForestMemoryError) return forestMemoryError(error.code, error.status, error.message);
    throw error;
  }
}
