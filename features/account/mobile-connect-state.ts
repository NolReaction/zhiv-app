export type MobileConnectAttempt = { challenge: string; state: string; platform: "ios" | "android" };
export const MOBILE_CONNECT_STORAGE_KEY = "zhiv.mobile-connect.v1";
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_MS = 15 * 60_000;

export function parseMobileConnect(search: string): MobileConnectAttempt | null {
  const query = new URLSearchParams(search);
  const challenge = query.get("challenge"), state = query.get("state"), platform = query.get("platform");
  if (query.getAll("challenge").length !== 1 || query.getAll("state").length !== 1 || query.getAll("platform").length !== 1
    || !challenge || !state || !PROOF.test(challenge) || !PROOF.test(state) || (platform !== "ios" && platform !== "android")) return null;
  return { challenge, state, platform };
}

export function mobileConnectPath(attempt: MobileConnectAttempt): string {
  return `/mobile/connect?${new URLSearchParams(attempt)}`;
}

export function restoreMobileConnect(value: string | null, now: number): string | null {
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (!data || typeof data !== "object" || !("at" in data) || !("path" in data)
      || typeof data.at !== "number" || typeof data.path !== "string" || !Number.isFinite(data.at)
      || data.at > now || now - data.at > MAX_AGE_MS || !data.path.startsWith("/mobile/connect?")) return null;
    const attempt = parseMobileConnect(data.path.slice("/mobile/connect".length));
    return attempt ? mobileConnectPath(attempt) : null;
  } catch { return null; }
}

export function verifiedMobileCallback(value: string, state: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "ru.zhiv.mochlik.lab:" || url.hostname !== "auth" || url.pathname !== "/callback"
      || url.port || url.username || url.password || url.hash || url.searchParams.get("state") !== state
      || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1
      || [...url.searchParams.keys()].some(key => key !== "state" && key !== "code")
      || !PROOF.test(url.searchParams.get("code") ?? "")) return null;
    return url.toString();
  } catch { return null; }
}
