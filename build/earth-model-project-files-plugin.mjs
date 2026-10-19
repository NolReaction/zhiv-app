import { Readable } from "node:stream";

const ROUTE = "/api/dev/earth-models";

/** Vite's Cloudflare worker has no writable checkout filesystem. Keep this
 * development-only endpoint in Vite's Node host, before dispatch to the worker.
 * @returns {import("vite").Plugin} */
export function earthModelProjectFilesDev() {
  return {
    name: "earth-model-project-files-dev",
    apply: "serve",
    async configureServer(server) {
      if (process.env.NODE_ENV !== "development") return;
      const { createEarthModelProjectFiles, earthModelPrivateHost } = await import("../lib/dev/earth-model-project-files.mjs");
      const files = createEarthModelProjectFiles({ root: server.config.root });
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname !== ROUTE && pathname !== `${ROUTE}/`) return next();
        const fail = (status, code) => {
          response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
          response.end(JSON.stringify({ code }));
        };
        if (process.env.NODE_ENV !== "development") return fail(404, "EARTH_MODELS_UNAVAILABLE");
        // Vite binds 0.0.0.0 for phone testing. A private Host alone must not
        // authorize a public peer that forged the header on that listener.
        const peer = request.socket.remoteAddress?.replace(/^::ffff:/i, "");
        if (!peer || !earthModelPrivateHost(peer)) return fail(403, "EARTH_MODELS_UNAVAILABLE");
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        const onClose = () => { if (!response.writableFinished) abort.abort(); };
        request.once("aborted", onAbort);
        response.once("close", onClose);
        const run = async () => {
          let webRequest;
          try {
            const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
              if (typeof value === "string") headers.set(key, value);
              else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
            }
            const method = request.method ?? "GET";
            webRequest = new Request(`${protocol}//${headers.get("host")}${ROUTE}`, {
              method, headers, signal: abort.signal,
              ...(["GET", "HEAD"].includes(method) ? {} : {
                // The writer cancels oversized/stalled uploads. Do not let
                // that cancellation destroy the socket before its 413/408.
                body: Readable.toWeb(request).pipeThrough(new TransformStream(), { preventCancel: true }), duplex: "half",
              }),
            });
          } catch { return fail(403, "EARTH_MODELS_UNAVAILABLE"); }
          const result = await files.handle(webRequest);
          if (response.destroyed) return;
          const headers = Object.fromEntries(result.headers);
          // Finish denied/over-budget uploads without retaining an unread body
          // on a reusable connection. No unbounded draining is necessary.
          if (result.status >= 400 && !["GET", "HEAD"].includes(request.method ?? "GET")) headers.connection = "close";
          response.writeHead(result.status, headers);
          response.end(await result.text());
        };
        void run().catch(() => {
          if (!response.destroyed && !response.headersSent) fail(503, "EARTH_MODELS_SAVE_FAILED");
          else if (!response.destroyed) response.end();
        }).finally(() => {
          request.off("aborted", onAbort);
          response.off("close", onClose);
        });
      });
    },
  };
}
