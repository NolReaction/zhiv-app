/** Editable workshop support. Coordinates refer to the untrimmed SVG canvas. */
export const BOAT_GARAGE_STAND_ASSET = {
  id: "side-stand", name: "Винтовая опора · SVG", src: "/world/boat-garage/stand-side.svg", width: 320, height: 320,
};

/** The same native hull placement is used by the studio and the live garage.
 * The saddle overlaps the keel by five hull units; feet stay level, without stretching the drawing.
 * @param {{boatScale?: number, boatX?: number, boatY?: number}} [placement]
 */
export function boatGarageStandFrames({ boatScale = 1, boatX = 0, boatY = 0 } = {}) {
  const contactY = boatY + 555 * boatScale, floorY = boatY + 755 * boatScale;
  return [480, 1100].map(x => ({
    x: boatX + x * boatScale, y: floorY, width: 320, height: 320,
    scale: (floorY - contactY) / (304 - 24), pivotX: .5, pivotY: .95,
    sockets: [{ id: "contact", name: "Контакт с килем", x: .5, y: .075 },
      { id: "foot", name: "Подошва", x: .5, y: .95 }],
  }));
}
