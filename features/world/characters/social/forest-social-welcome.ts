import type { ForestConversation } from "./forest-conversations";
import type { ForestSocialActor, ForestSocialState, ForestSpeaker } from "./forest-social";

export type ForestWelcomeResident = "kamneshmyg" | "leaftail";
export type ForestWelcomeRequest = { resident: ForestWelcomeResident; at: number; after: number; attempts: number };
export const FOREST_WELCOME_LIMITS = { life: 240, retry: 20, attempts: 4, distance: 460 } as const;

/** Only actual arrival transitions call this. Seen preferences, loaded levels
 * and merely visible actors never create an introduction. Nothing is saved. */
export function queueForestSocialWelcome(state: ForestSocialState, resident: ForestWelcomeResident): void {
  const seen = state.welcomedResidents ??= [];
  if (seen.includes(resident) || state.welcomes?.some(item => item.resident === resident)) return;
  (state.welcomes ??= []).push({ resident, at: state.elapsed, after: state.elapsed + 2, attempts: 0 });
}

export function forestWelcomeCandidates(state: ForestSocialState, actors: readonly ForestSocialActor[]) {
  state.welcomes = (state.welcomes ?? []).filter(item => state.elapsed - item.at <= FOREST_WELCOME_LIMITS.life
    && item.attempts < FOREST_WELCOME_LIMITS.attempts && !(state.welcomedResidents ?? []).includes(item.resident));
  for (const request of state.welcomes.filter(item => item.after <= state.elapsed)) {
    const host = actors.find(item => item.id === request.resident && item.visible && item.canSpeak !== false
      && !item.window && item.available && item.context === "idle");
    if (!host) continue;
    // Only one established neighbour visits. Other newcomers and the player's
    // hero keep their own plans; work, tools, doorways and passing yields stay busy.
    const guests = actors.filter(item => item.id !== host.id && ["builder", "plesk", "lopukh"].includes(item.id)
      && item.visible && item.available && item.canSpeak !== false && !item.window
      && (item.context === "idle" || item.context === "walk" && (item.canPausePassing || item.id === "builder"))
      && Math.hypot(item.position.x - host.position.x, item.position.y - host.position.y) <= FOREST_WELCOME_LIMITS.distance)
      .sort((a, b) => Math.hypot(a.position.x - host.position.x, a.position.y - host.position.y)
        - Math.hypot(b.position.x - host.position.x, b.position.y - host.position.y));
    if (guests.length) return { request, host, guests };
  }
  return null;
}

export function rememberForestWelcome(state: ForestSocialState, resident: ForestWelcomeResident): void {
  const seen = state.welcomedResidents ??= [];
  if (!seen.includes(resident)) seen.push(resident);
  state.welcomes = (state.welcomes ?? []).filter(item => item.resident !== resident);
}

const names = { builder: "Шишколап", plesk: "Плёска", lopukh: "Лопоух" } as const;
export function forestWelcomeConversation(resident: ForestWelcomeResident, guest: ForestSpeaker): ForestConversation {
  const name = names[guest as keyof typeof names];
  return { id: `welcome-${resident}-${guest}`, pair: `${guest}-${resident}`, purpose: "welcome", lines: resident === "kamneshmyg" ? [
    { speaker: guest, text: `Привет! Я ${name}. Мы тут соседи.` },
    { speaker: resident, text: "Камнешмыг. Рад знакомству, голубчик." },
    { speaker: guest, text: "С дороги устал? У костра отдохнёшь." },
    { speaker: resident, text: "Спасибо. За чаем и познакомимся ближе." },
  ] : [
    { speaker: guest, text: `Я ${name}. Добро пожаловать к нам!` },
    { speaker: resident, text: "Листохвост. Уф. Река хвост намочила." },
    { speaker: guest, text: "Будем знакомы. Помочь с ящиками?" },
    { speaker: resident, text: "Этот не трогай: там мой запас тишины." },
  ] };
}
