import type { PixelDirection } from "@/features/mochlik/pixel-sprite";

export const BUILDER = { id: "builder", name: "Шишколап", size: 40, speed: 34 } as const;
export type BuilderAction = "idle" | "walk" | "work" | "inspect" | "finish" | "greet";

/** A display frame only: building progress belongs to the economy clock. */
export type BuilderResidentFrame = {
  id: "builder";
  x: number;
  y: number;
  size: number;
  direction: PixelDirection;
  action: BuilderAction;
  frame: number;
  phase: number;
  targetId?: string;
};
