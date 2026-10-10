import type { FixedWorldScene, PreviewLevels, WorldPoint } from "@/features/world/tiled/types";

/** Offsets and uniform scale, relative to the authored ground anchor of one level. */
export type PhaserSiteTransform = { dx: number; dy: number; scale: number };
export type PhaserTransforms = Record<string, PhaserSiteTransform>;
export type PhaserLabMode = "walk" | "inspect" | "place";
export type PhaserWorldOptions = {
  levels: PreviewLevels;
  transforms: PhaserTransforms;
  selectedSiteId: string | null;
  mode: PhaserLabMode;
  grid: boolean;
  geometry: boolean;
  shadows: boolean;
  night: boolean;
  snap: boolean;
  gridSize: number;
  reducedMotion: boolean;
};
export type PhaserWorldStatus = {
  loading: boolean;
  error: string | null;
  message: string;
  renderer: string;
  fps: number;
  zoom: number;
  moving: boolean;
  actor: WorldPoint | null;
};
export type PhaserWorldCallbacks = {
  onSelect(id: string | null): void;
  onTransform(siteId: string, level: number, transform: PhaserSiteTransform): void;
  onStatus(status: PhaserWorldStatus): void;
};
export type PhaserWorldHandle = {
  update(options: PhaserWorldOptions): void;
  focus(target: "world" | "actor" | string): void;
  zoom(factor: number): void;
  reset(): void;
  dispose(): void;
};
export type PhaserWorldFactory = (
  parent: HTMLElement,
  source: FixedWorldScene,
  options: PhaserWorldOptions,
  callbacks: PhaserWorldCallbacks,
  signal?: AbortSignal,
) => PhaserWorldHandle;
