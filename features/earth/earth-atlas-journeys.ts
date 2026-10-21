import { earthAtlasEntry, type EarthAtlasEntry } from "./earth-atlas";

export type EarthAtlasJourneyStop = Readonly<{ entryId: string; note: string }>;
export type EarthAtlasJourney = Readonly<{
  id: string;
  title: string;
  description: string;
  accent: "sand" | "north" | "landmark";
  stops: readonly EarthAtlasJourneyStop[];
}>;

/** Short, authored looks at the existing map. No new coordinates or travel records. */
export const EARTH_ATLAS_JOURNEYS: readonly EarthAtlasJourney[] = [
  { id: "sand-to-canopy", title: "От песка к кронам", description: "Четыре остановки, чтобы рассмотреть тёплую палитру глобуса.", accent: "sand", stops: [
    { entryId: "region:sahara", note: "Начни с песчаных оттенков. С высоты особенно хорошо читаются мягкие изгибы нарисованных дюн." },
    { entryId: "region:east-african-savanna", note: "Переключи взгляд на золотистую саванну. Найди маленькие кроны и сравни их силуэты с линиями рельефа." },
    { entryId: "region:congo-rainforest", note: "Теперь — глубокий зелёный. Рассмотри, как группы крон добавляют поверхности объём." },
    { entryId: "region:amazon-rainforest", note: "Ещё один зелёный акцент. Задержись здесь и сравни настроение этой части глобуса с началом маршрута." },
  ] },
  { id: "northern-palette", title: "Северная палитра", description: "От лесных оттенков к спокойным цветам тундры.", accent: "north", stops: [
    { entryId: "region:scandinavian-taiga", note: "Начни с хвойных силуэтов. Их небольшие группы помогают почувствовать масштаб нарисованной земли." },
    { entryId: "region:west-siberian-taiga", note: "Перелистни к следующему лесному региону. Посмотри, как зелёные пятна соединяются с общей фактурой суши." },
    { entryId: "region:east-siberian-taiga", note: "Снова тайга, но уже другой ракурс. Можно ненадолго отвести камеру и вернуться кнопкой с названием остановки." },
    { entryId: "region:chukotka-tundra", note: "Закончи на приглушённых оттенках тундры. Оставь этот спокойный ракурс или выбери новый маршрут." },
  ] },
  { id: "five-silhouettes", title: "Пять силуэтов", description: "Небольшая коллекция знакомых форм на поверхности Земли.", accent: "landmark", stops: [
    { entryId: "landmark:eiffel-tower", note: "Первая остановка — тонкий силуэт башни. Рассмотри миниатюру на фоне большого глобуса." },
    { entryId: "landmark:colosseum", note: "От вертикали — к округлой форме. Сравни, как по-разному эти миниатюры выглядят с высоты." },
    { entryId: "landmark:giza-pyramids", note: "Здесь взгляд собирают простые грани. Поверни глобус, чтобы рассмотреть их с другого угла." },
    { entryId: "landmark:taj-mahal", note: "Следующий силуэт складывается из светлых объёмов. Дай себе время рассмотреть детали." },
    { entryId: "landmark:sydney-opera", note: "Финальный акцент — ритм светлых оболочек. Останься у этой миниатюры или продолжи исследование самостоятельно." },
  ] },
];

export type EarthAtlasJourneyState = Readonly<{ journeyId: string; stopIndex: number }> | null;
export type EarthAtlasJourneyAction =
  | { type: "start"; journeyId: string }
  | { type: "stop" }
  | { type: "previous" | "next" }
  | { type: "select"; stopIndex: number };

export function earthAtlasJourney(id: string): EarthAtlasJourney | null {
  return EARTH_ATLAS_JOURNEYS.find(journey => journey.id === id) ?? null;
}

export function earthAtlasJourneyStop(state: EarthAtlasJourneyState): {
  journey: EarthAtlasJourney; stop: EarthAtlasJourneyStop; entry: EarthAtlasEntry;
} | null {
  if (!state || !Number.isInteger(state.stopIndex)) return null;
  const journey = earthAtlasJourney(state.journeyId), stop = journey?.stops[state.stopIndex];
  if (!journey || !stop) return null;
  const entry = earthAtlasEntry(stop.entryId);
  return entry?.center && entry.zoom !== null ? { journey, stop, entry } : null;
}

/** Pure, bounded navigation. It never discovers entries, persists data or starts timers. */
export function transitionEarthAtlasJourney(state: EarthAtlasJourneyState, action: EarthAtlasJourneyAction): EarthAtlasJourneyState {
  if (action.type === "stop") return null;
  if (action.type === "start") return earthAtlasJourneyStop({ journeyId: action.journeyId, stopIndex: 0 })
    ? { journeyId: action.journeyId, stopIndex: 0 } : state;
  const current = earthAtlasJourneyStop(state);
  if (!state || !current) return null;
  const stopIndex = action.type === "select" ? action.stopIndex : state.stopIndex + (action.type === "next" ? 1 : -1);
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= current.journey.stops.length || stopIndex === state.stopIndex) return state;
  return { journeyId: state.journeyId, stopIndex };
}
