import { ACTIVITY_IDLE_MS, ACTIVITY_LEASE_MS, type PresenceCommand, type PresenceView } from "@/features/activity/model";

type Row = { owner: string; authSession?: string; seen: number; input: number; sequence: number; kind: PresenceCommand["kind"]; active: boolean; suspended: boolean };
type Interval = { start: number; end: number };
type Store = { rows: Map<string, Row>; days: Map<string, Interval[]> };
const globalStore = globalThis as typeof globalThis & { __zhivDevPresence?: Store };
const store = (): Store => globalStore.__zhivDevPresence ??= { rows: new Map(), days: new Map() };
export class DevPresenceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
function status(row: Row, now: number): PresenceView["status"] {
  return row.suspended ? "suspended" : now - row.input >= ACTIVITY_IDLE_MS ? "idle" : now - row.seen >= ACTIVITY_LEASE_MS ? "disconnected" : "active";
}
function credit(owner: string, start: number, end: number) {
  while (start < end) {
    const day = new Date(start).toISOString().slice(0, 10), next = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    const until = Math.min(next, end), key = `${owner}:${day}`;
    const intervals = [...(store().days.get(key) ?? []), { start, end: until }].sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    store().days.set(key, merged); start = until;
  }
}
function view(id: string, row: Row, now: number): PresenceView {
  const intervals = store().days.get(`${row.owner}:${new Date(now).toISOString().slice(0, 10)}`) ?? [];
  return { presenceId: id, status: status(row, now), serverNow: new Date(now).toISOString(),
    idleExpiresAt: new Date(row.input + ACTIVITY_IDLE_MS).toISOString(), leaseExpiresAt: new Date(row.seen + ACTIVITY_LEASE_MS).toISOString(),
    onlineTodaySeconds: Math.floor(intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0) / 1000) };
}
export function commandDevPresence(owner: string, command: PresenceCommand, now = Date.now(), authSession?: string) {
  const data = store(), existing = data.rows.get(command.presenceId);
  if (existing && (existing.owner !== owner || existing.authSession !== authSession)) throw new DevPresenceError("GAME_SESSION_INACTIVE", "Игровая сессия недоступна");
  if (command.kind === "resume") {
    if (command.sequence !== 0 || !command.active) throw new DevPresenceError("INVALID_PRESENCE_COMMAND", "Некорректный запрос подключения", 400);
    if (existing) return view(command.presenceId, existing, now);
    const row: Row = { owner, authSession, seen: now, input: now, sequence: 0, kind: "resume", active: true, suspended: false };
    data.rows.set(command.presenceId, row);
    return view(command.presenceId, row, now);
  }
  if (!existing) throw new DevPresenceError("GAME_SESSION_INACTIVE", "Подключитесь к игре заново");
  if (command.sequence < 1) throw new DevPresenceError("INVALID_PRESENCE_COMMAND", "Некорректный номер запроса", 400);
  if (command.sequence < existing.sequence) return view(command.presenceId, existing, now);
  if (command.sequence === existing.sequence) {
    if (command.kind !== existing.kind || command.active !== existing.active) throw new DevPresenceError("PRESENCE_SEQUENCE_CONFLICT", "Номер запроса уже использован");
    return view(command.presenceId, existing, now);
  }
  const currentStatus = status(existing, now);
  if (currentStatus !== "active") {
    if (!existing.suspended && now - existing.seen < ACTIVITY_LEASE_MS) {
      credit(owner, existing.seen, Math.min(now, existing.input + ACTIVITY_IDLE_MS));
    }
    return view(command.presenceId, existing, now);
  }
  credit(owner, existing.seen, now);
  existing.seen = now; if (command.active) existing.input = now;
  existing.sequence = command.sequence; existing.kind = command.kind; existing.active = command.active;
  existing.suspended = command.kind === "suspend";
  return view(command.presenceId, existing, now);
}
export function isDevPresenceActive(owner: string, id: string | null, now = Date.now(), authSession?: string) {
  const row = id ? store().rows.get(id) : null;
  return Boolean(row && row.owner === owner && row.authSession === authSession && status(row, now) === "active");
}
