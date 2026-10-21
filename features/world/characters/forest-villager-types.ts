import type { PixelDirection } from "@/features/mochlik/pixel-sprite";

export type ForestVillagerId = "lopukh" | "kamneshmyg" | "leaftail";
export type ForestVillagerAction = "idle" | "walk" | "work" | "carry" | "unload" | "inspect" | "greet" | "rest" | "trade";

/** Presentation only; inventory and job completion remain server-authoritative. */
export type ForestVillagerFrame = {
  id: ForestVillagerId;
  x: number;
  y: number;
  size: number;
  direction: PixelDirection;
  action: ForestVillagerAction;
  frame: number;
  phase: number;
  opacity?: number;
  /** Arrival holds ordinary autonomy until the introduction has finished. */
  arriving?: boolean;
};
