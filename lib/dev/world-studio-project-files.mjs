import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { prepareLightingPatch, lightingMapRevision } from "../../scripts/apply-lighting-patch.mjs";
import { compileTiledWorld, serializeTiledWorld } from "../../scripts/lib/tiled-world.mjs";
import { FOREST_RECEIVER_MAX_HOLES, FOREST_RECEIVER_MAX_VERTICES }
  from "../../features/world/environment/lighting/forest-receiver-geometry.mjs";

const FILE_LIMIT = 32 * 1024 * 1024;
export const WORLD_STUDIO_BODY_LIMIT = 2 * 1024 * 1024;
export const WORLD_STUDIO_BODY_TIMEOUT_MS = 10_000;
export const WORLD_STUDIO_PENDING_LIMIT = 8;
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (data, status = 200) => Response.json(data, { status, headers });

export class WorldStudioFileConflict extends Error {}
class WorldStudioRequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 127 || parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  }
  return /^f[cd][0-9a-f]{2}:/.test(host);
}

/** Origin checks stop browser CSRF/rebinding; private LAN clients remain trusted. */
export function worldStudioRequestAllowed(request, environment = process.env.NODE_ENV) {
  if (environment !== "development") return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = request.headers.get("host");
  if (!host || /[\s/@\\?#]/.test(host)) return false;
  let authority;
  try { authority = new URL(`${url.protocol}//${host}`); } catch { return false; }
  // Next can use its configured 0.0.0.0/localhost in request.url on LAN requests.
  // Validate the actual Host, without accepting X-Forwarded-Host or public names.
  if (authority.host.toLowerCase() !== host.toLowerCase() || !privateHost(authority.hostname)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== authority.origin) return false;
  return request.method !== "POST" || origin === authority.origin;
}

async function readBounded(file, optional = false) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > FILE_LIMIT) throw new Error("Файл проекта слишком большой или не является обычным файлом.");
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > FILE_LIMIT) throw new Error("Файл проекта слишком большой.");
    return { text, mode: info.mode };
  } catch (error) {
    if (optional && error.code === "ENOENT") return { text: null, mode: 0o644 };
    throw error;
  }
}

/** Reject over-budget geometry before the disk queue and image compilation.
 * These are the existing patch/compiler limits, not a smaller editor format. */
function patchBudget(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Некорректный патч освещения.");
  for (const [key, limit] of [["casters", 128], ["receivers", 32], ["lights", 128]]) {
    const edits = patch[key];
    if (edits === undefined) continue; // Version requirements are checked by the canonical validator.
    if (!Array.isArray(edits) || edits.length > limit) throw new Error(`patch.${key}: ожидается не больше ${limit} изменений.`);
    if (key === "lights") continue;
    for (const edit of edits) for (const value of [edit?.before, edit?.after]) {
      if (!value) continue;
      if (value.points !== undefined && (!Array.isArray(value.points) || value.points.length > FOREST_RECEIVER_MAX_VERTICES))
        throw new Error(`patch.${key}: в контуре допускается не больше ${FOREST_RECEIVER_MAX_VERTICES} вершин.`);
      if (value.holes === undefined) continue;
      if (!Array.isArray(value.holes) || value.holes.length > FOREST_RECEIVER_MAX_HOLES)
        throw new Error(`patch.${key}: допускается не больше ${FOREST_RECEIVER_MAX_HOLES} исключений.`);
      if (value.holes.some(ring => !Array.isArray(ring) || ring.length > FOREST_RECEIVER_MAX_VERTICES))
        throw new Error(`patch.${key}: в исключении допускается не больше ${FOREST_RECEIVER_MAX_VERTICES} вершин.`);
    }
  }
}

async function requestBody(request, timeoutMs) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > WORLD_STUDIO_BODY_LIMIT))
    throw new WorldStudioRequestError("Запрос сохранения слишком большой.", 413);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || request.headers.has("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")
    throw new WorldStudioRequestError("Ожидается несжатый JSON.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Пустой запрос сохранения.");
  // A byte limit must also bound storage for many tiny transfer chunks.
  const bytes = Buffer.allocUnsafe(WORLD_STUDIO_BODY_LIMIT);
  let size = 0;
  let timeout;
  let abort;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new WorldStudioRequestError("Истекло время загрузки сохранения. Повторите запрос.", 408)), timeoutMs);
    abort = () => reject(new WorldStudioRequestError("Загрузка сохранения отменена.", 408));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
  const consume = async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (size + result.value.byteLength > WORLD_STUDIO_BODY_LIMIT)
        throw new WorldStudioRequestError("Запрос сохранения слишком большой.", 413);
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
  };
  try {
    // One deadline subscription per upload, not one retained reaction per chunk.
    await Promise.race([consume(), deadline]);
  } catch (error) {
    // Cancellation can itself wait on a remote producer; never await it here.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  let body;
  try { body = JSON.parse(bytes.toString("utf8", 0, size)); }
  catch { throw new Error("Некорректный JSON сохранения."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== "expectedRevision,patch,requestId"
    || typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision)
    || typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,96}$/.test(body.requestId)) throw new Error("Некорректные параметры сохранения.");
  patchBudget(body.patch);
  return body;
}

/** Fixed paths owned by the checkout. Tests inject a temporary checkout only. */
export function createWorldStudioProjectFiles({ root = process.cwd(), renameFile = rename,
  bodyTimeoutMs = WORLD_STUDIO_BODY_TIMEOUT_MS } = {}) {
  const mapPath = path.join(root, "world/tiled/forest.tmj");
  const outputPath = path.join(root, "features/world/tiled/forest.generated.json");
  const publicDir = path.join(root, "public");
  let queue = Promise.resolve();
  let pendingRequests = 0;
  const receipts = new Map();
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const compile = async source => {
    const scene = await compileTiledWorld(JSON.parse(source), { mapPath, publicDir });
    if (!scene.actor) throw new Error("В карте отсутствует точка появления персонажа; проект не сохранён.");
    return scene;
  };
  const current = async () => {
    const source = await readBounded(mapPath);
    const scene = await compile(source.text);
    if ((await readBounded(mapPath)).text !== source.text) throw new WorldStudioFileConflict("Карта изменилась во время чтения. Повторите подключение.");
    return { available: true, revision: lightingMapRevision(source.text), scene };
  };
  const writePair = async (source, generated, mapText, generatedText) => {
    const entries = [{ file: mapPath, before: source, after: mapText }, { file: outputPath, before: generated, after: generatedText }]
      .filter(entry => entry.before.text !== entry.after);
    const committed = [];
    try {
      for (const entry of entries) {
        await mkdir(path.dirname(entry.file), { recursive: true });
        entry.temporary = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.${randomUUID()}.studio-tmp`);
        await writeFile(entry.temporary, entry.after, { flag: "wx", mode: entry.before.mode });
      }
      if ((await readBounded(mapPath)).text !== source.text || (await readBounded(outputPath, true)).text !== generated.text)
        throw new WorldStudioFileConflict("Файлы изменились в другом редакторе. Сохранение остановлено.");
      for (const entry of entries) {
        if ((await readBounded(entry.file, true)).text !== entry.before.text)
          throw new WorldStudioFileConflict("Файл изменился в другом редакторе. Сохранение остановлено.");
        await renameFile(entry.temporary, entry.file);
        committed.push(entry);
      }
    } catch (error) {
      // A failed second rename must leave the source/export pair as it was.
      // Never roll back over a newer external edit made after our rename.
      for (const entry of committed.reverse()) {
        if ((await readBounded(entry.file, true)).text !== entry.after) continue;
        if (entry.before.text === null) await rm(entry.file, { force: true });
        else {
          const rollback = `${entry.file}.${randomUUID()}.studio-rollback`;
          try {
            await writeFile(rollback, entry.before.text, { flag: "wx", mode: entry.before.mode });
            await rename(rollback, entry.file);
          } finally { await rm(rollback, { force: true }); }
        }
      }
      throw error;
    } finally {
      for (const entry of entries) if (entry.temporary) await rm(entry.temporary, { force: true });
    }
  };
  const save = async body => {
    const source = await readBounded(mapPath);
    const revision = lightingMapRevision(source.text);
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const receipt = receipts.get(body.requestId);
    if (receipt && receipt.digest !== digest) throw new WorldStudioFileConflict("Ключ сохранения уже использован другим запросом.");
    if (receipt && receipt.revision !== revision) throw new WorldStudioFileConflict("После сохранения карта изменена в другом редакторе. Черновик сохранён в браузере.");
    if (receipt) return current();
    if (body.expectedRevision !== revision)
      throw new WorldStudioFileConflict("Карта изменена в Tiled или другом окне. Черновик сохранён в браузере; файлы не перезаписаны.");
    const prepared = await prepareLightingPatch({ patch: body.patch, mapSource: source.text, mapPath, publicDir, allowAlreadyApplied: true });
    if (!prepared.world.actor) throw new Error("В карте отсутствует точка появления персонажа; проект не сохранён.");
    const generated = await readBounded(outputPath, true);
    await writePair(source, generated, prepared.sourceText, serializeTiledWorld(prepared.world));
    const result = { available: true, revision: prepared.revision, scene: prepared.world };
    receipts.set(body.requestId, { digest, revision: result.revision });
    if (receipts.size > 128) receipts.delete(receipts.keys().next().value);
    return result;
  };
  return {
    read: () => serial(current),
    save: body => serial(() => save(body)),
    async handle(request, environment = process.env.NODE_ENV) {
      if (!worldStudioRequestAllowed(request, environment)) return json({ available: false, code: "STUDIO_PROJECT_UNAVAILABLE" }, environment === "development" ? 403 : 404);
      if (request.method !== "GET" && request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (pendingRequests >= WORLD_STUDIO_PENDING_LIMIT) return Response.json({ available: true, code: "STUDIO_PROJECT_BUSY",
        message: "Сервер студии занят. Черновик сохранён в браузере; повторите сохранение." }, {
        status: 429, headers: { ...headers, "Retry-After": "1" },
      });
      pendingRequests++;
      try {
        // Read bounded bodies before joining the disk queue: a stalled uploader
        // must not block other tabs' reads or acknowledged saves.
        const body = request.method === "POST" ? await requestBody(request, bodyTimeoutMs) : null;
        return json(await serial(() => {
          if (request.signal.aborted) throw new WorldStudioRequestError("Запрос сохранения отменён.", 408);
          return body ? save(body) : current();
        }));
      }
      catch (error) {
        // Node I/O errors contain checkout paths. Validation messages are useful
        // to the editor, but their size must not reflect arbitrary input keys.
        const message = typeof error.code === "string" ? "Не удалось прочитать или записать файлы проекта. Проверьте локальный сервер."
          : String(error.message ?? "Не удалось сохранить файлы проекта.").slice(0, 600);
        if (error instanceof WorldStudioFileConflict || /stale|already exists|unknown .*caster|unknown .*receiver|unknown authored light/i.test(message))
          return json({ available: true, code: "STUDIO_PROJECT_CONFLICT", message }, 409);
        return json({ available: true, code: "STUDIO_PROJECT_SAVE_FAILED", message },
          error instanceof WorldStudioRequestError ? error.status : request.method === "GET" ? 503 : 400);
      }
      finally { pendingRequests--; }
    },
  };
}

export const worldStudioProjectFiles = createWorldStudioProjectFiles();
