// Small atlas additions only: the original house, doorway and dynamic bulb remain intact.
export function houseDetailPatches(level: number) {
  if (level < 2) return [];
  const patches = [{ sx: 506, sy: 188, sw: 64, sh: 53, x: 201, y: 73, w: 21, h: 18 }];
  if (level >= 3) patches.push({ sx: 519, sy: 228, sw: 52, sh: 40, x: 205, y: 88, w: 18, h: 14 });
  if (level >= 4) patches.push({ sx: 564, sy: 171, sw: 43, sh: 42, x: 222, y: 68, w: 14, h: 14 });
  if (level >= 5) patches.push({ sx: 441, sy: 126, sw: 73, sh: 47, x: 180, y: 48, w: 24, h: 15 });
  return patches;
}
export function houseAtlasCell(level: number) { const index = Math.max(0, Math.min(3, level - 2)); return { x: index % 2 * 627, y: Math.floor(index / 2) * 627 }; }
