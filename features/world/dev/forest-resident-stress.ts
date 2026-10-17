import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { canTraverse, findWorldPath, isWalkable } from "@/features/world/navigation/navigation";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { forestVillagerPlaces } from "@/features/world/characters/villagers/villager-navigation";
import { noticeForestVillager, requestForestVillagerHome } from "@/features/world/characters/villagers/villager-mind";
import { selectVillagerRoute } from "@/features/world/characters/villagers/villager-movement";
import { beginWoodcutterCycle } from "@/features/world/characters/villagers/woodcutter-cycle";
import { requestForestSocialVisit, type ForestSocialEnvironment } from "@/features/world/characters/social/forest-social";
import { syncForestResidentAccess } from "@/features/world/state/economy/economy-residents-state";
import { syncForestProduction } from "@/features/world/state/economy/economy-production-state";
import type { WorldDevSceneRequest } from "./forest-scene-preview";

export type ResidentStress = { phase: "prepare" | "carry-approach" | "narrow-approach" | "staging" | "crossing" | "blocked-door" | "clearing-door" | "hauling" | "talking" | "working";
  goals?: readonly [WorldPoint, WorldPoint]; nextAt?: number; meetingAttempts?: number; since: number; sawCarry: boolean; sawBlockedDoor: boolean; initialCycles: number; workStarted: boolean };
export type StressResult = { status: "running" | "complete" | "blocked"; message: string };
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const done = (message: string): StressResult => ({ status: "complete", message });
const running = (message: string): StressResult => ({ status: "running", message });
const blocked = (message: string): StressResult => ({ status: "blocked", message });
export const isResidentStress = (scenario: string) => ["narrow-passing", "occupied-door", "carry-crossing", "work-interruption"].includes(scenario);

function move(state: ForestSessionState, scene: FixedWorldScene, id: "lopukh" | "kamneshmyg", goal: WorldPoint,
  occupants: readonly ResidentOccupant[]): boolean {
  const mind = state.villagers?.residents[id], places = forestVillagerPlaces(scene, id);
  return Boolean(mind && places && selectVillagerRoute(mind, places, [{ id: `dev-stress:${id}`, position: goal, lookAt: goal }], "wander", "inspect", occupants));
}
function hold(state: ForestSessionState) {
  for (const id of ["lopukh", "kamneshmyg"] as const) {
    const mind = state.villagers?.residents[id]; if (!mind) continue;
    mind.outdoorUntil = Math.max(mind.outdoorUntil, mind.elapsed + 120);
    if (!mind.route && !mind.job && (!mind.woodwork || ["idle", "rest"].includes(mind.woodwork.phase))) mind.wait = Math.max(mind.wait, 3);
  }
}
/** Sample real shared ground. A narrow segment is selected from the actual
 * path and scored by perpendicular clearance, never by invented colliders. */
export function residentStressPassage(scene: FixedWorldScene, from: WorldPoint, to: WorldPoint): readonly [WorldPoint, WorldPoint] | null {
  const a = forestVillagerPlaces(scene, "lopukh"), b = forestVillagerPlaces(scene, "kamneshmyg");
  if (!a || !b) return null;
  const path = findWorldPath(a.navigation, from, to); if (!path) return null;
  const choices: { goals: readonly [WorldPoint, WorldPoint]; width: number; order: number }[] = [];
  for (let index = 1; index < path.length; index++) {
    const first = path[index - 1], last = path[index], length = distance(first, last);
    if (length < 72) continue;
    const dx = (last.x - first.x) / length, dy = (last.y - first.y) / length;
    const center = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
    const goals = [{ x: center.x - dx * 36, y: center.y - dy * 36 }, { x: center.x + dx * 36, y: center.y + dy * 36 }] as const;
    if (![a, b].every(places => canTraverse(places.navigation, goals[0], goals[1]))) continue;
    let width = 0;
    for (const side of [-1, 1]) for (const offset of [8, 16, 24, 32, 48, 64]) {
      const point = { x: center.x - dy * offset * side, y: center.y + dx * offset * side };
      if (![a, b].every(places => isWalkable(places.navigation, point))) break;
      width += 8;
    }
    choices.push({ goals, width, order: index });
  }
  return choices.sort((a, b) => a.width - b.width || a.order - b.order)[0]?.goals ?? null;
}
function injectWork(state: ForestSessionState, request: WorldDevSceneRequest, now: number): boolean {
  const access = state.economyResidents; if (!access || !access.ownerPublicId.startsWith("dev-scene-")) return false;
  const revision = access.revision + 1, stationId = request.actor === "lopukh" ? "woodlot" : "quarry";
  const production = { ownerPublicId: access.ownerPublicId, revision, jobs: [{ id: `dev-interruption-${request.id}`, stationId, stationLevel: 1,
    recipeId: stationId === "woodlot" ? "woodlot_wood" : "quarry_stone", startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 120_000).toISOString() }] };
  syncForestProduction(state, production); return syncForestResidentAccess(state, { ...access, revision, production });
}

/** Only finite commands to the normal movement/home/social/production
 * controllers. Setup walks are visible, no actor is repositioned or spawned. */
export function advanceResidentStress(state: ForestSessionState, scene: FixedWorldScene, request: WorldDevSceneRequest, stress: ResidentStress,
  environment: { occupants: readonly ResidentOccupant[]; social: ForestSocialEnvironment; now: number }): StressResult {
  const bunny = state.villagers?.residents.lopukh, mole = state.villagers?.residents.kamneshmyg;
  if (!bunny?.available || !mole?.available) return blocked("Нужны открытые Лопоух и Камнешмыг.");
  hold(state);
  if (request.scenario === "work-interruption") {
    // This rehearsal owns one chosen pair. Finishing a lost approach must not
    // enable an unrelated ambient exchange to replace the result under test.
    state.social.nextEncounterAt = Math.max(state.social.nextEncounterAt, state.social.elapsed + 120);
    state.social.nextPassingAt = Math.max(state.social.nextPassingAt ?? 0, state.social.elapsed + 120);
  }
  if (stress.phase === "prepare") {
    for (const id of ["lopukh", "kamneshmyg"] as const) if (state.villagers!.residents[id].doorPhase !== "outside") {
      noticeForestVillager(state.villagers!, id); return running("Участники выходят из своих домов.");
    }
    if (bunny.job || mole.job || bunny.route || mole.route) return running("Участники заканчивают прежний безопасный переход.");
    if (request.scenario === "work-interruption") {
      if ((stress.meetingAttempts ?? 0) >= 3) return blocked("Выбранная пара не смогла закончить подход за три попытки.");
      if (!requestForestSocialVisit(state.social, request.actor, request.target!, environment.social)) return running("Ждёт готовности собеседника.");
      stress.meetingAttempts = (stress.meetingAttempts ?? 0) + 1;
      stress.phase = "talking";
      return running("Жители встречаются и начинают настоящий разговор.");
    }
    const places = forestVillagerPlaces(scene, "lopukh");
    const goals = request.scenario === "occupied-door" ? places?.door && [places.door.approach.position, { ...mole.position }] as const
      : request.scenario === "carry-crossing" ? places?.woodcutting && [places.woodcutting.delivery[0].position, places.woodcutting.work[2]?.position ?? places.woodcutting.work[0].position] as const
        : residentStressPassage(scene, bunny.position, mole.position);
    if (!goals) return blocked("Не найден доступный участок настоящей карты для этой проверки.");
    stress.goals = goals;
    if (request.scenario === "carry-crossing") {
      if (!move(state, scene, "lopukh", goals[1], environment.occupants)) return running("Ждёт доступное дальнее дерево.");
      stress.phase = "carry-approach"; return running("Лопоух идёт к дальнему дереву перед встречной переноской.");
    }
    if (request.scenario === "narrow-passing") {
      if (!move(state, scene, "lopukh", goals[1], environment.occupants)) return running("Ждёт свободный второй подход.");
      stress.phase = "narrow-approach"; return running("Лопоух подходит к дальнему концу выбранного участка.");
    }
    if (!move(state, scene, "kamneshmyg", goals[0], environment.occupants)) return running("Ждёт свободный подход Камнешмыга к началу проверки.");
    stress.phase = "staging"; return running("Участники идут к стартовым точкам по настоящим путям.");
  }
  if (stress.phase === "carry-approach" || stress.phase === "narrow-approach") {
    if (bunny.route) return running("Лопоух подходит к дальнему дереву.");
    if (!move(state, scene, "kamneshmyg", stress.goals![0], environment.occupants)) return running("Ждёт свободную площадку перед домом.");
    stress.phase = "staging"; return running("Камнешмыг подходит ко второму концу будущей переноски.");
  }
  if (stress.phase === "staging") {
    if (mole.route || request.scenario === "narrow-passing" && bunny.route) return running("Участники подходят к месту проверки.");
    if (distance(mole.position, stress.goals![0]) > 1) return blocked("Камнешмыг не смог дойти к стартовой точке.");
    if (request.scenario === "occupied-door") {
      if (requestForestVillagerHome(state.villagers!, scene, "lopukh", environment.occupants)) return blocked("Вход не оказался занят: проверьте положение порога.");
      stress.sawBlockedDoor = true; stress.phase = "blocked-door"; stress.since = state.elapsed;
      return running("Сосед стоит у входа. Лопоух корректно ждёт освобождения двери.");
    }
    if (request.scenario === "carry-crossing") {
      const places = forestVillagerPlaces(scene, "lopukh")!;
      if (!beginWoodcutterCycle(bunny, places, environment.occupants, { chopSeconds: 0, workIndex: 2 })) return blocked("Недоступно дерево для переноски.");
      stress.initialCycles = bunny.woodwork!.completedCycles; stress.phase = "hauling";
      return running("Лопоух идёт к дальнему дереву; сосед ждёт начала переноски.");
    }
    if (distance(bunny.position, stress.goals![1]) > 1) {
      move(state, scene, "lopukh", stress.goals![1], environment.occupants);
      return running("Лопоух уступил подход соседу и возвращается к стартовой точке.");
    }
    if (!move(state, scene, "lopukh", stress.goals![0], environment.occupants.filter(other => other.id !== "kamneshmyg"))
      || !move(state, scene, "kamneshmyg", stress.goals![1], environment.occupants.filter(other => other.id !== "lopukh"))) return blocked("Не удалось запросить два встречных пути.");
    stress.phase = "crossing"; return running("Оба жителя идут навстречу; проверяем живой обход и сохранение целей.");
  }
  if (stress.phase === "crossing") return !bunny.route && !mole.route && distance(bunny.position, stress.goals![0]) <= 1 && distance(mole.position, stress.goals![1]) <= 1
    ? done("Оба жителя прошли встречный участок и дошли до своих целей.") : running("Идут навстречу, ждут или обходят друг друга.");
  if (stress.phase === "blocked-door" && state.elapsed - stress.since >= 3) {
    if (move(state, scene, "kamneshmyg", stress.goals![1], environment.occupants)) stress.phase = "clearing-door";
  }
  if (stress.phase === "clearing-door") {
    if (bunny.doorPhase === "inside") return done("Занятая дверь удержала вход. После ухода соседа Лопоух вошёл домой.");
    if (bunny.doorPhase === "outside") requestForestVillagerHome(state.villagers!, scene, "lopukh", environment.occupants);
    return running("Сосед освобождает вход; Лопоух проходит через настоящий порог.");
  }
  if (stress.phase === "hauling") {
    if (bunny.woodwork?.phase === "haul" && !stress.sawCarry) {
      stress.sawCarry = true;
      if (!move(state, scene, "kamneshmyg", stress.goals![1], environment.occupants.filter(other => other.id !== "lopukh"))) return blocked("Соседу не найден обратный путь.");
    }
    if (stress.sawCarry && (bunny.woodwork?.completedCycles ?? 0) > stress.initialCycles && !mole.route)
      return done("Лопоух пронёс бревно навстречу соседу, разгрузил и закончил цикл.");
    return running(stress.sawCarry ? "Бревно и сосед движутся встречными путями." : "Лопоух подходит к дереву.");
  }
  if (stress.phase === "talking") {
    const meeting = state.social.meeting;
    const intended = meeting?.guest === request.actor && meeting.host === request.target;
    if (!intended) {
      // The rehearsal wrapper already schedules this controller every .8s.
      // nextAt belongs to that wrapper and has just been moved into the future.
      stress.phase = "prepare";
      return running("Прежний подход прерван; повторяет встречу выбранной пары.");
    }
    if (meeting.phase === "talk" && state.social.current
      && [request.actor, request.target].includes(state.social.current.speaker)) {
      if (!injectWork(state, request, environment.now)) return blocked("Тестовое поручение разрешено только в изолированной DEV-копии.");
      stress.workStarted = true; stress.phase = "working"; return running("Во время беседы пришло тестовое рабочее поручение.");
    }
    return running("Выбранные жители подходят друг к другу перед разговором.");
  }
  if (stress.phase === "working") {
    const worker = state.villagers!.residents[request.actor as "lopukh" | "kamneshmyg"];
    if (worker.job && !state.social.meeting && (worker.action === "work" || worker.doorPhase === "inside"))
      return done("Рабочее поручение прервало беседу; житель дошёл до работы.");
    return running("Беседа уступает работе, житель идёт выполнять поручение.");
  }
  return running("Проверяет, что занятый порог удерживает вход.");
}
