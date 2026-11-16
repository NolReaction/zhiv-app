import { Readable } from "node:stream";

const ROUTE = "/api/dev/boat-garage";

/** The Cloudflare worker cannot persist a local checkout. Dispatch this local
 * editor endpoint in Vite's Node host before the worker handles application APIs.
 * @returns {import("vite").Plugin} */
export function boatGarageProjectFilesDev() {
  return {
    name: "boat-garage-project-files-dev",
    apply: "serve",
    async configureServer(server) {
      if (process.env.NODE_ENV !== "development") return;
      const [{ createGarageProjectFiles }, { earthModelPrivateHost }] = await Promise.all([
        import("../lib/dev/boat-garage-project-files.mjs"),
        import("../lib/dev/earth-model-project-files.mjs"),
      ]);
      const files = createGarageProjectFiles({ root: server.config.root });
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname !== ROUTE && pathname !== `${ROUTE}/`) return next();
        const fail = (status, code) => {
          response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
          response.end(JSON.stringify({ code }));
        };
        if (process.env.NODE_ENV !== "development") return fail(404, "GARAGE_PROJECT_UNAVAILABLE");
        // Binding 0.0.0.0 permits phone testing; a public peer cannot gain file
        // access simply by forging a private Host or forwarded proxy header.
        const peer = request.socket.remoteAddress?.replace(/^::ffff:/i, "");
        if (!peer || !earthModelPrivateHost(peer)) return fail(403, "GARAGE_PROJECT_UNAVAILABLE");
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        const onClose = () => { if (!response.writableFinished) abort.abort(); };
        request.once("aborted", onAbort); response.once("close", onClose);
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
                // Preserve the connection long enough to return a bounded-body
                // error when the writer cancels an oversized or stalled upload.
                body: Readable.toWeb(request).pipeThrough(new TransformStream(), { preventCancel: true }), duplex: "half",
              }),
            });
          } catch { return fail(403, "GARAGE_PROJECT_UNAVAILABLE"); }
          const result = await files.handle(webRequest);
          if (response.destroyed) return;
          const headers = Object.fromEntries(result.headers);
          if (result.status >= 400 && !["GET", "HEAD"].includes(request.method ?? "GET")) headers.connection = "close";
          response.writeHead(result.status, headers); response.end(await result.text());
        };
        void run().catch(() => {
          if (!response.destroyed && !response.headersSent) fail(503, "GARAGE_PROJECT_FAILED");
          else if (!response.destroyed) response.end();
        }).finally(() => {
          request.off("aborted", onAbort); response.off("close", onClose);
        });
      });
    },
  };
}
