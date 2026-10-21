import type { WorldLightingEditorTool, WorldLightingElementKind } from "./world-lighting-editor-store";

export type StudioSearchTarget =
  | { type: "field"; pane: "inspector" | "preview"; field: string; kind?: WorldLightingElementKind }
  | { type: "panel"; pane: "preview" | "history" | "help" }
  | { type: "create"; kind: "lantern" | "torch" | "glow" }
  | { type: "tool"; tool: WorldLightingEditorTool };
type StudioSearchAction = { id: string; label: string; detail: string; keywords: string; target: StudioSearchTarget };

/** Words can be entered in any order; ё/е and punctuation do not affect lookup. */
export function studioSearchWords(value: string): string[] {
  return value.toLocaleLowerCase("ru").replaceAll("ё", "е").split(/[^\p{L}\p{N}:-]+/u).filter(Boolean);
}
export function studioSearchMatches(query: string, content: string) {
  const haystack = studioSearchWords(content).join(" ");
  return studioSearchWords(query).every(word => haystack.includes(word));
}

const actions: readonly StudioSearchAction[] = [
  { id: "brightness", label: "Яркость источника", detail: "Свойства света", keywords: "свет интенсивность brightness intensity", target: { type: "field", pane: "inspector", field: "Яркость", kind: "light" } },
  { id: "radius", label: "Радиус света", detail: "Размер светового пятна", keywords: "источник размер дальность radius", target: { type: "field", pane: "inspector", field: "Радиус", kind: "light" } },
  { id: "color", label: "Цвет света", detail: "Свойства света", keywords: "оттенок цветной color", target: { type: "field", pane: "inspector", field: "Цвет света", kind: "light" } },
  { id: "flicker", label: "Мерцание", detail: "Положение и мерцание источника", keywords: "мигание пульсация огонь flicker", target: { type: "field", pane: "inspector", field: "Мерцание", kind: "light" } },
  { id: "shadow-opacity", label: "Плотность тени", detail: "Свойства объёма", keywords: "тень темнота прозрачность opacity", target: { type: "field", pane: "inspector", field: "Плотность тени", kind: "caster" } },
  { id: "shadow-softness", label: "Мягкость края", detail: "Свойства тени", keywords: "тень размытие мягкая softness", target: { type: "field", pane: "inspector", field: "Мягкость края", kind: "caster" } },
  { id: "height", label: "Высота объёма", detail: "Свойства объёма", keywords: "тень высота дома здания height", target: { type: "field", pane: "inspector", field: "Высота", kind: "caster" } },
  { id: "source-height", label: "Высота источника", detail: "Свойства света", keywords: "свет лампа высота height", target: { type: "field", pane: "inspector", field: "Высота источника", kind: "light" } },
  { id: "ground-height", label: "Высота поверхности", detail: "Свойства земли", keywords: "земля высота ground height", target: { type: "field", pane: "inspector", field: "Высота поверхности", kind: "receiver" } },
  { id: "base-height", label: "Основание объёма", detail: "Поднять крону над землёй", keywords: "высота основание крона дерево", target: { type: "field", pane: "inspector", field: "Основание", kind: "caster" } },
  { id: "contour", label: "Редактировать контур", detail: "Точки и границы на карте · P", keywords: "вершины полигон форма исключение вырез", target: { type: "tool", tool: "vertex" } },
  { id: "glow", label: "Добавить свечение", detail: "Выберите место на карте", keywords: "свет glow пятно ореол лампа", target: { type: "create", kind: "glow" } },
  { id: "lantern", label: "Добавить фонарь", detail: "Выберите место на карте", keywords: "свет лампа lantern", target: { type: "create", kind: "lantern" } },
  { id: "torch", label: "Добавить факел", detail: "Выберите место на карте", keywords: "свет огонь пламя torch", target: { type: "create", kind: "torch" } },
  { id: "day-night", label: "День и ночь", detail: "Предпросмотр освещения", keywords: "время суток солнце луна темно светло", target: { type: "panel", pane: "preview" } },
  { id: "sun-direction", label: "Направление солнца", detail: "Вид и освещение", keywords: "тень азимут угол направление", target: { type: "field", pane: "preview", field: "Направление солнца" } },
  { id: "quality", label: "Качество освещения", detail: "Вид и освещение", keywords: "лаги скорость производительность качество детальный бережный", target: { type: "field", pane: "preview", field: "Качество" } },
  { id: "overlay", label: "Разметка на карте", detail: "Контуры и каркас", keywords: "скрыть показать земля объемы каркас контуры", target: { type: "field", pane: "preview", field: "Разметка на карте" } },
  { id: "history", label: "История изменений", detail: "Отмена и повтор действий", keywords: "откат undo redo назад вперед", target: { type: "panel", pane: "history" } },
  { id: "help", label: "Горячие клавиши", detail: "Русская и английская раскладка", keywords: "клавиатура помощь сочетания команды", target: { type: "panel", pane: "help" } },
];

export function searchWorldStudioActions(query: string, selectedKind: WorldLightingElementKind | null) {
  if (!studioSearchWords(query).length) return [];
  return actions.filter(action => studioSearchMatches(query, `${action.label} ${action.detail} ${action.keywords}`)).map(action => ({
    ...action,
    disabled: action.target.type === "field" && Boolean(action.target.kind && action.target.kind !== selectedKind),
  })).sort((left, right) => Number(left.disabled) - Number(right.disabled));
}

/** Open every enclosing disclosure before bringing an existing property into view. */
export function revealStudioSearchField(container: HTMLElement, field: string) {
  const control = Array.from(container.querySelectorAll<HTMLElement>("[data-studio-field]")).find(item => item.dataset.studioField === field);
  if (!control) return false;
  let parent: HTMLElement | null = control;
  while (parent && parent !== container) {
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
    parent = parent.parentElement;
  }
  control.scrollIntoView({ block: "nearest", behavior: "auto" });
  (control.matches("input,select,button") ? control : control.querySelector<HTMLElement>("input,select,button"))?.focus({ preventScroll: true });
  return true;
}
