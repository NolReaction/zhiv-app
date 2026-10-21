import type { ResidentDiagnostic, ResidentDiagnostics } from "./forest-resident-diagnostics";
import { normalizeWorldDevSceneRequest, WORLD_DEV_SCENE_ACTORS, type WorldDevSceneActor,
  type WorldDevSceneRequest } from "./forest-scene-preview";

export const RESIDENT_JOURNAL_LIMITS = { seconds: 60, events: 120, bytes: 131_072 } as const;
export type ResidentJournalSettings = Readonly<Partial<{
  weather: "auto" | "clear" | "drizzle" | "rain" | "downpour"; timeOfDay: "auto" | "day" | "night";
  reducedMotion: "auto" | "on" | "off"; navigationMode: "auto" | "routes";
  butterflies: "auto" | "on" | "off"; birds: "auto" | "on" | "off"; autoLife: boolean; paused: boolean;
}>>;
export type ResidentDiagnosticContext = { owner?: object; paused?: boolean;
  settings?: ResidentJournalSettings; rehearsal?: WorldDevSceneRequest | null };
type Field = "goal" | "target" | "phase" | "blockingNeighbour" | "available";
type Change = Readonly<{ field: Field; before: string | boolean | null; after: string | boolean | null }>;
export type ResidentIncident = Readonly<{ id: number; at: number; actor: WorldDevSceneActor;
  kind: "initial" | "change" | "blocked" | "released" | "interruption"; inferred: boolean; changes: readonly Change[] }>;
export type ResidentJournalSnapshot = Readonly<{ recording: boolean; capture: number; source: "world" | "rehearsal" | null;
  elapsed: number | null; startedAt: number | null; events: readonly ResidentIncident[]; dropped: number }>;
type SafeResident = Omit<ResidentDiagnostic, "blockingNeighbour"> & { blockingNeighbour: WorldDevSceneActor | "obstacle" | null };
type Frame = Readonly<{ source: "world" | "rehearsal"; elapsed: number; residents: readonly SafeResident[];
  settings: ResidentJournalSettings; rehearsal: WorldDevSceneRequest | null }>;
export const EMPTY_RESIDENT_JOURNAL: ResidentJournalSnapshot = Object.freeze({ recording: false, capture: 0,
  source: null, elapsed: null, startedAt: null, events: Object.freeze([]), dropped: 0 });
const fields: readonly Field[] = ["goal", "target", "phase", "blockingNeighbour", "available"];
const actor = (value: unknown): value is WorldDevSceneActor => WORLD_DEV_SCENE_ACTORS.some(item => item.id === value);
const bounded = (value: number, maximum = 100_000) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(maximum, value)) * 10) / 10 : 0;
const text = (value: string, length = 96) => typeof value === "string" ? value
  .replace(/[\r\n\t<>]/g, " ").replace(/\bhttps?:\/\/\S+/gi, "[url]")
  .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[id]")
  .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
  .replace(/\b(?:owner|account|token|secret|password|authorization)[=:]\S+/gi, "[private]").slice(0, length) : "";

/** Explicit fields only: a caller may pass the full DEV store, but its account,
 * equipment, object editor, events and arbitrary extra properties never enter. */
export function residentJournalSettings(value: ResidentJournalSettings | undefined): ResidentJournalSettings {
  const result: Record<string, string | boolean> = {};
  const enums = { weather: ["auto", "clear", "drizzle", "rain", "downpour"], timeOfDay: ["auto", "day", "night"],
    reducedMotion: ["auto", "on", "off"], navigationMode: ["auto", "routes"], butterflies: ["auto", "on", "off"], birds: ["auto", "on", "off"] };
  if (value && typeof value === "object") {
    for (const [key, allowed] of Object.entries(enums)) {
      const entry = value[key as keyof ResidentJournalSettings];
      if (typeof entry === "string" && allowed.includes(entry)) result[key] = entry;
    }
    for (const key of ["autoLife", "paused"] as const) if (typeof value[key] === "boolean") result[key] = value[key]!;
  }
  return Object.freeze(result) as ResidentJournalSettings;
}
function frame(snapshot: ResidentDiagnostics, context: ResidentDiagnosticContext): Frame {
  const residents = snapshot.actors.filter(item => actor(item.id)).slice(0, 6).map(item => Object.freeze({
    id: item.id, available: Boolean(item.available), goal: text(item.goal), phase: text(item.phase, 72),
    target: text(item.target), reason: text(item.reason, 160), position: Object.freeze({
      x: Number.isFinite(item.position.x) ? Math.round(Math.max(-100_000, Math.min(100_000, item.position.x)) * 10) / 10 : 0,
      y: Number.isFinite(item.position.y) ? Math.round(Math.max(-100_000, Math.min(100_000, item.position.y)) * 10) / 10 : 0 }),
    remaining: bounded(item.remaining), routePoints: Math.trunc(bounded(item.routePoints, 2048)),
    blockingNeighbour: item.blockingNeighbour === null ? null : actor(item.blockingNeighbour) ? item.blockingNeighbour : "obstacle" as const,
  }));
  return Object.freeze({ source: snapshot.source.startsWith("dev:") ? "rehearsal" : "world", elapsed: bounded(snapshot.elapsed, 1_000_000_000),
    residents: Object.freeze(residents), settings: residentJournalSettings(context.settings),
    rehearsal: context.rehearsal ? normalizeWorldDevSceneRequest(context.rehearsal) : null });
}
function interrupted(previous: SafeResident, next: SafeResident): boolean {
  const moved = Math.hypot(next.position.x - previous.position.x, next.position.y - previous.position.y);
  const abandoned = previous.routePoints > 0 && previous.remaining > moved + 3
    && (previous.target !== next.target || next.routePoints === 0 && moved < 1 && previous.remaining > 8);
  const conversationToWork = previous.goal === "Встреча" && /^(?:Работ|Добыть|Доставить)/.test(next.goal);
  return abandoned || conversationToWork;
}

/** Kept only by the open DEV inspector. Actor feet are context, not journal
 * events: advancing along the same route produces no periodic position spam. */
export function createResidentIncidentJournal() {
  let view = EMPTY_RESIDENT_JOURNAL, latest: Frame | null = null, captured: Frame | null = null;
  let previous = new Map<WorldDevSceneActor, SafeResident>(), sequence = 0;
  function publish(patch: Partial<ResidentJournalSnapshot> = {}) {
    const point = captured ?? latest;
    view = Object.freeze({ ...view, source: point?.source ?? null, elapsed: point?.elapsed ?? null, ...patch });
  }
  function record(next: Frame) {
    const added: ResidentIncident[] = [];
    for (const resident of next.residents) {
      const before = previous.get(resident.id);
      const changes = fields.filter(field => !before || before[field] !== resident[field])
        .map(field => Object.freeze({ field, before: before?.[field] ?? null, after: resident[field] }));
      if (!changes.length) continue;
      const inferred = Boolean(before && interrupted(before, resident));
      const kind = !before ? "initial" : inferred ? "interruption" : resident.blockingNeighbour && !before.blockingNeighbour ? "blocked"
        : !resident.blockingNeighbour && before.blockingNeighbour ? "released" : "change";
      added.push(Object.freeze({ id: ++sequence, at: next.elapsed, actor: resident.id, kind, inferred, changes: Object.freeze(changes) }));
    }
    previous = new Map(next.residents.map(item => [item.id, item])); captured = next;
    const all = [...view.events, ...added], recent = all.filter(event => event.at >= next.elapsed - RESIDENT_JOURNAL_LIMITS.seconds)
      .slice(-RESIDENT_JOURNAL_LIMITS.events);
    publish({ events: Object.freeze(recent), dropped: view.dropped + all.length - recent.length });
  }
  return {
    getSnapshot: () => view,
    observe(snapshot: ResidentDiagnostics, context: ResidentDiagnosticContext, newCapture: boolean) {
      if (newCapture) {
        const recording = view.recording, capture = view.capture + 1;
        latest = captured = null; previous = new Map(); sequence = 0;
        view = Object.freeze({ ...EMPTY_RESIDENT_JOURNAL, recording, capture });
      }
      latest = frame(snapshot, context);
      if (view.recording) {
        if (view.startedAt === null) publish({ startedAt: latest.elapsed });
        record(latest);
      } else if (!captured) publish();
    },
    setRecording(recording: boolean) {
      if (recording === view.recording) return false;
      if (recording) {
        captured = null; previous = new Map(); sequence = 0;
        publish({ recording: true, capture: view.capture + 1, events: Object.freeze([]), dropped: 0, startedAt: latest?.elapsed ?? null });
        if (latest) record(latest);
      } else publish({ recording: false });
      return true;
    },
    clearEvents() {
      captured = null; previous = new Map(latest?.residents.map(item => [item.id, item]) ?? []); sequence = 0;
      publish({ capture: view.capture + 1, events: Object.freeze([]), dropped: 0, startedAt: view.recording ? latest?.elapsed ?? null : null });
    },
    reset(preserveRecording = false) {
      const recording = preserveRecording && view.recording, capture = view.capture;
      latest = captured = null; previous = new Map(); sequence = 0;
      view = Object.freeze({ ...EMPTY_RESIDENT_JOURNAL, recording, capture });
    },
    exportReport(): { filename: string; json: string } | null {
      const point = captured ?? latest; if (!point) return null;
      let events = view.events.slice(), omitted = 0;
      const report = () => JSON.stringify({ schemaVersion: 1, tool: "zhiv-resident-incidents",
        scene: { source: point.source, capture: view.capture, activeSeconds: point.elapsed },
        recording: view.recording, startedAt: view.startedAt,
        window: { seconds: RESIDENT_JOURNAL_LIMITS.seconds, maxEvents: RESIDENT_JOURNAL_LIMITS.events, dropped: view.dropped + omitted },
        context: { settings: point.settings, rehearsal: point.rehearsal }, residents: point.residents, events }, null, 2);
      let json = report();
      while (events.length && new TextEncoder().encode(json).byteLength > RESIDENT_JOURNAL_LIMITS.bytes) {
        events = events.slice(1); omitted++; json = report();
      }
      return { filename: `zhiv-residents-capture-${view.capture}.json`, json };
    },
  };
}
