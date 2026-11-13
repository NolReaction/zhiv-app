export type NativeLinkAction = { kind: "website"; path: string } | { kind: "browser"; url: string } | { kind: "blocked" } | null;
const publicDocument = /^\/(?:earth\/models\/CREDITS\.txt|vendor\/maplibre-gl-\d+\.\d+\.\d+\/LICENSE\.txt)$/;

/** No authorization headers or native credentials are carried into external navigation. */
export function nativeLinkAction(href: string, target: string, documentUrl: string): NativeLinkAction {
  let url: URL, current: URL;
  try { current = new URL(documentUrl); url = new URL(href, current); }
  catch { return { kind: "blocked" }; }
  if (url.username || url.password) return { kind: "blocked" };
  // Leave ordinary phone/mail links to Capacitor's platform URL handling.
  if (url.protocol === "mailto:" || url.protocol === "tel:") return null;
  const local = url.protocol === current.protocol && url.host === current.host;
  if (local) {
    if (target !== "_blank") return null;
    if (!url.search && !url.hash && publicDocument.test(url.pathname)) return { kind: "website", path: url.pathname };
    return { kind: "blocked" };
  }
  if (url.protocol === "https:") return { kind: "browser", url: url.href };
  return { kind: "blocked" };
}
