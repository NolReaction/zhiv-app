import type { EarthModelPlacement } from "../model-placement";

export type EarthModelEditorShortcut =
  | { type: "undo" | "redo" | "focus" }
  | { type: "move"; eastMeters: number; northMeters: number }
  | { type: "rotate"; degrees: number }
  | { type: "resize"; percentDelta: number };

/** Structural input keeps classification usable in tests and outside the DOM. */
export interface EarthModelEditorKeyboardInput {
  readonly code?: string;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly target?: unknown;
}

type TextTarget = {
  tagName?: unknown;
  type?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  parentElement?: unknown;
};
const NON_TEXT_INPUT_TYPES = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "image", "file", "color", "hidden"]);

function isFormControlTarget(target: unknown): boolean {
  let current = target;
  for (let depth = 0; current && typeof current === "object" && depth < 32; depth += 1) {
    const node = current as TextTarget;
    const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    current = node.parentElement;
  }
  return false;
}

/** Do not steal native text editing/undo, including descendants of an editable
 * region. No global Element/HTMLElement is required, including during SSR. */
export function isEarthModelEditorTextTarget(target: unknown): boolean {
  let current = target;
  let editableBoundary = false;
  for (let depth = 0; current && typeof current === "object" && depth < 32; depth += 1) {
    const node = current as TextTarget;
    const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const attribute = typeof node.getAttribute === "function" ? node.getAttribute("type") : null;
      const inputType = (typeof node.type === "string" ? node.type : attribute ?? "text").trim().toLowerCase();
      // Numeric/date fields keep native editing history. A range or checkbox,
      // however, has just changed the model and should allow immediate undo.
      if (!NON_TEXT_INPUT_TYPES.has(inputType)) return true;
    }
    if (!editableBoundary) {
      if (node.isContentEditable === true) return true;
      const attribute = typeof node.getAttribute === "function" ? node.getAttribute("contenteditable") : null;
      if (typeof attribute === "string") {
        editableBoundary = true;
        // A contenteditable=false island keeps the outer editor from capturing
        // keystrokes while inputs nested inside it still retain native editing.
        if (attribute.trim().toLowerCase() !== "false") return true;
      }
    }
    current = node.parentElement;
  }
  return false;
}

/** Physical codes keep shortcuts stable with the Russian keyboard layout;
 * logical keys remain a fallback for synthetic/older keyboard events. */
export function classifyEarthModelEditorShortcut(event: EarthModelEditorKeyboardInput): EarthModelEditorShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || isEarthModelEditorTextTarget(event.target)) return null;
  const key = (event.key ?? "").toLowerCase();
  const hasPhysicalCode = Boolean(event.code && event.code !== "Unidentified");
  const matches = (code: string, keys: readonly string[]) => hasPhysicalCode ? event.code === code : keys.includes(key);
  if (event.ctrlKey || event.metaKey) {
    if (matches("KeyZ", ["z", "я"])) return { type: event.shiftKey ? "redo" : "undo" };
    if (matches("KeyY", ["y", "н"])) return { type: "redo" };
    return null;
  }
  // Ranges still need their native arrows; editor movement and size shortcuts
  // must never run just because a non-text form control currently has focus.
  if (isFormControlTarget(event.target)) return null;
  if (matches("KeyF", ["f", "а"])) return { type: "focus" };
  const metres = event.shiftKey ? 10 : 1;
  if (matches("ArrowLeft", ["arrowleft"])) return { type: "move", eastMeters: -metres, northMeters: 0 };
  if (matches("ArrowRight", ["arrowright"])) return { type: "move", eastMeters: metres, northMeters: 0 };
  if (matches("ArrowUp", ["arrowup"])) return { type: "move", eastMeters: 0, northMeters: metres };
  if (matches("ArrowDown", ["arrowdown"])) return { type: "move", eastMeters: 0, northMeters: -metres };
  const degrees = event.shiftKey ? 15 : 1;
  if (matches("BracketLeft", ["[", "{", "х"])) return { type: "rotate", degrees: -degrees };
  if (matches("BracketRight", ["]", "}", "ъ"])) return { type: "rotate", degrees };
  const percentDelta = event.shiftKey ? 10 : 1;
  if (matches("Minus", ["-", "_", "subtract"]) || event.code === "NumpadSubtract") return { type: "resize", percentDelta: -percentDelta };
  if (matches("Equal", ["=", "+", "add"]) || event.code === "NumpadAdd") return { type: "resize", percentDelta };
  return null;
}

export type EarthModelEditorPlacementPatch = Partial<Omit<EarthModelPlacement, "id">>;

/** A key press produces only a placement patch. History and event consumption
 * belong to the editor, never to this pure helper. Resize uses percentage
 * points of the catalog height so repeated steps do not compound. */
export function earthModelEditorShortcutPatch(
  placement: EarthModelPlacement,
  action: EarthModelEditorShortcut,
  baseHeightMeters: number,
): EarthModelEditorPlacementPatch | null {
  switch (action.type) {
    case "move": {
      if (![action.eastMeters, action.northMeters].every(Number.isFinite)) return null;
      const degreesPerMetre = 180 / (Math.PI * 6_371_008.8);
      const longitudeStep = action.eastMeters * degreesPerMetre / Math.cos(placement.latitude * Math.PI / 180);
      const longitude = action.eastMeters === 0 ? placement.longitude
        : ((placement.longitude + longitudeStep + 180) % 360 + 360) % 360 - 180;
      const latitude = action.northMeters === 0 ? placement.latitude
        : Math.max(-85, Math.min(85, placement.latitude + action.northMeters * degreesPerMetre));
      if (longitude === placement.longitude && latitude === placement.latitude) return null;
      return { longitude, latitude };
    }
    case "rotate": {
      if (!Number.isFinite(action.degrees)) return null;
      const headingDegrees = ((placement.headingDegrees + action.degrees) % 360 + 360) % 360;
      return headingDegrees === placement.headingDegrees ? null : { headingDegrees };
    }
    case "resize": {
      if (!Number.isFinite(baseHeightMeters) || baseHeightMeters <= 0 || !Number.isFinite(action.percentDelta)) return null;
      const heightMeters = Math.max(1, Math.min(1000, placement.heightMeters + baseHeightMeters * action.percentDelta / 100));
      return heightMeters === placement.heightMeters ? null : { heightMeters };
    }
    default: return null;
  }
}
