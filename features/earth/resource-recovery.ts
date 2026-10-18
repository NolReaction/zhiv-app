type EarthResourceError = { error?: unknown; sourceId?: unknown; tile?: unknown };
type EarthResourceMap = {
  getSource: (id: string) => unknown;
  getPixelRatio: () => number;
  getStyle: () => unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function resourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function encodedErrorUrls(message: string): string[] {
  const urls: string[] = [];
  // encodeURIComponent leaves these characters unescaped. A following comma in
  // MapLibre's "Unable to parse the tile at ..., got error" is not URL data.
  const pattern = /earth-cache:\/\/resource\?url=((?:%[a-f\d]{2}|[a-z\d_.!~*'()-])+)/gi;
  for (const match of message.matchAll(pattern)) {
    try {
      const url = resourceUrl(decodeURIComponent(match[1]));
      if (url) urls.push(url);
    } catch { /* An unrelated or truncated diagnostic must not clear a cache. */ }
  }
  return urls;
}

/** Identify only resources implicated by a renderer error; the cache enforces its own allowlist. */
export function getEarthErrorResourceUrls(event: EarthResourceError, map: EarthResourceMap): string[] {
  const error = record(event.error);
  const message = typeof event.error === "string" ? event.error : typeof error?.message === "string" ? error.message : "";
  const explicit = encodedErrorUrls(message);
  const errorUrl = resourceUrl(error?.url);
  if (errorUrl) explicit.push(errorUrl);
  // A vector worker reports its actual URL, including an overzoom parent. It is
  // more precise than rebuilding a URL from the displayed child tile.
  if (explicit.length) return [...new Set(explicit)];

  if (typeof event.sourceId === "string") {
    try {
      const source = record(map.getSource(event.sourceId));
      if (!source) return [];
      if (event.tile !== undefined && event.tile !== null) {
        const canonical = record(record(record(event.tile)?.tileID)?.canonical);
        const tiles = source.tiles;
        if (!canonical || typeof canonical.url !== "function" || !Array.isArray(tiles)
          || !tiles.length || !tiles.every(url => typeof url === "string")) return [];
        const url = resourceUrl(canonical.url(tiles, map.getPixelRatio(), source.scheme));
        return url ? [url] : [];
      }
      const url = resourceUrl(source.url);
      return url ? [url] : [];
    } catch { return []; }
  }

  // Sprite decoding errors do not carry a source ID or URL in MapLibre. Repair
  // just the active sprite pair, leaving streets, the globe and the SDK intact.
  if (!/sprite|image|bitmap|decod/i.test(message)) return [];
  try {
    const sprite = record(map.getStyle())?.sprite;
    const sprites = typeof sprite === "string" ? [sprite] : Array.isArray(sprite)
      ? sprite.map(value => record(value)?.url).filter((url): url is string => typeof url === "string") : [];
    const retina = map.getPixelRatio() > 1 ? "@2x" : "";
    return [...new Set(sprites.flatMap(base => [".png", ".json"].flatMap(extension => {
      const normalized = resourceUrl(base);
      if (!normalized) return [];
      const url = new URL(normalized);
      url.pathname += `${retina}${extension}`;
      return [url.href];
    })))];
  } catch { return []; }
}
