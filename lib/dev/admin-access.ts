import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getDevIdentity } from "./api-store";

type AccessState = { grants: Map<string, { publicId: string; secret: string; until: number }>; attempts: Map<string, { failures: number; until: number }> };
const host = globalThis as typeof globalThis & { __zhivDevAdminAccess?: AccessState };
const state = () => host.__zhivDevAdminAccess ??= { grants: new Map(), attempts: new Map() };
const digest = (value: string) => createHash("sha256").update(value).digest();
const key = (token: string) => digest(token).toString("hex");
const configuredSecret = () => process.env.DEV_ADMIN_PASSWORD?.trim() ?? "";
export const resetDevAdminAccessForTests = () => { delete host.__zhivDevAdminAccess; };

function privateHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1") return true;
  if (isIP(name) === 6) return /^(fc|fd|fe80:)/.test(name);
  if (isIP(name) !== 4) return false;
  const [first, second] = name.split(".").map(Number);
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254);
}
/** Uses the actual Host, never forwarded headers. Explicit Origin must match; an absent Origin needs browser-owned same-origin metadata. */
export function trustedDevAdminRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    const url = new URL(request.url);
    const authority = request.headers.get("host") ?? url.host;
    const actual = new URL(`${url.protocol}//${authority}`);
    if (!["http:", "https:"].includes(actual.protocol) || !privateHost(actual.hostname) || actual.username || actual.password) return false;
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== actual.origin) return false;
    return request.method === "GET" || origin === actual.origin
      || (origin === null && request.headers.get("sec-fetch-site") === "same-origin");
  } catch { return false; }
}

export function devAdminAllowed(token: string | undefined, now = Date.now()): boolean {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "") || !token || !getDevIdentity(token) || configuredSecret().length < 16) return false;
  const grant = state().grants.get(key(token));
  return !!grant && grant.until > now && grant.publicId === getDevIdentity(token)!.user.publicId
    && grant.secret === digest(configuredSecret()).toString("hex");
}
export function unlockDevAdmin(token: string, password: string, now = Date.now()): "ok" | "invalid" | "limited" | "unconfigured" {
  const secret = configuredSecret();
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "")) return "unconfigured";
  if (secret.length < 16) return "unconfigured";
  const identity = getDevIdentity(token);
  if (!identity) return "invalid";
  const saved = state(), id = key(token), attempt = saved.attempts.get(id);
  if (attempt && attempt.until > now && attempt.failures >= 5) return "limited";
  if (!timingSafeEqual(digest(password), digest(secret))) {
    saved.attempts.set(id, { failures: attempt && attempt.until > now ? attempt.failures + 1 : 1, until: attempt && attempt.until > now ? attempt.until : now + 60_000 });
    return "invalid";
  }
  saved.attempts.delete(id);
  saved.grants.set(id, { publicId: identity.user.publicId, secret: digest(secret).toString("hex"), until: now + 8 * 60 * 60_000 });
  return "ok";
}
export function lockDevAdmin(token: string) { state().grants.delete(key(token)); }
