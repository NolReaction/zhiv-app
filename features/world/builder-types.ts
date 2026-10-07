import type { PixelDirection } from "@/features/mochlik/pixel-sprite";

export const BUILDER = { id: "builder", name: "Шишколап", size: 40, speed: 34 } as const;
export type BuilderAction = "idle" | "walk" | "work" | "inspect" | "finish" | "greet";
export type BuilderSleepPhase = "awake" | "approach" | "enter" | "sleep" | "exit";

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
  /** Exterior door fade; sleeping residents have no rendered or hit-test frame. */
  opacity?: number;
  sleepPhase?: BuilderSleepPhase;
};
