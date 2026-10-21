import type { WorldLightingEditorTool } from "./world-lighting-editor-store";

export const WORLD_STUDIO_UI_EVENT = "world-studio:ui-command";
export const WORLD_STUDIO_MAP_KEY_EVENT = "world-studio:map-key";
export type WorldStudioUIAction = "rename" | "select-all" | "help" | "history" | "save" | "search" | "cancel-input";
export type WorldStudioUICommand = { action: WorldStudioUIAction; target?: EventTarget | null };
export type WorldStudioKeyboardInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "target">;
export type WorldStudioMapKeyRequest = { phase: "down" | "up" | "cancel"; input: WorldStudioKeyboardInput; handled: boolean };

type KeyboardStore = {
  getSnapshot: () => { enabled: boolean; previewDraft: boolean; tool: WorldLightingEditorTool; selectedId: string | null };
  isGesturing: () => boolean; commitGesture: () => void; cancelGesture: () => void;
  undo: () => void; redo: () => void; saveDraft: () => unknown;
  setTool: (tool: WorldLightingEditorTool) => void;
  duplicateSelected: () => unknown;
};
type KeyboardOptions = {
  store: KeyboardStore;
  ui: (command: WorldStudioUICommand) => void;
  map: (request: WorldStudioMapKeyRequest) => void;
  close: () => void;
  focus?: () => void;
};

/** Physical letter keys keep editor commands stable across keyboard layouts. */
export function worldStudioKey(input: Pick<WorldStudioKeyboardInput, "key" | "code">): string {
  if (/^Key[A-Z]$/.test(input.code ?? "")) return input.code.slice(3).toLowerCase();
  return input.key.toLowerCase();
}

function controlTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  const control = element?.closest?.("input,textarea,select,[contenteditable]") as HTMLElement | null;
  if (!control) return { control: null, text: false };
  const tag = control.tagName?.toLowerCase();
  const type = control.getAttribute?.("type")?.toLowerCase() ?? "text";
  const text = tag === "textarea" || control.isContentEditable || control.hasAttribute?.("contenteditable")
    || tag === "input" && !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "hidden"].includes(type);
  return { control, text: Boolean(text) };
}

/** One scoped dispatcher owns shortcuts; text editing retains its native Undo. */
export function createWorldStudioKeyboard(options: KeyboardOptions) {
  const cancelMap = (input: WorldStudioKeyboardInput) => {
    const request: WorldStudioMapKeyRequest = { phase: "cancel", input, handled: false };
    options.map(request);
    options.store.cancelGesture();
  };
  return {
    down(input: WorldStudioKeyboardInput): boolean {
      const state = options.store.getSnapshot();
      if (!state.enabled || input.isComposing) return false;
      const key = worldStudioKey(input), command = input.ctrlKey || input.metaKey;
      const { control, text } = controlTarget(input.target);
      if (command && !input.altKey && key === "k") {
        options.ui({ action: "search" }); return true;
      }
      if (command && !input.altKey && key === "s") {
        control?.blur?.();
        options.store.commitGesture(); options.store.saveDraft(); options.ui({ action: "save" });
        return true;
      }
      if (command && !input.altKey && (key === "z" || key === "y")) {
        if (text) return false;
        if (state.previewDraft) {
          options.store.commitGesture(); cancelMap(input);
          if (key === "y" || input.shiftKey) options.store.redo(); else options.store.undo();
        }
        return true;
      }
      if (key === "escape") {
        if (control) { options.ui({ action: "cancel-input", target: input.target }); return true; }
        if (options.store.isGesturing() || state.tool === "light") {
          cancelMap(input); if (state.tool === "light") options.store.setTool("select");
        } else options.close();
        return true;
      }
      if (control) return false;
      if (command && !input.altKey) {
        if (key === "d") {
          if (state.previewDraft && state.selectedId) { options.store.commitGesture(); cancelMap(input); options.store.duplicateSelected(); }
          return true;
        }
        if (key === "a") { options.ui({ action: "select-all" }); return true; }
        if (key === "h" && input.shiftKey) { options.ui({ action: "history" }); return true; }
        return false;
      }
      if (input.altKey || command) return false;
      if (key === "f2") { if (state.previewDraft && state.selectedId) options.ui({ action: "rename" }); return true; }
      if (input.key === "?" || input.code === "Slash" && input.shiftKey) { options.ui({ action: "help" }); return true; }
      const normalized = { ...input, key: /^Key[A-Z]$/.test(input.code ?? "") ? key : input.key };
      const request: WorldStudioMapKeyRequest = { phase: "down", input: normalized, handled: false };
      options.map(request);
      if (!request.handled) {
        const tools: Readonly<Record<string, WorldLightingEditorTool>> = { v: "select", g: "move", p: "vertex", h: "height", l: "light" };
        if (tools[key]) { cancelMap(normalized); options.store.setTool(tools[key]); return true; }
        if (key === "f" && state.selectedId && options.focus) { options.focus(); return true; }
      }
      return request.handled;
    },
    up(input: WorldStudioKeyboardInput): boolean {
      if (!options.store.getSnapshot().enabled || input.isComposing) return false;
      const request: WorldStudioMapKeyRequest = { phase: "up", input, handled: false };
      options.map(request); return request.handled;
    },
    blur(input: WorldStudioKeyboardInput) { cancelMap(input); },
  };
}
