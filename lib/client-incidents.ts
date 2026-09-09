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
const inFlight = new Set<string>();
const lastFailure = new Map<string, number>();
export function incidentCode(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.body?.code && error.body.code in INCIDENT_MESSAGES) return error.body.code;
    if (error.status === 429) return "RATE_LIMITED";
    if (error.status >= 500) return "SERVER_ERROR";
    if (error.status === 401) return "UNAUTHORIZED";
    return "SYNC_ERROR";
  }
  return error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
}
function key(owner: string) { return `zhiv:incidents:v1:${owner}`; }
function read(owner: string): Incident[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(key(owner)) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is Incident => item && item.ownerPublicId === owner && typeof item.eventId === "string"
      && item.code in INCIDENT_MESSAGES && Number.isFinite(Date.parse(item.occurredAt))
      && Date.now() - Date.parse(item.occurredAt) < 7 * 86400_000).slice(-50);
  } catch { return []; }
}
export function reportIncident(owner: string, operation: string, code: string, pendingTaps = 0, error?: unknown) {
  if (typeof localStorage === "undefined" || !(code in INCIDENT_MESSAGES)) return;
  try {
    const items = read(owner);
    const previous = items.at(-1);
    if (previous?.operation === operation && previous.code === code && Date.now() - Date.parse(previous.occurredAt) < 30_000) {
      previous.occurrences = Math.min(100000, previous.occurrences + 1);
      previous.pendingTaps = pendingTaps;
    } else items.push({ eventId: createUuidV4(), ownerPublicId: owner, operation, code, occurredAt: new Date().toISOString(),
      pendingTaps: Math.min(100000, pendingTaps), occurrences: 1,
      ...(error instanceof ApiError ? { requestId: error.requestId, httpStatus: error.status } : {}) });
    localStorage.setItem(key(owner), JSON.stringify(items.slice(-50)));
  } catch { /* Reporting must never break gameplay or report its own failures. */ }
}
export async function flushIncidents(owner: string) {
  if (typeof navigator === "undefined" || !navigator.onLine || inFlight.has(owner) || Date.now() < (lastFailure.get(owner) ?? 0)) return;
  inFlight.add(owner);
  try {
    // A bounded burst; remaining records are retried on the next heartbeat.
    for (const item of read(owner).slice(0, 3)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch("/api/v1/client-incidents", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(item), signal: controller.signal });
        if (!response.ok) { lastFailure.set(owner, Date.now() + 60_000); return; }
        localStorage.setItem(key(owner), JSON.stringify(read(owner).filter(value => value.eventId !== item.eventId)));
      } finally { clearTimeout(timer); }
    }
  } catch { lastFailure.set(owner, Date.now() + 60_000); }
  finally { inFlight.delete(owner); }
}
