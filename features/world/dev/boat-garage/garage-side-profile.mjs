import { validateGarageScene } from "./garage-scene-model.mjs";
import { BOAT_GARAGE_STAND_ASSET, boatGarageStandFrames } from "../../objects/fishing-boat/fishing-boat-garage-layout.mjs";

const root = "/world/boat/modular/";
export const GARAGE_SIDE_LEVELS = [0, 1, 2, 3, 4, 5];
/** Checkout-owned SVG masters only; uploaded SVGs are deliberately not accepted. */
export const GARAGE_SIDE_ASSETS = [
  ...["hull", "engine", "tank"].flatMap(kind => GARAGE_SIDE_LEVELS.map(level => ({
    id: `side-${kind}-l${level}`, name: `${kind === "hull" ? "Корпус" : kind === "engine" ? "Мотор" : "Бак"} · L${level}`,
    src: `${root}${kind}_l${level}.svg`,
    width: kind === "hull" ? 1600 : kind === "engine" ? 260 : 300,
    height: kind === "hull" ? 640 : kind === "engine" ? 570 : 230,
  }))),
  { id: "side-fuel-hose", name: "Топливный шланг", src: `${root}fuel_hose_aligned.svg`, width: 1600, height: 640 },
  BOAT_GARAGE_STAND_ASSET,
];

/** Creates a separate undoable example. It never reads or replaces a user's saved project.
 * @param {{hull?: number, engine?: number, tank?: number}} [levels]
 * @returns {import('./garage-scene-types').GarageScene} */
export function createGarageSideProfile(levels = {}) {
  const selected = { hull: levels.hull ?? 0, engine: levels.engine ?? 0, tank: levels.tank ?? 0 };
  for (const level of Object.values(selected)) if (!GARAGE_SIDE_LEVELS.includes(level)) throw new Error("Уровень рисунка должен быть от L0 до L5.");
  const node = (id, name, assetId, parentId, x, y, width, height, zIndex, extra = {}) => ({
    id, name, assetId, parentId, socketId: null, x, y, width, height, scale: 1, rotation: 0,
    pivotX: 0, pivotY: 0, zIndex, visible: true, locked: false, sockets: [], ...extra,
  });
  const stands = boatGarageStandFrames({ boatScale: .8, boatX: 195.5, boatY: 185 });
  return validateGarageScene({ schemaVersion: 1, canvas: { width: 1671, height: 941 },
    cameras: { portrait: { x: 835.5, y: 470.5, width: 1600 }, landscape: { x: 835.5, y: 470.5, width: 1671 } },
    assets: [{ id: "garage", name: "Мастерская", src: "/world/boat-garage/garage.webp", width: 1671, height: 941 },
      ...GARAGE_SIDE_ASSETS],
    nodes: [node("garage", "Фон мастерской", "garage", null, 0, 0, 1671, 941, 0, { locked: true }),
      ...stands.map((frame, index) => node(`side-stand-${index ? "right" : "left"}`, `${index ? "Правая" : "Левая"} опора · SVG`,
        "side-stand", null, frame.x, frame.y, frame.width, frame.height, 10, frame)),
      node("boat", "Лодка сбоку · группа", null, null, 195.5, 185, 1600, 640, 20, { scale: .8,
        sockets: [{ id: "engine", name: "Транец · мотор", x: 220 / 1600, y: 290 / 640 },
          { id: "fuel", name: "Бак", x: 500 / 1600, y: 290 / 640 }, { id: "actor", name: "Мохлик", x: 960 / 1600, y: 344 / 640 }] }),
      node("side-hull", `Корпус · L${selected.hull}`, `side-hull-l${selected.hull}`, "boat", 0, 0, 1600, 640, 21),
      node("side-hose", "Топливный шланг", "side-fuel-hose", "boat", 0, 0, 1600, 640, 22),
      node("side-engine", `Мотор · L${selected.engine}`, `side-engine-l${selected.engine}`, "boat", 0, 0, 260, 570, 23,
        { socketId: "engine", pivotX: 220 / 260, pivotY: 235 / 570 }),
      node("side-tank", `Бак · L${selected.tank}`, `side-tank-l${selected.tank}`, "boat", 0, 0, 300, 230, 24,
        { socketId: "fuel", pivotX: .5, pivotY: 1 }),
    ],
    waterPreview: { rootId: "boat", waterlineY: 633, beam: 1000, amplitude: 7,
      effectsEnabled: false, immersionEnabled: false },
  });
}
