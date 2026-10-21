import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { WorldPoint } from "@/features/world/tiled/types";
import { canTraverseResidents, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { FOREST_VILLAGER_PROFILES } from "@/features/world/characters/villagers/villager-navigation";
import { PLESK } from "@/features/world/characters/plesk/plesk-resident";
import { BUILDER } from "@/features/world/characters/builder/builder-types";
import type { WorldDevSceneActor } from "./forest-scene-preview";
import { createResidentIncidentJournal, EMPTY_RESIDENT_JOURNAL, type ResidentDiagnosticContext,
  type ResidentJournalSnapshot } from "./resident-incident-journal";
export type { ResidentDiagnosticContext } from "./resident-incident-journal";

export type ResidentDiagnostic = Readonly<{
  id: WorldDevSceneActor; available: boolean; goal: string; phase: string; target: string; reason: string;
  position: Readonly<WorldPoint>; remaining: number; routePoints: number; blockingNeighbour: string | null;
}>;
export type ResidentDiagnostics = Readonly<{ source: string; elapsed: number; actors: readonly ResidentDiagnostic[] }>;
const empty: ResidentDiagnostics | null = null;
export type ResidentDiagnosticsView = Readonly<{ diagnostics: ResidentDiagnostics | null; journal: ResidentJournalSnapshot }>;
const emptyView: ResidentDiagnosticsView = Object.freeze({ diagnostics: null, journal: EMPTY_RESIDENT_JOURNAL });
const round = (value: number) => Math.round(value * 10) / 10;
const intents: Record<string, string> = { work: "Работа", home: "Домой", wander: "Прогулка", social: "Встреча", yield: "Уступает дорогу",
  fish: "Рыбалка", trade: "Торговля", rest: "Отдых", look: "Осмотр", greet: "Приветствие", tackle: "Проверка снастей", walk: "Прогулка" };

function snapshot(input: { id: WorldDevSceneActor; available: boolean; goal: string; phase: string; target?: string;
  reason: string; position: WorldPoint; size: number; points?: readonly WorldPoint[]; length?: number; progress?: number;
  waiting?: boolean }, occupants: readonly ResidentOccupant[]): ResidentDiagnostic {
  let walked = 0;
  const next = input.points?.find((point, index, points) => {
    if (index) walked += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    return walked > (input.progress ?? 0) + 1;
  }) ?? input.position;
  const blocker = input.waiting ? occupants.filter(other => other.id !== input.id
    && !canTraverseResidents(input.position, next, input.size, [other], input.id))
    .sort((a, b) => Math.hypot(a.position.x - input.position.x, a.position.y - input.position.y)
      - Math.hypot(b.position.x - input.position.x, b.position.y - input.position.y))[0] : null;
  return Object.freeze({ id: input.id, available: input.available, goal: intents[input.goal] ?? input.goal, phase: input.phase,
    target: input.target ?? "—", reason: input.reason, position: Object.freeze({ x: round(input.position.x), y: round(input.position.y) }),
    remaining: round(Math.max(0, (input.length ?? 0) - (input.progress ?? 0))), routePoints: input.points?.length ?? 0,
    blockingNeighbour: blocker?.id ?? null });
}

/** Read-only detached samples: no path search, AI choice or account mutation.
 * A waiting flag alone is never blamed on an arbitrary nearby resident. */
export function forestResidentDiagnostics(state: ForestSessionState, occupants: readonly ResidentOccupant[], source: string): ResidentDiagnostics {
  const actors: ResidentDiagnostic[] = [], hero = state.clearing;
  const route = hero.freeRoute ?? (hero.routeKind === "home" ? hero.homeRoute : hero.routes[hero.routeIndex]);
  actors.push(snapshot({ id: "mochlik", available: true, goal: state.director.reason, phase: hero.stage,
    target: hero.requestedPoint ? "Выбранная точка" : route?.id, reason: state.director.reason, position: hero.position,
    size: hero.size, points: route?.points, length: route?.length, progress: hero.distance }, occupants));
  const plesk = state.pleskMind;
  if (plesk) actors.push(snapshot({ id: "plesk", available: plesk.available, goal: plesk.home.phase === "outside" ? plesk.intent : "Домашние дела",
    phase: plesk.home.phase === "outside" ? plesk.stage.action : `Дом: ${plesk.home.phase}`, target: plesk.stage.target.id,
    reason: plesk.reason, position: plesk.position, size: PLESK.size, points: plesk.stage.trail?.points,
    length: plesk.stage.trail?.length, progress: plesk.stage.trail ? plesk.stage.trail.length * Math.min(1, plesk.age / plesk.stage.duration) : 0,
    waiting: plesk.trafficWaiting }, occupants));
  const builder = state.builderMind;
  if (builder) actors.push(snapshot({ id: "builder", available: builder.available, goal: builder.job ? "work" : builder.sleepPhase !== "awake" ? "Домашний отдых" : builder.socialVisit ? "social" : builder.route ? "wander" : "rest",
    phase: builder.sleepPhase === "awake" ? builder.action : `Дом: ${builder.sleepPhase}`, target: builder.target?.id,
    reason: builder.trafficWaiting ? "Путь занят; ждёт или ищет обход" : builder.blocked ? "Не найден подходящий путь"
      : builder.job ? "Выполняет строительное поручение" : builder.socialVisit ? "Идёт к выбранному соседу" : "Свободное занятие",
    position: builder.position, size: BUILDER.size, points: builder.route?.points, length: builder.route?.length,
    progress: builder.distance, waiting: builder.trafficWaiting }, occupants));
  for (const id of ["lopukh", "kamneshmyg", "leaftail"] as const) {
    const mind = state.villagers?.residents[id]; if (!mind) continue;
    const workGoals = { idle: "work", chop: "Добыть древесину", haul: "Доставить бревно", unload: "Сложить бревно", rest: "Отдохнуть после переноски" };
    actors.push(snapshot({ id, available: mind.available, goal: mind.doorPhase !== "outside" ? mind.job ? "Работа в пещере" : "Домашние дела"
      : mind.woodwork && mind.woodwork.phase !== "idle" ? workGoals[mind.woodwork.phase] : mind.intent,
      phase: mind.doorPhase === "outside" ? mind.woodwork && mind.woodwork.phase !== "idle" ? `${mind.action} · ${mind.woodwork.phase}` : mind.action : `Дом: ${mind.doorPhase}`,
      target: mind.target?.id, reason: !mind.available ? "Пока не открыт" : mind.trafficWaiting ? "Путь занят; ждёт или ищет обход"
        : mind.doorPhase === "inside" ? "Занимается делами внутри" : mind.job ? "Выполняет рабочее поручение"
          : mind.socialVisit ? "Идёт к выбранному соседу" : mind.intent === "yield" ? "Освобождает проход" : "Свободное занятие",
      position: mind.position, size: FOREST_VILLAGER_PROFILES[id].size, points: mind.route?.points,
      length: mind.route?.length, progress: mind.distance, waiting: mind.trafficWaiting }, occupants));
  }
  return Object.freeze({ source, elapsed: round(state.elapsed), actors: Object.freeze(actors) });
}

export function createResidentDiagnosticsStore() {
  let current: ResidentDiagnostics | null = null, nextAt = 0, lastSource = "", owner: object | undefined;
  let acceptedElapsed: number | null = null;
  let view = emptyView;
  const journal = createResidentIncidentJournal();
  const listeners = new Set<() => void>();
  const publish = () => {
    view = Object.freeze({ diagnostics: current, journal: journal.getSnapshot() });
    for (const listener of [...listeners]) listener();
  };
  const reset = (preserveRecording: boolean) => {
    current = null; nextAt = 0; acceptedElapsed = null; lastSource = ""; owner = undefined; journal.reset(preserveRecording);
    view = Object.freeze({ diagnostics: null, journal: journal.getSnapshot() });
  };
  return {
    getSnapshot: () => current,
    getServerSnapshot: () => empty,
    getViewSnapshot: () => view,
    getServerViewSnapshot: () => emptyView,
    isObserved: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) reset(false); };
    },
    /** Call from the current scene owner. Without an open inspector this is a
     * constant-time no-op; at most two detached snapshots per active second. */
    report(state: ForestSessionState, occupants: readonly ResidentOccupant[], source: string, enabled: boolean,
      context: ResidentDiagnosticContext = {}) {
      if (!enabled || !listeners.size || context.paused) return;
      const elapsed = state.elapsed;
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      const identity = context.owner ?? state;
      // Display samples round their clock. Ownership and throttling must use
      // the raw accepted time, or repeated .55s would look earlier than .6s.
      const newCapture = source !== lastSource || identity !== owner || acceptedElapsed !== null && elapsed < acceptedElapsed - 1e-7;
      if (!newCapture && elapsed < nextAt) return;
      lastSource = source; owner = identity; acceptedElapsed = elapsed; nextAt = elapsed + .5;
      current = forestResidentDiagnostics(state, occupants, source);
      journal.observe(current, context, newCapture); publish();
    },
    setRecording(recording: boolean) {
      if (!listeners.size || typeof recording !== "boolean" || !journal.setRecording(recording)) return;
      publish();
    },
    clearJournal() { if (listeners.size) { journal.clearEvents(); publish(); } },
    exportReport: () => journal.exportReport(),
    clear(source: string, identity?: object) {
      if (current?.source !== source || identity !== undefined && identity !== owner) return;
      reset(true); publish();
    },
  };
}
export const residentDiagnosticsStore = createResidentDiagnosticsStore();
