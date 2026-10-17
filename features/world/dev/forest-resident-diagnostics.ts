import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { WorldPoint } from "@/features/world/tiled/types";
import { canTraverseResidents, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { FOREST_VILLAGER_PROFILES } from "@/features/world/characters/villagers/villager-navigation";
import { PLESK } from "@/features/world/characters/plesk/plesk-resident";
import { BUILDER } from "@/features/world/characters/builder/builder-types";
import type { WorldDevSceneActor } from "./forest-scene-preview";

export type ResidentDiagnostic = Readonly<{
  id: WorldDevSceneActor; available: boolean; goal: string; phase: string; target: string; reason: string;
  position: Readonly<WorldPoint>; remaining: number; routePoints: number; blockingNeighbour: string | null;
}>;
export type ResidentDiagnostics = Readonly<{ source: string; elapsed: number; actors: readonly ResidentDiagnostic[] }>;
const empty: ResidentDiagnostics | null = null;
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
  let current: ResidentDiagnostics | null = null, nextAt = 0, lastSource = "";
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    getServerSnapshot: () => empty,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Call from the current scene owner. Without an open inspector this is a
     * constant-time no-op; at most two detached snapshots per active second. */
    report(state: ForestSessionState, occupants: readonly ResidentOccupant[], source: string, enabled: boolean) {
      if (!enabled || !listeners.size || source === lastSource && state.elapsed < nextAt) return;
      lastSource = source; nextAt = state.elapsed + .5; current = forestResidentDiagnostics(state, occupants, source);
      for (const listener of [...listeners]) listener();
    },
    clear(source: string) {
      if (current?.source !== source) return;
      current = null; nextAt = 0; lastSource = ""; for (const listener of [...listeners]) listener();
    },
  };
}
export const residentDiagnosticsStore = createResidentDiagnosticsStore();
