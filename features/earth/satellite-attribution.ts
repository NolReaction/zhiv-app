export type EarthAttributionPart = { text: string; href?: string };
export const EARTH_ATTRIBUTION_LIMIT = 4096;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1].toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

function plainText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ");
}

/** Links in provider metadata are navigation only; no supplied image/HTML executes. */
function safeLink(attributes: string): string | undefined {
  const links: string[] = [];
  const pattern = /([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === "href") links.push(decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  if (links.length !== 1 || links[0].length > 2048 || /[\u0000-\u001f\u007f]/.test(links[0])) return;
  try {
    const url = new URL(links[0]);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.href;
  } catch { /* Invalid metadata remains visible as escaped text. */ }
}

/** Bounded, DOM-free parsing of the provider's text and <a> tags only. */
export function earthSatelliteAttribution(value: unknown): EarthAttributionPart[] {
  if (typeof value !== "string") return [];
  const bounded = value.slice(0, EARTH_ATTRIBUTION_LIMIT);
  const result: EarthAttributionPart[] = [];
  let offset = 0;
  const addText = (text: string) => {
    if (!text) return;
    const last = result.at(-1);
    if (last && !last.href) last.text += text;
    else result.push({ text });
  };
  for (const match of bounded.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    addText(plainText(bounded.slice(offset, match.index)));
    const text = plainText(match[2]).trim(), href = safeLink(match[1]);
    if (text) { if (href) result.push({ text, href }); else addText(text); }
    offset = match.index + match[0].length;
  }
  addText(plainText(bounded.slice(offset)));
  return result.filter(part => part.text.trim());
}

/** These exact notices are already rendered once with canonical links. */
export function isCanonicalEarthAttribution(part: EarthAttributionPart): boolean {
  if (!part.href) return false;
  const url = new URL(part.href);
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/$/, "");
  if (url.search || url.hash) return false;
  const title = part.text.replace(/©|\(c\)|\bcopyright\b|\bcontributors\b/gi, "").trim().toLowerCase();
  return (host === "maptiler.com" && path === "/copyright" && title === "maptiler")
    || (host === "openstreetmap.org" && path === "/copyright" && title === "openstreetmap")
    || (host === "openmaptiles.org" && path === "" && title === "openmaptiles");
}
