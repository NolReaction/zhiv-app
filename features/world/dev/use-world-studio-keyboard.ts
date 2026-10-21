import { useEffect, useRef } from "react";
import { worldLightingEditorStore } from "./world-lighting-editor-store";
import { requestWorldLightingEditorFocus } from "./world-lighting-editor-map";
import { createWorldStudioKeyboard, WORLD_STUDIO_MAP_KEY_EVENT, WORLD_STUDIO_UI_EVENT, type WorldStudioKeyboardInput } from "./world-studio-keyboard";

const inputFrom = (event: KeyboardEvent): WorldStudioKeyboardInput => ({
  key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
  altKey: event.altKey, shiftKey: event.shiftKey, isComposing: event.isComposing, target: event.target,
});

export function useWorldStudioKeyboard({ onClose }: { onClose: () => void }) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const keyboard = createWorldStudioKeyboard({
      store: worldLightingEditorStore,
      ui: detail => window.dispatchEvent(new CustomEvent(WORLD_STUDIO_UI_EVENT, { detail })),
      map: detail => window.dispatchEvent(new CustomEvent(WORLD_STUDIO_MAP_KEY_EVENT, { detail })),
      close: () => close.current(),
      focus: () => requestWorldLightingEditorFocus(),
    });
    const down = (event: KeyboardEvent) => {
      if (keyboard.down(inputFrom(event))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const up = (event: KeyboardEvent) => {
      if (keyboard.up(inputFrom(event))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const blur = () => keyboard.blur({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: null });
    window.addEventListener("keydown", down, true); window.addEventListener("keyup", up, true); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", blur); };
  }, []);
}
