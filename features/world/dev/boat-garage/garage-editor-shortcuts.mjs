/** Resolve physical keys so Russian and English layouts share editor shortcuts.
 * Text inputs keep their native editing, selection and undo behavior. */
export function getGarageShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  const target = event.target;
  if (target?.closest?.("input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]")) return null;
  const code = event.code || ({ z: "KeyZ", y: "KeyY", d: "KeyD", s: "KeyS", g: "KeyG", r: "KeyR", m: "KeyM", v: "KeyV", h: "KeyH", p: "KeyP", a: "KeyA" }[event.key?.toLowerCase()] ?? event.key);
  if (event.ctrlKey || event.metaKey) {
    if (code === "KeyZ") return event.shiftKey ? "redo" : "undo";
    if (code === "KeyY") return "redo";
    if (!event.shiftKey && code === "KeyD") return "duplicate";
    if (!event.shiftKey && code === "KeyS") return "save";
    return null;
  }
  if (code === "Escape") return "escape";
  const tool = { KeyG: "move", KeyV: "move", KeyR: "rotate", KeyS: "scale", KeyM: "occlusion", KeyH: "camera", KeyP: "pivot", KeyA: "socket" }[code];
  if (tool) return tool;
  if (target?.closest?.("button,a,summary,[role=button],input")) return null;
  return ({ Delete: "remove", Backspace: "remove", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" })[code] ?? null;
}

const HISTORY_LIMIT = 100;
const sameScene = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @template T @param {{past: T[], scene: T, future: T[]}} history @param {T} scene */
export function changeGarageHistory(history, scene, record = true) {
  if (sameScene(history.scene, scene)) return history;
  return { past: record ? [...history.past, history.scene].slice(-HISTORY_LIMIT) : history.past, scene, future: [] };
}

/** One pointer drag is one undo action, regardless of pointermove frequency.
 * @template T @param {{past: T[], scene: T, future: T[]}} history @param {T} before */
export function finishGarageHistoryGesture(history, before) {
  return sameScene(history.scene, before) ? history : { ...history, past: [...history.past, before].slice(-HISTORY_LIMIT), future: [] };
}

/** @template T @param {{past: T[], scene: T, future: T[]}} history */
export function undoGarageHistory(history) {
  return history.past.length ? { past: history.past.slice(0, -1), scene: history.past[history.past.length - 1], future: [history.scene, ...history.future] } : history;
}

/** @template T @param {{past: T[], scene: T, future: T[]}} history */
export function redoGarageHistory(history) {
  return history.future.length ? { past: [...history.past, history.scene].slice(-HISTORY_LIMIT), scene: history.future[0], future: history.future.slice(1) } : history;
}
