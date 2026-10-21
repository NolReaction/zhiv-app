type Simulation = { position: { latitude: number; longitude: number; accuracyMeters: number } | null;
  publicationEpoch: string | null; sequence: number; nextPublishAt: number | null };
const globals = globalThis as typeof globalThis & { __zhivDevBotEarth?: WeakMap<object, Simulation> };

/** Keyed by an existing private owned-bot record, never an arbitrary user ID. */
export function devBotEarthSimulation(bot: object): Simulation {
  const store = globals.__zhivDevBotEarth ??= new WeakMap();
  let state = store.get(bot);
  if (!state) { state = { position: null, publicationEpoch: null, sequence: 0, nextPublishAt: null }; store.set(bot, state); }
  return state;
}
export function removeDevBotEarthSimulation(bot: object) { globals.__zhivDevBotEarth?.delete(bot); }
export function resetDevBotEarthSimulation() { delete globals.__zhivDevBotEarth; }
