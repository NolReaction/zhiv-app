import type { ApiTransport } from "@/lib/api-fetch";
import { createUuidV4 } from "@/lib/browser-uuid";

export type MobileRequest = {
  id: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  expectedUserId?: string;
};
type MobileResponse = { status: number; headers: Record<string, string>; body: string };
type TransportPort = {
  getState(): Promise<{ authenticated: boolean; userId?: string }>;
  request(request: MobileRequest): Promise<MobileResponse>;
  cancelRequest(options: { id: string }): Promise<unknown>;
};
type Receipt = { settle(status: number, body: string): Promise<void> };
type TransportOptions = {
  origin: string;
  prepare?: (request: MobileRequest & { userId: string }) => Promise<Receipt>;
  uuid?: () => string;
  session?: () => { userId: string | null; generation: number; phase: string };
};

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "host", "origin", "referer", "connection", "content-length"]);

/** Accept API paths only. Native code independently validates the decoded path and host. */
export function mobileApiPath(input: string, origin: string): string {
  const base = new URL(origin);
  const url = new URL(input, `${base.origin}/`);
  if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith("/api/v1/")
    || url.pathname === "/api/v1/auth/mobile" || url.pathname.startsWith("/api/v1/auth/mobile/")) {
    throw new TypeError("Недопустимый адрес мобильного API");
  }
  const rawPath = input.split("?")[0];
  if (/[\\\u0000-\u0020]/.test(input) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || /%2f|%5c|%2e|%25|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(rawPath)) {
    throw new TypeError("Недопустимый путь мобильного API");
  }
  return url.pathname + url.search;
}

function encode(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index < bytes.length; index += 0x8000) value += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(value);
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4) throw new RangeError("Ответ сервера слишком большой");
  const raw = atob(value);
  if (raw.length > MAX_RESPONSE_BYTES) throw new RangeError("Ответ сервера слишком большой");
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function abortError(): DOMException { return new DOMException("Запрос отменён", "AbortError"); }

export function createMobileApiTransport(port: TransportPort, options: TransportOptions): ApiTransport {
  return async (input, init) => {
    // Capture the UI owner before any asynchronous body serialization or native call.
    const owner = options.session?.();
    const assertOwner = () => {
      if (!owner) return;
      const current = options.session!();
      if (!["authenticated", "signed-out"].includes(owner.phase) || current.generation !== owner.generation || current.userId !== owner.userId || current.phase !== owner.phase) {
        throw new DOMException("Сеанс приложения изменился", "AbortError");
      }
    };
    assertOwner();
    const url = input instanceof Request ? input.url : String(input);
    const path = mobileApiPath(url, options.origin);
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(path, options.origin), init);
    if (!METHODS.has(request.method)) throw new TypeError("Метод API не поддерживается");
    if (request.signal.aborted) throw abortError();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { if (!FORBIDDEN_HEADERS.has(key)) headers[key] = value; });
    const state = await port.getState();
    assertOwner();
    if (owner && (state.authenticated ? state.userId : null) !== owner.userId) throw new DOMException("Сеанс приложения изменился", "AbortError");
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (bytes && bytes.byteLength > MAX_REQUEST_BYTES) throw new RangeError("Запрос слишком большой");
    if (request.signal.aborted) throw abortError();
    assertOwner();
    if (request.signal.aborted) throw abortError();
    const envelope: MobileRequest = { id: (options.uuid ?? createUuidV4)(), path,
      method: request.method, headers, ...(bytes ? { body: encode(bytes) } : {}),
      ...(state.authenticated && state.userId ? { expectedUserId: state.userId } : {}) };
    const receipt = state.authenticated && state.userId && options.prepare
      ? await options.prepare({ ...envelope, userId: state.userId }) : undefined;
    assertOwner();
    if (request.signal.aborted) throw abortError();
    const result = await new Promise<MobileResponse>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        void port.cancelRequest({ id: envelope.id }).catch(() => {});
        reject(abortError());
      };
      request.signal.addEventListener("abort", abort, { once: true });
      // Check after registering so an abort during request preparation cannot be lost.
      if (request.signal.aborted) { abort(); return; }
      void port.request(envelope).then(value => {
        if (!settled) { settled = true; resolve(value); }
      }, error => { if (!settled) { settled = true; reject(error); } }).finally(() => {
        request.signal.removeEventListener("abort", abort);
      });
    });
    assertOwner();
    if (request.signal.aborted) throw abortError();
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new TypeError("Некорректный ответ мобильного API");
    const responseHeaders = new Headers(result.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("set-cookie2");
    const body = request.method === "HEAD" || [204, 205, 304].includes(result.status) ? null : decode(result.body);
    const response = new Response(body, { status: result.status, headers: responseHeaders });
    // A failed local acknowledgement leaves the same idempotent receipt for reconciliation.
    // Never replace a successful server result with an invented network failure.
    if (receipt) await receipt.settle(result.status, await response.clone().text()).catch(() => {});
    assertOwner();
    if (request.signal.aborted) throw abortError();
    return response;
  };
}
