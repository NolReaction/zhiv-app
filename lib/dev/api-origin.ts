function headerValues(value: string | null): string[] {
  return value
    ? value.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isTrustedDevRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;

  // Browsers calculate this forbidden header themselves. A page cannot forge
  // `same-origin`, even when Next internally represents localhost as 0.0.0.0.
  if (fetchSite === "same-origin") return true;

  const internalUrl = new URL(request.url);
  const allowedOrigins = new Set([internalUrl.origin]);
  const hosts = [
    ...headerValues(request.headers.get("host")),
    ...headerValues(request.headers.get("x-forwarded-host")),
  ];
  const protocols = headerValues(request.headers.get("x-forwarded-proto"));
  if (protocols.length === 0) protocols.push(internalUrl.protocol.slice(0, -1));

  for (const host of hosts) {
    for (const protocol of protocols) {
      if (!["http", "https"].includes(protocol)) continue;
      const publicOrigin = normalizeOrigin(`${protocol}://${host}`);
      if (publicOrigin) allowedOrigins.add(publicOrigin);
    }
  }

  return allowedOrigins.has(normalizedOrigin);
}
