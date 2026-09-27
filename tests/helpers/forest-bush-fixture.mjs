/** Complete only the optional shrub artwork for behavior fixtures. The shipped
 * map may intentionally keep imageId pending while its author places the tile. */
export function withPlacedBushArtwork(source) {
  const scene = structuredClone(source);
  for (const bush of scene.bushes ?? []) {
    if (!bush.imageId || scene.terrain.some(image => image.id === bush.imageId)) continue;
    const xs = bush.points.map(point => point.x), ys = bush.points.map(point => point.y);
    const x = Math.min(...xs) - 1, y = Math.min(...ys) - 1;
    scene.terrain.push({ id: bush.imageId, image: "/test-bush.png",
      bounds: { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 } });
  }
  return scene;
}
