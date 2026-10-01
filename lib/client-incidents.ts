import { createUuidV4 } from "@/lib/browser-uuid";
import { ApiError } from "@/lib/check-in-api";

export const INCIDENT_MESSAGES: Record<string, string> = {
  WORLD_MAP_FAILED: "Не загрузилась карта леса", WORLD_MAP_TIMEOUT: "Карта леса загружается слишком долго",
  WORLD_CHARACTER_FAILED: "Не загрузилась сцена Мохлика", WORLD_CHARACTER_TIMEOUT: "Сцена Мохлика загружается слишком долго",
  NETWORK_ERROR: "Запрос не дошёл или ответ не получен", TIMEOUT: "Сервер не ответил вовремя",
  RATE_LIMITED: "Сработало ограничение частоты запросов", SERVER_ERROR: "Ошибка API",
  SYNC_RECOVERED: "Связь восстановлена, отправка очереди продолжается", RECEIPT_INVALID: "Не удалось проверить подтверждение нажатий",
  QUEUE_FULL: "Очередь на устройстве заполнена", STORAGE_FAILED: "Браузер не смог сохранить очередь",
  GAME_ACTIVE_ELSEWHERE: "Игра активна в другом окне или на другом устройстве",
  GAME_SESSION_EXPIRED: "Разрешение на игру истекло", GAME_PERMIT_CLOSED: "Часть нажатий сделана после передачи игры или окончания разрешения",
  GAME_QUEUE_EXPIRED: "Срок доставки очереди истёк; требуется проверка сохранённой записи",
  GAME_TAP_RATE: "Часть нажатий превысила допустимую частоту",
  GAME_SESSION_GONE: "Не найдена сессия для подтверждения очереди", GAME_SEQUENCE_CONFLICT: "Нарушена последовательность подтверждений",
  GAME_SESSION_CONFLICT: "Очередь относится к другому сеансу входа", GAME_PACING: "Очередь ожидает свободный лимит нажатий",
  UNAUTHORIZED: "Нужно повторно войти", GAME_OWNER_CHANGED: "Открыт другой аккаунт",
  SYNC_ERROR: "Не удалось синхронизировать данные", PAGE_ERROR: "Ошибка интерфейса", UNHANDLED_REJECTION: "Необработанная ошибка страницы",
  OFFLINE: "Устройство потеряло соединение", DATABASE_BUSY: "База данных временно занята", INTERNAL_ERROR: "Внутренняя ошибка API",
};
type Incident = { eventId: string; ownerPublicId: string; operation: string; code: string; occurredAt: string;
  requestId?: string; httpStatus?: number; pendingTaps: number; occurrences: number };
type StartupIncident = Omit<Incident, "ownerPublicId">;
const OPERATIONS = new Set(["game.progress", "game.session", "game.batch", "game.storage", "check-in", "world", "page"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inFlight = new Set<string>();
const sendingEvents = new Set<string>();
const lastFailure = new Map<string, number>();
// A small fallback keeps diagnostics useful when Safari denies browser storage.
const memory = new Map<string, Incident[]>();
const volatileOwners = new Set<string>();
let startup: StartupIncident[] = [];
function clientCode(code: string): string | null {
  // These are server incident codes, but are not accepted by the client intake.
  if (code === "DATABASE_BUSY" || code === "INTERNAL_ERROR") return "SERVER_ERROR";
  return Object.hasOwn(INCIDENT_MESSAGES, code) ? code : null;
}
export function incidentCode(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.body?.code ? clientCode(error.body.code) : null;
    if (code) return code;
    if (error.status === 429) return "RATE_LIMITED";
    if (error.status >= 500) return "SERVER_ERROR";
    if (error.status === 401) return "UNAUTHORIZED";
    return "SYNC_ERROR";
  }
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "TIMEOUT" : "NETWORK_ERROR";
}
function key(owner: string) { return `zhiv:incidents:v1:${owner}`; }
function bounded(value: unknown, fallback = 0) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100000, Math.floor(value))) : fallback; }
function sanitize(item: unknown, owner: string): Incident | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const code = typeof value.code === "string" ? clientCode(value.code) : null;
  if (value.ownerPublicId !== owner || typeof value.eventId !== "string" || !UUID.test(value.eventId)
    || typeof value.operation !== "string" || !OPERATIONS.has(value.operation) || !code
    || typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))
    || Date.now() - Date.parse(value.occurredAt) >= 7 * 86400_000 || Date.parse(value.occurredAt) > Date.now() + 300_000) return null;
  return { eventId: value.eventId.toLowerCase(), ownerPublicId: owner, operation: value.operation, code,
    occurredAt: value.occurredAt, pendingTaps: bounded(value.pendingTaps), occurrences: Math.max(1, bounded(value.occurrences, 1)),
    ...(typeof value.requestId === "string" && UUID.test(value.requestId) ? { requestId: value.requestId.toLowerCase() } : {}),
    ...(typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) };
}
function remember(owner: string, items: Incident[]) {
  memory.delete(owner);
  memory.set(owner, items.slice(-50));
  if (memory.size > 4) {
    const oldest = memory.keys().next().value!;
    memory.delete(oldest); volatileOwners.delete(oldest);
  }
}
function read(owner: string): Incident[] {
  let items: unknown = memory.get(owner) ?? [];
  try { if (!volatileOwners.has(owner)) items = JSON.parse(localStorage.getItem(key(owner)) ?? JSON.stringify(items)); } catch { /* Use the bounded in-memory copy. */ }
  return Array.isArray(items) ? items.map(item => sanitize(item, owner)).filter((item): item is Incident => item !== null).slice(-50) : [];
}
function write(owner: string, items: Incident[]) {
  remember(owner, items);
  try {
    localStorage.setItem(key(owner), JSON.stringify(items.slice(-50)));
    volatileOwners.delete(owner);
  } catch { volatileOwners.add(owner); /* Reporting must never block the app. */ }
}
function createIncident(operation: string, code: string, pendingTaps = 0, error?: unknown): StartupIncident {
  return { eventId: createUuidV4(), operation, code, occurredAt: new Date().toISOString(), pendingTaps: bounded(pendingTaps), occurrences: 1,
    ...(error instanceof ApiError ? { requestId: error.requestId, httpStatus: error.status } : {}) };
}
function append<T extends StartupIncident>(items: T[], item: T) {
  const previous = items.at(-1);
  if (previous?.operation === item.operation && previous.code === item.code && !sendingEvents.has(previous.eventId)
    && Date.parse(item.occurredAt) - Date.parse(previous.occurredAt) < 30_000) {
    previous.occurrences = Math.min(100000, previous.occurrences + item.occurrences);
    previous.pendingTaps = item.pendingTaps;
  } else items.push(item);
}
export function reportIncident(owner: string, operation: string, code: string, pendingTaps = 0, error?: unknown) {
  const accepted = clientCode(code);
  if (!owner || !accepted || !OPERATIONS.has(operation)) return;
  try {
    const items = read(owner);
    append(items, { ...createIncident(operation, accepted, pendingTaps, error), ownerPublicId: owner });
    write(owner, items);
  } catch { /* Reporting must never break gameplay or report its own failures. */ }
}
/** Startup has no verified owner yet. Never persist or transmit guessed account identity. */
export function reportStartupIncident(error: unknown) {
  try {
    append(startup, createIncident("page", incidentCode(error), 0, error));
    startup = startup.slice(-10);
  } catch { /* Diagnostics cannot prevent startup recovery. */ }
}
/** A confirmed signed-out response discards this attempt before another account can log in. */
export async function resolveStartupIncidents(owner: string | null) {
  const pending = startup;
  startup = [];
  if (!owner) return;
  try {
    if (pending.length) {
      const items = read(owner);
      for (const item of pending) append(items, { ...item, ownerPublicId: owner });
      write(owner, items);
    }
    await flushIncidents(owner);
  } catch { /* Recovery itself must succeed even if diagnostics cannot be sent. */ }
}
export async function flushIncidents(owner: string) {
  if (typeof navigator === "undefined" || !navigator.onLine || inFlight.has(owner) || Date.now() < (lastFailure.get(owner) ?? 0)) return;
  inFlight.add(owner);
  try {
    // A bounded burst; remaining records are retried on the next heartbeat.
    for (const item of read(owner).slice(0, 3)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      sendingEvents.add(item.eventId);
      try {
        const response = await fetch("/api/v1/client-incidents", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(item), signal: controller.signal });
        if (!response.ok) {
          // One obsolete/malformed record must not block all later diagnostics for seven days.
          const invalid = response.status === 400 && (await response.json().catch(() => null))?.code === "INVALID_INCIDENT";
          if (!invalid) { lastFailure.set(owner, Date.now() + 60_000); return; }
        }
        write(owner, read(owner).filter(value => value.eventId !== item.eventId));
      } finally { clearTimeout(timer); sendingEvents.delete(item.eventId); }
    }
    lastFailure.delete(owner);
  } catch { lastFailure.set(owner, Date.now() + 60_000); }
  finally { inFlight.delete(owner); }
}
