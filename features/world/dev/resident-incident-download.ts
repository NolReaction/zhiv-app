type Report = { filename: string; json: string };
type Link = Pick<HTMLAnchorElement, "href" | "download" | "click" | "remove">;
export type ResidentIncidentDownloadHost = {
  blob: (text: string) => Blob; createUrl: (blob: Blob) => string; revokeUrl: (url: string) => void;
  link: () => Link; attach: (link: Link) => void; later: (cleanup: () => void) => void;
};

/** User-initiated local transfer only. A detached link and its object URL are
 * cleaned even when clicking fails; an unsupported host uses the UI fallback. */
export function downloadResidentIncidentReport(report: Report, host?: ResidentIncidentDownloadHost): boolean {
  if (!/^[a-z0-9.-]{1,80}\.json$/.test(report.filename)) return false;
  if (!host) {
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") return false;
    host = { blob: value => new Blob([value], { type: "application/json;charset=utf-8" }),
      createUrl: value => URL.createObjectURL(value), revokeUrl: value => URL.revokeObjectURL(value),
      link: () => document.createElement("a"), attach: link => document.body.appendChild(link as HTMLAnchorElement),
      later: cleanup => { setTimeout(cleanup, 1000); } };
  }
  let url: string | null = null, link: Link | null = null;
  try {
    url = host.createUrl(host.blob(report.json)); link = host.link();
    link.href = url; link.download = report.filename; host.attach(link); link.click(); return true;
  } catch { return false; }
  finally {
    try { link?.remove(); } catch { /* A failed DOM cleanup cannot retain the URL. */ }
    if (url) {
      const cleanup = () => { try { host!.revokeUrl(url!); } catch { /* Browser has already released it. */ } };
      try { host.later(cleanup); } catch { cleanup(); }
    }
  }
}
