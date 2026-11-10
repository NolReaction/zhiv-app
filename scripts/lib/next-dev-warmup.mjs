import { stripVTControlCharacters } from "node:util";

// OPTIONS is implemented by Next itself: it compiles a route without calling
// its GET/POST handlers, reading an account, or creating a development session.
// Keep this explicit list limited to the first-play flow. Other tools stay lazy.
export const NEXT_DEV_WARMUP_API_PATHS = Object.freeze([
  "/api/v1/auth/options", "/api/v1/bootstrap", "/api/v1/me",
  "/api/v1/people", "/api/v1/groups", "/api/v1/onboarding",
  "/api/v1/presence", "/api/v1/check-ins", "/api/v1/world", "/api/v1/world/commands",
  "/api/v1/world/forest-memory", "/api/v1/world/forest-memory/commands",
  "/api/v1/economy", "/api/v1/economy/commands",
  "/api/v1/economy/market", "/api/v1/economy/market/commands",
  "/api/v1/economy/barter", "/api/v1/economy/barter/commands",
  "/api/v1/game/progress", "/api/v1/game/achievements", "/api/v1/game/rewards",
  "/api/v1/game/rewards/claims", "/api/v1/game/sessions", "/api/v1/game/batches",
  "/api/v1/game/visibility", "/api/v1/game-events",
  "/api/v1/notifications", "/api/v1/notifications/presence",
  "/api/v1/notifications/preferences", "/api/v1/notifications/subscriptions", "/api/v1/mail",
]);
export const NEXT_DEV_WARMUP_PAGES = Object.freeze(["/", "/manifest.webmanifest", "/prototype/trade-ship"]);

function hostnameArgument(args) {
  for (let index = args.length - 1; index >= 0; index--) {
    if (args[index].startsWith("--hostname=")) return args[index].slice("--hostname=".length);
    if (args[index] === "--hostname" || args[index] === "-H") return args[index + 1];
  }
}

/** Use the port reported by this child, including Next's busy-port fallback. */
export function nextDevWarmupOrigin(output, args = []) {
  const local = stripVTControlCharacters(output).match(/(?:^|\n)\s*(?:-\s*)?Local:\s+(https?:\/\/\S+)/)?.[1];
  if (!local) return null;
  const url = new URL(local);
  if (url.protocol !== "http:" || url.username || url.password) return null;
  const hostname = hostnameArgument(args);
  if (hostname) url.hostname = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "[::1]" : hostname;
  return url.origin;
}

/** Observe only the spawned Next process; never probe a possibly occupied port. */
export function nextDevReadyListener(args, onReady) {
  let output = "", started = false;
  return chunk => {
    if (started) return;
    output = (output + chunk).slice(-16_384);
    if (!/\bReady in\b/.test(stripVTControlCharacters(output))) return;
    const origin = nextDevWarmupOrigin(output, args);
    if (!origin) return;
    started = true;
    onReady(origin);
  };
}

export async function warmNextDev({ origin, signal, fetchRequest = fetch, log = console.info,
  apiPaths = NEXT_DEV_WARMUP_API_PATHS, pages = NEXT_DEV_WARMUP_PAGES }) {
  const total = apiPaths.length + pages.length;
  let complete = 0;
  const failures = [];
  log(`\n[DEV] Прогрев ${total} маршрутов. Откройте игру после сообщения «Готово для игры».`);
  async function request(path, method) {
    signal?.throwIfAborted();
    try {
      const response = await fetchRequest(new URL(path, origin), {
        method, redirect: "manual", cache: "no-store", credentials: "omit",
        headers: { Accept: method === "OPTIONS" ? "*/*" : "text/html,application/json" },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]),
      });
      // Drain the response so server rendering and its client entries finish.
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      log(`[DEV] ${++complete}/${total} ${method} ${path}`);
    } catch (error) {
      signal?.throwIfAborted();
      failures.push({ path, method, error: error.message });
      log(`[DEV] ${++complete}/${total} ${method} ${path}: ${error.message}`);
    }
  }
  // At most two server compilations are requested together. Finish API entries
  // before rendering the UI, so their first additions do not interrupt a player.
  for (let index = 0; index < apiPaths.length; index += 2) {
    await Promise.all(apiPaths.slice(index, index + 2).map(path => request(path, "OPTIONS")));
  }
  for (const path of pages) await request(path, "GET");
  signal?.throwIfAborted();
  if (failures.length) log(`[DEV] Прогрев завершён частично (${failures.length} ошибок). Сервер работает; проверьте сообщения выше.`);
  else log(`[DEV] Готово для игры: ${origin}\n`);
  return { ready: failures.length === 0, failures };
}
