export const CLICKER_IDLE_RESET_MS = 30_000;
export const CLICKER_MAX_TAP_COUNT = 100_000;

export const CLICKER_MILESTONES = [
  1, 5, 10, 20, 50, 100, 500, 1_000, 10_000, 100_000,
] as const;

export type ClickerMilestone = (typeof CLICKER_MILESTONES)[number];
export type ClickerEffect =
  | "confetti"
  | "rings"
  | "sparks"
  | "finale"
  | "orbit"
  | "comet"
  | "legend"
  | "champion";

type ClickerScene = { at: ClickerMilestone; message: string };

export type ClickerStory = {
  id: string;
  title: string;
  scenes: readonly ClickerScene[];
};

export type ClickerActiveSeries = {
  eventId: string | null;
  tapCount: number;
  startedAtMs: number;
  lastTapAtMs: number;
  storyId: string;
};

export type ClickerProgress = {
  lifetimeTaps: number;
  bestSeries: number;
  completedSeries: number;
  storySeed: number;
  lastStoryId: string | null;
  activeSeries: ClickerActiveSeries | null;
  updatedAtMs: number;
};

export type ClickerFinishedSeries = {
  eventId: string | null;
  tapCount: number;
  durationMs: number;
  storyId: string;
  isRecord: boolean;
};

export type ClickerRun = ClickerProgress;
export type ClickerTapPlan = "ADVANCE_LOCAL" | "START_LOCAL" | "REQUEST_SERVER";

export type ClickerLevel = {
  level: number;
  title: string;
  minimumLifetimeTaps: number;
  nextMinimumLifetimeTaps: number | null;
};

export type ClickerLevelProgress = {
  current: number;
  minimum: number;
  maximum: number;
  ratio: number;
  remaining: number;
};

export type ClickerFrame = {
  storyId: string;
  storyTitle: string;
  tapCount: number;
  message: string;
  nextMilestone: ClickerMilestone | null;
  level: ClickerLevel;
};

export type ClickerExpiry = {
  progress: ClickerProgress;
  finishedSeries: ClickerFinishedSeries | null;
};

export type ClickerSeriesTimer = {
  remainingMs: number;
  remainingRatio: number;
};

export type ClickerAdvance = ClickerExpiry & {
  crossedMilestones: readonly ClickerMilestone[];
  effect: ClickerEffect | null;
  levelBefore: ClickerLevel;
  levelAfter: ClickerLevel;
};

// Retain the v3 progress shape so existing tap counts survive the update.
// Narrative content was removed in 0.4.6; only a neutral series remains.
export const CLICKER_STORIES: readonly ClickerStory[] = [{
  id: "clicker",
  title: "Серия",
  scenes: CLICKER_MILESTONES.map(at => ({at, message: "Нажатий в серии: " + at})),
}];

export const CLICKER_LEVELS = [
  { level: 1, title: "Новичок", minimumLifetimeTaps: 0 },
  { level: 2, title: "Искра", minimumLifetimeTaps: 10 },
  { level: 3, title: "Ритм", minimumLifetimeTaps: 25 },
  { level: 4, title: "Импульс", minimumLifetimeTaps: 50 },
  { level: 5, title: "Сотник", minimumLifetimeTaps: 100 },
  { level: 6, title: "Разгон", minimumLifetimeTaps: 250 },
  { level: 7, title: "Марафонец", minimumLifetimeTaps: 500 },
  { level: 8, title: "Тысячник", minimumLifetimeTaps: 1_000 },
  { level: 9, title: "Титан", minimumLifetimeTaps: 2_500 },
  { level: 10, title: "Чемпион", minimumLifetimeTaps: 5_000 },
] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MILESTONE_EFFECTS = new Map<ClickerMilestone, ClickerEffect>([
  [5, "confetti"], [20, "rings"], [50, "sparks"], [100, "finale"],
  [500, "orbit"], [1_000, "comet"], [10_000, "legend"], [100_000, "champion"],
]);

function normalizeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, CLICKER_MAX_TAP_COUNT);
}

function normalizeLifetimeTaps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function addLifetimeTaps(value: number, steps: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, normalizeLifetimeTaps(value) + steps);
}

function normalizeCompletedSeries(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeSeed(value: number): number {
  return Number.isSafeInteger(value) ? value >>> 0 : 0;
}

// Keep identifiers, not story content, so 0.4.5 counters/active series survive the upgrade.
export const LEGACY_CLICKER_STORY_IDS: readonly string[] = ["space","lab","hike","arcade","garden","ocean","magic","time","cinema","future","observatory","bakery","detective","orchestra","express","lighthouse","robots","polar","library","weather","radio","museum","dragons","volcano"];
function storyById(storyId: string): ClickerStory | null {
  return storyId === "clicker" || LEGACY_CLICKER_STORY_IDS.includes(storyId) ? CLICKER_STORIES[0] : null;
}

export function clickerSeedFromPublicId(publicId: string): number {
  let hash = 0x811c9dc5;
  for (const character of publicId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getStoryForSeries(_storySeed: number, _completedSeries: number): ClickerStory {
  void _storySeed; void _completedSeries;
  // Parameters belong to the persisted legacy contract, not a story selector.
  return CLICKER_STORIES[0];
}

export function getClickerLevel(lifetimeTaps: number): ClickerLevel {
  const lifetime = normalizeLifetimeTaps(lifetimeTaps);
  let current: (typeof CLICKER_LEVELS)[number] = CLICKER_LEVELS[0];
  let nextMinimumLifetimeTaps: number | null = CLICKER_LEVELS[1]?.minimumLifetimeTaps ?? null;
  for (let index = 0; index < CLICKER_LEVELS.length; index += 1) {
    const candidate = CLICKER_LEVELS[index];
    if (candidate.minimumLifetimeTaps > lifetime) break;
    current = candidate;
    nextMinimumLifetimeTaps = CLICKER_LEVELS[index + 1]?.minimumLifetimeTaps ?? null;
  }
  return { ...current, nextMinimumLifetimeTaps };
}

export function getClickerLevelProgress(lifetimeTaps: number): ClickerLevelProgress {
  const current = normalizeLifetimeTaps(lifetimeTaps);
  const level = getClickerLevel(current);
  const minimum = level.minimumLifetimeTaps;
  const maximum = level.nextMinimumLifetimeTaps ?? minimum;
  if (level.nextMinimumLifetimeTaps === null) {
    return { current, minimum, maximum, ratio: 1, remaining: 0 };
  }
  const span = Math.max(1, maximum - minimum);
  return {
    current,
    minimum,
    maximum,
    ratio: Math.min(1, Math.max(0, (current - minimum) / span)),
    remaining: Math.max(0, maximum - current),
  };
}

export function createClickerRun(storySeed = 0): ClickerProgress {
  return {
    lifetimeTaps: 0,
    bestSeries: 0,
    completedSeries: 0,
    storySeed: normalizeSeed(storySeed),
    lastStoryId: null,
    activeSeries: null,
    updatedAtMs: 0,
  };
}

export function getNextClickerMilestone(tapCount: number): ClickerMilestone | null {
  const count = normalizeCount(tapCount);
  return CLICKER_MILESTONES.find((milestone) => milestone > count) ?? null;
}

export function getClickerSeriesTimer(
  progress: ClickerProgress,
  nowMs = Date.now(),
): ClickerSeriesTimer {
  const active = progress.activeSeries;
  if (!active) return { remainingMs: 0, remainingRatio: 0 };
  const remainingMs = Math.min(
    CLICKER_IDLE_RESET_MS,
    Math.max(0, active.lastTapAtMs + CLICKER_IDLE_RESET_MS - nowMs),
  );
  return {
    remainingMs,
    remainingRatio: remainingMs / CLICKER_IDLE_RESET_MS,
  };
}

export function expireClickerSeries(
  progress: ClickerProgress,
  nowMs = Date.now(),
): ClickerExpiry {
  const active = progress.activeSeries;
  if (!active) return { progress, finishedSeries: null };
  const elapsed = nowMs - active.lastTapAtMs;
  if (elapsed >= 0 && elapsed < CLICKER_IDLE_RESET_MS) {
    return { progress, finishedSeries: null };
  }
  const tapCount = normalizeCount(active.tapCount);
  const next: ClickerProgress = {
    ...progress,
    bestSeries: Math.max(normalizeCount(progress.bestSeries), tapCount),
    completedSeries: normalizeCompletedSeries(progress.completedSeries) + 1,
    lastStoryId: active.storyId,
    activeSeries: null,
    updatedAtMs: Math.max(0, nowMs),
  };
  return {
    progress: next,
    finishedSeries: {
      eventId: active.eventId,
      tapCount,
      durationMs: Math.max(0, active.lastTapAtMs - active.startedAtMs),
      storyId: active.storyId,
      isRecord: tapCount >= normalizeCount(progress.bestSeries),
    },
  };
}

export function getClickerTransitionEffect(fromTap: number, toTap: number): ClickerEffect | null {
  const from = normalizeCount(fromTap);
  const to = normalizeCount(toTap);
  if (to <= from) return null;
  let effect: ClickerEffect | null = null;
  for (const milestone of CLICKER_MILESTONES) {
    if (milestone > from && milestone <= to) effect = MILESTONE_EFFECTS.get(milestone) ?? effect;
  }
  return effect;
}

export function advanceClickerRun(
  progress: ClickerProgress,
  nowMs = Date.now(),
  steps = 1,
  eventId: string | null = null,
): ClickerAdvance {
  const expired = expireClickerSeries(progress, nowMs);
  const current = expired.progress;
  const levelBefore = getClickerLevel(current.lifetimeTaps);
  const safeSteps = Number.isSafeInteger(steps) ? Math.max(1, steps) : 1;
  const currentTapCount = current.activeSeries?.tapCount ?? 0;
  const nextTapCount = Math.min(currentTapCount + safeSteps, CLICKER_MAX_TAP_COUNT);
  const story = current.activeSeries
    ? storyById(current.activeSeries.storyId)
      ?? getStoryForSeries(current.storySeed, current.completedSeries)
    : getStoryForSeries(current.storySeed, current.completedSeries);
  const activeSeries: ClickerActiveSeries = current.activeSeries
    ? { ...current.activeSeries, tapCount: nextTapCount, lastTapAtMs: nowMs, storyId: story.id }
    : { eventId, tapCount: nextTapCount, startedAtMs: nowMs, lastTapAtMs: nowMs, storyId: story.id };
  const bestSeries = Math.max(normalizeCount(current.bestSeries), nextTapCount);
  const lifetimeTaps = addLifetimeTaps(current.lifetimeTaps, safeSteps);
  const crossedMilestones = CLICKER_MILESTONES.filter(
    (milestone) => milestone > currentTapCount && milestone <= nextTapCount,
  );
  const next: ClickerProgress = {
    ...current,
    lifetimeTaps,
    bestSeries,
    activeSeries,
    updatedAtMs: Math.max(0, nowMs),
  };
  return {
    progress: next,
    finishedSeries: expired.finishedSeries,
    crossedMilestones,
    effect: getClickerTransitionEffect(currentTapCount, nextTapCount),
    levelBefore,
    levelAfter: getClickerLevel(lifetimeTaps),
  };
}

export function planClickerTap(
  progress: ClickerProgress,
  serverCooldownActive: boolean,
  nowMs = Date.now(),
  hasPendingServerRetry = false,
): ClickerTapPlan {
  if (hasPendingServerRetry) return "REQUEST_SERVER";
  const active = progress.activeSeries;
  if (active && nowMs >= active.lastTapAtMs && nowMs - active.lastTapAtMs < CLICKER_IDLE_RESET_MS) {
    return "ADVANCE_LOCAL";
  }
  return serverCooldownActive ? "START_LOCAL" : "REQUEST_SERVER";
}

export function getClickerFrame(progress: ClickerProgress): ClickerFrame | null {
  const active = progress.activeSeries;
  if (!active || active.tapCount < 1) return null;
  const story = storyById(active.storyId)
    ?? getStoryForSeries(progress.storySeed, progress.completedSeries);
  let scene = story.scenes[0];
  for (const candidate of story.scenes) {
    if (candidate.at > active.tapCount) break;
    scene = candidate;
  }
  return {
    storyId: story.id,
    storyTitle: story.title,
    tapCount: active.tapCount,
    message: scene.message,
    nextMilestone: getNextClickerMilestone(active.tapCount),
    level: getClickerLevel(progress.lifetimeTaps),
  };
}

export function mergeClickerProgress(
  first: ClickerProgress,
  second: ClickerProgress,
): ClickerProgress {
  // The caller passes the stored snapshot first and the in-memory snapshot second.
  // Equal millisecond timestamps are common with multi-touch, so the second snapshot
  // must win the tie or a later tap can disappear after reload.
  const latest = first.updatedAtMs > second.updatedAtMs ? first : second;
  return {
    ...latest,
    lifetimeTaps: Math.max(
      normalizeLifetimeTaps(first.lifetimeTaps),
      normalizeLifetimeTaps(second.lifetimeTaps),
    ),
    bestSeries: Math.max(normalizeCount(first.bestSeries), normalizeCount(second.bestSeries)),
    completedSeries: Math.max(
      normalizeCompletedSeries(first.completedSeries),
      normalizeCompletedSeries(second.completedSeries),
    ),
  };
}

export function serializeClickerProgress(progress: ClickerProgress): string {
  return JSON.stringify({
    version: 3,
    lifetimeTaps: normalizeLifetimeTaps(progress.lifetimeTaps),
    bestSeries: normalizeCount(progress.bestSeries),
    completedSeries: normalizeCompletedSeries(progress.completedSeries),
    storySeed: normalizeSeed(progress.storySeed),
    lastStoryId: progress.lastStoryId && storyById(progress.lastStoryId)
      ? progress.lastStoryId
      : null,
    activeSeries: progress.activeSeries
      ? {
          eventId: progress.activeSeries.eventId,
          tapCount: normalizeCount(progress.activeSeries.tapCount),
          startedAtMs: progress.activeSeries.startedAtMs,
          lastTapAtMs: progress.activeSeries.lastTapAtMs,
          storyId: storyById(progress.activeSeries.storyId)
            ? progress.activeSeries.storyId
            : getStoryForSeries(progress.storySeed, progress.completedSeries).id,
        }
      : null,
    updatedAtMs: Math.max(0, progress.updatedAtMs),
  });
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseClickerProgress(value: string, fallbackSeed = 0): ClickerProgress | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
    if (parsed.version === 1) {
      if (
        !("totalTaps" in parsed) || !Number.isSafeInteger(parsed.totalTaps)
        || Number(parsed.totalTaps) < 0 || !("storySeed" in parsed)
        || !Number.isSafeInteger(parsed.storySeed)
      ) return null;
      return {
        ...createClickerRun(fallbackSeed),
        lifetimeTaps: normalizeLifetimeTaps(Number(parsed.totalTaps)),
      };
    }
    if (
      ![2, 3].includes(Number(parsed.version)) || !("bestSeries" in parsed)
      || !Number.isSafeInteger(parsed.bestSeries) || Number(parsed.bestSeries) < 0
      || Number(parsed.bestSeries) > CLICKER_MAX_TAP_COUNT
      || !("completedSeries" in parsed) || !Number.isSafeInteger(parsed.completedSeries)
      || Number(parsed.completedSeries) < 0 || !("storySeed" in parsed)
      || !Number.isSafeInteger(parsed.storySeed) || !("lastStoryId" in parsed)
      || (parsed.lastStoryId !== null
        && (typeof parsed.lastStoryId !== "string" || !storyById(parsed.lastStoryId)))
      || !("activeSeries" in parsed) || !("updatedAtMs" in parsed)
      || !isSafeTimestamp(parsed.updatedAtMs)
    ) return null;

    let activeSeries: ClickerActiveSeries | null = null;
    if (parsed.activeSeries !== null) {
      if (
        typeof parsed.activeSeries !== "object" || !("tapCount" in parsed.activeSeries)
        || !Number.isSafeInteger(parsed.activeSeries.tapCount)
        || Number(parsed.activeSeries.tapCount) < 1
        || Number(parsed.activeSeries.tapCount) > CLICKER_MAX_TAP_COUNT
        || !("startedAtMs" in parsed.activeSeries)
        || !isSafeTimestamp(parsed.activeSeries.startedAtMs)
        || !("lastTapAtMs" in parsed.activeSeries)
        || !isSafeTimestamp(parsed.activeSeries.lastTapAtMs)
        || Number(parsed.activeSeries.lastTapAtMs) < Number(parsed.activeSeries.startedAtMs)
        || ("eventId" in parsed.activeSeries
          && parsed.activeSeries.eventId !== null
          && (typeof parsed.activeSeries.eventId !== "string"
            || !UUID_V4.test(parsed.activeSeries.eventId)))
        || !("storyId" in parsed.activeSeries)
        || typeof parsed.activeSeries.storyId !== "string"
        || !storyById(parsed.activeSeries.storyId)
      ) return null;
      activeSeries = {
        eventId: "eventId" in parsed.activeSeries
          && typeof parsed.activeSeries.eventId === "string"
          ? parsed.activeSeries.eventId
          : null,
        tapCount: Number(parsed.activeSeries.tapCount),
        startedAtMs: Number(parsed.activeSeries.startedAtMs),
        lastTapAtMs: Number(parsed.activeSeries.lastTapAtMs),
        storyId: parsed.activeSeries.storyId,
      };
    }

    const bestSeries = Number(parsed.bestSeries);
    const lifetimeTaps = parsed.version === 3 && "lifetimeTaps" in parsed
      && Number.isSafeInteger(parsed.lifetimeTaps) && Number(parsed.lifetimeTaps) >= 0
      ? normalizeLifetimeTaps(Number(parsed.lifetimeTaps))
      : bestSeries;
    if (parsed.version === 3 && (!("lifetimeTaps" in parsed)
      || !Number.isSafeInteger(parsed.lifetimeTaps) || Number(parsed.lifetimeTaps) < bestSeries)) {
      return null;
    }

    return {
      lifetimeTaps,
      bestSeries,
      completedSeries: Number(parsed.completedSeries),
      storySeed: normalizeSeed(Number(parsed.storySeed ?? fallbackSeed)),
      lastStoryId: parsed.lastStoryId,
      activeSeries,
      updatedAtMs: parsed.updatedAtMs,
    };
  } catch {
    return null;
  }
}

export function combineLegacyClickerProgress(
  versionTwo: ClickerProgress | null,
  versionOne: ClickerProgress | null,
  fallbackSeed = 0,
): ClickerProgress {
  if (!versionTwo && !versionOne) return createClickerRun(fallbackSeed);
  if (!versionTwo) return versionOne ?? createClickerRun(fallbackSeed);
  if (!versionOne) return versionTwo;
  return {
    ...versionTwo,
    lifetimeTaps: addLifetimeTaps(versionOne.lifetimeTaps, versionTwo.lifetimeTaps),
  };
}
