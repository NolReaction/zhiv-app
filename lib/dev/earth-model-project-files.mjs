import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { parseEarthModelPlacementDocument } from "../earth-model-placement-contract.mjs";

export const EARTH_MODEL_BODY_LIMIT = 32 * 1024;
export const EARTH_MODEL_BODY_TIMEOUT_MS = 10_000;
export const EARTH_MODEL_PENDING_LIMIT = 8;
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (data, status = 200) => Response.json(data, { status, headers });
const revisionOf = source => createHash("sha256").update(source).digest("hex");

export class EarthModelFileConflict extends Error {}
class EarthModelRequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Match the trusted local-network scope of the existing world studio. */
export function earthModelPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255))
    return parts[0] === 127 || parts[0] === 10 || parts[0] === 192 && parts[1] === 168
      || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  return /^f[cd][0-9a-f]{2}:/.test(host);
}

/** Browser origin must match the actual private Host, never forwarded headers.
 * Next's configured listening address can differ from the browser's LAN address. */
export function earthModelRequestAllowed(request, environment = process.env.NODE_ENV) {
  if (environment !== "development") return false;
  let url, authority;
  try {
    url = new URL(request.url);
    const host = request.headers.get("host");
    if (!host || /[\s/@\\?#]/.test(host) || !["http:", "https:"].includes(url.protocol)) return false;
    authority = new URL(`${url.protocol}//${host}`);
    if (authority.host.toLowerCase() !== host.toLowerCase()) return false;
  } catch { return false; }
  if (!earthModelPrivateHost(authority.hostname)) return false;
  if (!earthModelPrivateHost(url.hostname) && url.hostname !== "0.0.0.0" && url.hostname !== "[::]") return false;
  if (authority.port !== url.port) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== authority.origin) return false;
  return request.method !== "POST" || origin === authority.origin;
}

async function readBounded(file) {
  // The authored file must be a regular file, not a symlink to another location.
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > EARTH_MODEL_BODY_LIMIT) throw new Error("Файл размещения моделей слишком большой или повреждён.");
    const source = await descriptor.readFile();
    if (source.byteLength > EARTH_MODEL_BODY_LIMIT) throw new Error("Файл размещения моделей слишком большой.");
    return { source, mode: info.mode };
  } finally { await descriptor.close(); }
}

function saveBody(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join() !== "document,revision"
    || typeof input.revision !== "string" || !/^[0-9a-f]{64}$/.test(input.revision))
    throw new Error("Некорректные параметры сохранения размещения моделей.");
  return { revision: input.revision, document: parseEarthModelPlacementDocument(input.document) };
}

async function requestBody(request, timeoutMs) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > EARTH_MODEL_BODY_LIMIT))
    throw new EarthModelRequestError("Запрос сохранения слишком большой.", 413);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || request.headers.has("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")
    throw new EarthModelRequestError("Ожидается несжатый JSON.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Пустой запрос сохранения.");
  const bytes = Buffer.allocUnsafe(EARTH_MODEL_BODY_LIMIT);
  let size = 0, timeout, abort;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new EarthModelRequestError("Истекло время загрузки сохранения. Повторите запрос.", 408)), timeoutMs);
    abort = () => reject(new EarthModelRequestError("Загрузка сохранения отменена.", 408));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
  const consume = async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (size + result.value.byteLength > EARTH_MODEL_BODY_LIMIT)
        throw new EarthModelRequestError("Запрос сохранения слишком большой.", 413);
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
  };
  try { await Promise.race([consume(), deadline]); }
  catch (error) {
    // A hostile stream's cancel promise must not postpone the deadline response.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  let input;
  try { input = JSON.parse(bytes.toString("utf8", 0, size)); }
  catch { throw new Error("Некорректный JSON сохранения."); }
  return saveBody(input);
}

/** The request can change placement values only; the checkout owns this path. */
export function createEarthModelProjectFiles({ root = process.cwd(), renameFile = rename,
  bodyTimeoutMs = EARTH_MODEL_BODY_TIMEOUT_MS } = {}) {
  const file = path.join(root, "features/earth/data/model-placements.json");
  let queue = Promise.resolve(), pendingRequests = 0;
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const current = async () => {
    const { source } = await readBounded(file);
    const document = parseEarthModelPlacementDocument(JSON.parse(source.toString("utf8")));
    if (!source.equals((await readBounded(file)).source))
      throw new EarthModelFileConflict("Размещение изменилось во время чтения. Загрузите его повторно.");
    return { revision: revisionOf(source), document };
  };
  const save = async input => {
    const body = saveBody(input);
    const before = await readBounded(file);
    if (body.revision !== revisionOf(before.source))
      throw new EarthModelFileConflict("Размещение изменено в другом окне или редакторе. Загрузите актуальную версию перед сохранением.");
    const source = `${JSON.stringify(body.document, null, 2)}\n`;
    if (Buffer.byteLength(source) > EARTH_MODEL_BODY_LIMIT) throw new Error("Файл размещения моделей слишком большой.");
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.earth-tmp`);
    try {
      await writeFile(temporary, source, { flag: "wx", mode: before.mode });
      if (!before.source.equals((await readBounded(file)).source))
        throw new EarthModelFileConflict("Файл изменён в другом редакторе. Сохранение остановлено.");
      await renameFile(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return { revision: revisionOf(source), document: body.document };
  };
  return {
    read: () => serial(current),
    save: body => serial(() => save(body)),
    async handle(request, environment = process.env.NODE_ENV) {
      if (!earthModelRequestAllowed(request, environment))
        return json({ code: "EARTH_MODELS_UNAVAILABLE" }, environment === "development" ? 403 : 404);
      if (request.method !== "GET" && request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (pendingRequests >= EARTH_MODEL_PENDING_LIMIT)
        return Response.json({ code: "EARTH_MODELS_BUSY", message: "Сервер занят. Повторите сохранение." }, {
          status: 429, headers: { ...headers, "Retry-After": "1" },
        });
      pendingRequests++;
      try {
        // Slow uploads do not hold the disk queue or prevent other tabs reading.
        const body = request.method === "POST" ? await requestBody(request, bodyTimeoutMs) : null;
        return json(await serial(() => {
          if (request.signal.aborted) throw new EarthModelRequestError("Запрос отменён.", 408);
          return body ? save(body) : current();
        }));
      } catch (error) {
        const message = typeof error.code === "string" ? "Не удалось прочитать или записать размещение. Проверьте локальный сервер."
          : String(error.message ?? "Не удалось сохранить размещение.").slice(0, 600);
        if (error instanceof EarthModelFileConflict) return json({ code: "EARTH_MODELS_CONFLICT", message }, 409);
        return json({ code: "EARTH_MODELS_SAVE_FAILED", message },
          error instanceof EarthModelRequestError ? error.status : request.method === "GET" ? 503 : 400);
      } finally { pendingRequests--; }
    },
  };
}

export const earthModelProjectFiles = createEarthModelProjectFiles();
