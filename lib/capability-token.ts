export const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ShareOriginUnavailableReason =
  | "missing-origin"
  | "invalid-configured-origin"
  | "invalid-current-origin"
  | "loopback-origin";

export type ShareOriginResolution =
  | {
      origin: string;
      source: "configured" | "current";
      reason: null;
    }
  | {
      origin: null;
      source: null;
      reason: ShareOriginUnavailableReason;
    };

export type CapabilityUrlResult =
  | { url: string; reason: null }
  | { url: null; reason: ShareOriginUnavailableReason };

export type ShareOriginInput = {
  currentOrigin: string | null | undefined;
  configuredOrigin?: string | null;
};

export function createCapabilityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isCapabilityToken(value: string): boolean {
  return CAPABILITY_TOKEN_PATTERN.test(value);
}

function normalizedWebOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrUnspecified(origin: string): boolean {
  const hostname = new URL(origin).hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  const mappedFirstOctet = mappedIpv4
    ? Number.parseInt(mappedIpv4[1], 16) >>> 8
    : null;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    mappedFirstOctet === 127 ||
    (mappedIpv4 !== null && mappedIpv4[1] === "0" && mappedIpv4[2] === "0")
  );
}

export function resolveShareOrigin({
  currentOrigin,
  configuredOrigin,
}: ShareOriginInput): ShareOriginResolution {
  const configured = configuredOrigin?.trim() ?? "";
  if (configured) {
    const origin = normalizedWebOrigin(configured);
    return origin
      ? { origin, source: "configured", reason: null }
      : { origin: null, source: null, reason: "invalid-configured-origin" };
  }

  const current = currentOrigin?.trim() ?? "";
  if (!current) {
    return { origin: null, source: null, reason: "missing-origin" };
  }

  const origin = normalizedWebOrigin(current);
  if (!origin) {
    return { origin: null, source: null, reason: "invalid-current-origin" };
  }
  if (isLoopbackOrUnspecified(origin)) {
    return { origin: null, source: null, reason: "loopback-origin" };
  }
  return { origin, source: "current", reason: null };
}

export function currentShareOrigin(): ShareOriginResolution {
  return resolveShareOrigin({
    currentOrigin: typeof window === "undefined" ? null : window.location.origin,
    configuredOrigin:
      typeof process === "undefined"
        ? undefined
        : process.env.NEXT_PUBLIC_APP_ORIGIN,
  });
}

export function capabilityUrl(
  kind: "invite" | "recover",
  token: string,
  shareOrigin: ShareOriginResolution = currentShareOrigin(),
): CapabilityUrlResult {
  if (shareOrigin.origin === null) {
    return { url: null, reason: shareOrigin.reason };
  }
  const url = new URL(shareOrigin.origin);
  url.hash = `/${kind}/${token}`;
  return { url: url.toString(), reason: null };
}
