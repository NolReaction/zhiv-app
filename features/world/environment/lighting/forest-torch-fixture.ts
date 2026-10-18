import type { WorldLight, WorldPoint } from "@/features/world/tiled/types";

/** The authored point is the flame; the physical post ends below it. */
export const TORCH_FIXTURE = { footOffsetY: 16.5, halfWidth: 3, halfDepth: 2.5 } as const;

export function forestTorchFootprints(lights: readonly WorldLight[] = []): WorldPoint[][] {
  return lights.filter(light => light.kind === "torch" && light.enabled !== false).map(light => {
    const x = light.position.x, y = light.position.y + TORCH_FIXTURE.footOffsetY;
    const w = TORCH_FIXTURE.halfWidth, h = TORCH_FIXTURE.halfDepth;
    return [{ x: x - w, y: y - h }, { x: x + w, y: y - h },
      { x: x + w, y: y + h }, { x: x - w, y: y + h }];
  });
}

/** Color, flame intensity and light height never change the painted post. */
export function forestTorchGeometryKey(lights: readonly WorldLight[] = []): string {
  return JSON.stringify(lights.filter(light => light.kind === "torch" && light.enabled !== false)
    .map(light => [light.id, light.position.x, light.position.y, light.manualPosition === true])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
