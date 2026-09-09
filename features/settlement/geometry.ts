export const SCENE_WIDTH = 1000;
export const SCENE_HEIGHT = 720;
export const HALF_TILE_WIDTH = 41;
export const HALF_TILE_HEIGHT = 20.5;
export function project(x: number, y: number) {
  return { x: 500 + (x - y) * HALF_TILE_WIDTH, y: 145 + (x + y) * HALF_TILE_HEIGHT };
}
export function unproject(x: number, y: number) {
  return { x: ((x - 500) / HALF_TILE_WIDTH + (y - 145) / HALF_TILE_HEIGHT) / 2,
    y: ((y - 145) / HALF_TILE_HEIGHT - (x - 500) / HALF_TILE_WIDTH) / 2 };
}
