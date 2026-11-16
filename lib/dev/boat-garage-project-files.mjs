import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { worldStudioRequestAllowed } from "./world-studio-project-files.mjs";
import { validateGarageScene } from "../../features/world/dev/boat-garage/garage-scene-model.mjs";

export const GARAGE_JSON_LIMIT = 1024 * 1024;
export const GARAGE_IMAGE_LIMIT = 10 * 1024 * 1024;
const PENDING_LIMIT = 4;
const headers = { "Cache-Control": "no-store" };
const json = (data, status = 200) => Response.json(data, { status, headers });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
class GarageRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Both write methods require the browser's same-origin Origin header. */
export function garageProjectRequestAllowed(request, environment = process.env.NODE_ENV) {
  if (!worldStudioRequestAllowed(request, environment)) return false;
  if (request.method === "GET") return true;
  const authority = new URL(`${new URL(request.url).protocol}//${request.headers.get("host")}`);
  return request.headers.get("origin") === authority.origin;
}

async function boundedBody(request, limit, timeoutMs) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new GarageRequestError("Файл или запрос слишком большой.", 413);
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")
    throw new GarageRequestError("Ожидается несжатый запрос.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new GarageRequestError("Пустой запрос.");
  const bytes = Buffer.allocUnsafe(limit);
  let size = 0, timeout, abort;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new GarageRequestError("Истекло время загрузки. Повторите запрос.", 408)), timeoutMs);
    abort = () => reject(new GarageRequestError("Загрузка отменена.", 408));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
  const consume = async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > limit) throw new GarageRequestError("Файл или запрос слишком большой.", 413);
      bytes.set(part.value, size); size += part.value.byteLength;
    }
  };
  try { await Promise.race([consume(), deadline]); }
  catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
  return bytes.subarray(0, size);
}

function uploadName(request, extension) {
  let supplied = request.headers.get("x-asset-name") ?? `Изображение.${extension}`;
  try { supplied = decodeURIComponent(supplied); } catch { /* Plain names are valid too. */ }
  const name = supplied.replaceAll("\\", "/").split("/").at(-1)
    .replace(/[^\p{L}\p{N}_. ()-]/gu, "").slice(0, 96).trim();
  return name || `Изображение.${extension}`;
}

function imageType(bytes, mime) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (mime === "image/png" && png) return { extension: "png", format: "png" };
  if (mime === "image/jpeg" && jpg) return { extension: "jpg", format: "jpeg" };
  if (mime === "image/webp" && webp) return { extension: "webp", format: "webp" };
  throw new GarageRequestError("Содержимое файла не соответствует PNG, WebP или JPEG.", 415);
}

/** Fixed checkout-owned paths; no client-supplied path is ever used on disk. */
export function createGarageProjectFiles({ root = process.cwd(), bodyTimeoutMs = 10_000 } = {}) {
  const checkout = path.resolve(root);
  let queue = Promise.resolve(), pending = 0;
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };

  /** Walk fixed checkout-relative directories without following symlink components.
   * Create one directory at a time so recursive mkdir cannot traverse a link. */
  async function directory(relative, create = false) {
    const canonicalRoot = await realpath(checkout);
    let current = canonicalRoot;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!create || error.code !== "ENOENT") throw error;
        try { await mkdir(current); } catch (failure) { if (failure.code !== "EEXIST") throw failure; }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Каталог проекта не должен быть символической ссылкой.");
    }
    const canonical = await realpath(current);
    if (canonical !== current || !canonical.startsWith(canonicalRoot + path.sep))
      throw new Error("Каталог находится вне рабочего проекта.");
    return current;
  }

  /** Bounded reads also reject final symlinks and non-regular files. */
  async function readRegular(file, limit) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit) throw new Error("Некорректный файл проекта.");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > limit) throw new Error("Некорректный файл проекта.");
      const bytes = Buffer.allocUnsafe(limit + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > limit) throw new Error("Файл проекта слишком большой.");
      return bytes.subarray(0, size);
    } finally { await handle.close(); }
  }

  async function read() {
    let bytes;
    try { bytes = await readRegular(path.join(await directory("art/world/boat-garage"), "scene.json"), GARAGE_JSON_LIMIT); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes = await readRegular(path.join(await directory("features/world/dev/boat-garage"), "garage-scene-default.json"), GARAGE_JSON_LIMIT);
    }
    const scene = validateGarageScene(JSON.parse(bytes.toString("utf8")));
    return { scene, revision: digest(JSON.stringify(scene)) };
  }

  async function save(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).sort().join() !== "expectedRevision,scene"
      || typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision))
      throw new GarageRequestError("Некорректные параметры сохранения.");
    let scene;
    try { scene = validateGarageScene(body.scene); }
    catch (error) { throw new GarageRequestError(error.message); }
    const current = await read();
    if (body.expectedRevision !== current.revision)
      throw new GarageRequestError("Сцена уже изменена в другом окне. Перезагрузите сохранённую сцену или экспортируйте свою версию.", 409);
    const text = JSON.stringify(scene, null, 2) + "\n";
    if (Buffer.byteLength(text) > GARAGE_JSON_LIMIT) throw new GarageRequestError("Сцена слишком большая.", 413);
    const artDir = await directory("art/world/boat-garage", true);
    const scenePath = path.join(artDir, "scene.json");
    const temporary = path.join(artDir, `.scene-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: "wx" });
      await rename(temporary, scenePath);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { scene, revision: digest(JSON.stringify(scene)) };
  }

  async function upload(bytes, mime, request) {
    const type = imageType(bytes, mime);
    let metadata;
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, animated: false, failOn: "warning" });
      metadata = await image.metadata();
      if (metadata.format !== type.format || !metadata.width || !metadata.height
        || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1)
        throw new Error("Invalid raster geometry.");
      // Force a decode: a valid header attached to a truncated raster is insufficient.
      await image.resize(1, 1).raw().toBuffer();
    } catch {
      throw new GarageRequestError("Не удалось прочитать изображение. Допускается один кадр PNG/WebP/JPEG до 4096×4096 и 16 млн пикселей.");
    }
    const hash = digest(bytes), filename = `asset-${hash}.${type.extension}`;
    const artDir = await directory("art/world/boat-garage", true);
    const publicDir = await directory("public/world/boat-garage", true);
    const created = [];
    try {
      for (const directory of [artDir, publicDir]) {
        const destination = path.join(directory, filename);
        try { await writeFile(destination, bytes, { flag: "wx" }); created.push(destination); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (digest(await readRegular(destination, GARAGE_IMAGE_LIMIT)) !== hash) throw new Error("Повреждён существующий файл изображения.");
        }
      }
    } catch (error) { await Promise.all(created.map(file => rm(file, { force: true }))); throw error; }
    const dimensions = metadata.autoOrient ?? metadata;
    return { asset: { id: `asset-${hash.slice(0, 12)}`, name: uploadName(request, type.extension),
      src: `/world/boat-garage/${filename}`, width: dimensions.width, height: dimensions.height } };
  }

  async function handle(request, environment = process.env.NODE_ENV) {
    if (environment !== "development") return json({ code: "GARAGE_PROJECT_UNAVAILABLE" }, 404);
    if (!garageProjectRequestAllowed(request, environment)) return json({ code: "UNTRUSTED_ORIGIN", message: "Источник запроса не разрешён." }, 403);
    if (!["GET", "POST", "PUT"].includes(request.method)) return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    if (pending >= PENDING_LIMIT) return json({ code: "GARAGE_PROJECT_BUSY", message: "Дождитесь завершения предыдущей загрузки." }, 429);
    pending++;
    try {
      if (request.method === "GET") return json(await serial(read));
      const mime = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (request.method === "POST") {
        if (mime !== "application/json") throw new GarageRequestError("Ожидается application/json.", 415);
        const bytes = await boundedBody(request, GARAGE_JSON_LIMIT, bodyTimeoutMs);
        let body;
        try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new GarageRequestError("Некорректный JSON."); }
        return json(await serial(() => save(body)));
      }
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
        throw new GarageRequestError("Поддерживаются только PNG, WebP и JPEG.", 415);
      const bytes = await boundedBody(request, GARAGE_IMAGE_LIMIT, bodyTimeoutMs);
      return json(await serial(() => upload(bytes, mime, request)), 201);
    } catch (error) {
      if (error instanceof GarageRequestError) return json({ code: "GARAGE_REQUEST_FAILED", message: error.message }, error.status);
      return json({ code: "GARAGE_PROJECT_FAILED", message: "Не удалось прочитать или сохранить файлы гаража. Проверьте доступ к локальному проекту." }, 503);
    } finally { pending--; }
  }
  return { read, handle };
}

export const garageProjectFiles = createGarageProjectFiles();
