import { getGarageNodeMatrix } from "./garage-scene-model.mjs";

const MIN_SCALE = .001, MAX_SCALE = 8;
const clampScale = value => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));

/** Editor-only screen transform. It never changes exported scene cameras. */
export function fitGarageEditorView(canvas, width, height, padding = 24) {
  return frameGarageEditorBounds({ x: 0, y: 0, width: canvas.width, height: canvas.height }, width, height, padding);
}

export function frameGarageEditorBounds(bounds, width, height, padding = 24) {
  const scale = clampScale(Math.min(Math.max(1, width - padding * 2) / Math.max(1, bounds.width),
    Math.max(1, height - padding * 2) / Math.max(1, bounds.height)));
  return { x: width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * scale, scale };
}

/** Keep the exact world point below the cursor fixed while zooming. */
export function zoomGarageEditorView(view, requestedScale, anchor) {
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) return view;
  const scale = clampScale(requestedScale), factor = scale / view.scale;
  return { x: anchor.x - (anchor.x - view.x) * factor, y: anchor.y - (anchor.y - view.y) * factor, scale };
}

export function panGarageEditorView(view, dx, dy) {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function garageEditorWorldPoint(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/** All four transformed corners are needed for rotated, flipped or sheared layers. */
export function garageEditorNodeBounds(scene, nodeId) {
  const node = scene.nodes.find(item => item.id === nodeId);
  if (!node) return null;
  const [a, b, c, d, x, y] = getGarageNodeMatrix(scene, nodeId);
  const xs = [x, x + a * node.width, x + c * node.height, x + a * node.width + c * node.height];
  const ys = [y, y + b * node.width, y + d * node.height, y + b * node.width + d * node.height];
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
