import type { BuilderAction, BuilderResidentFrame } from "@/features/world/characters/builder/builder-types";
import type { WorldDevBuilderPreview } from "./world-dev-store";

export const BUILDER_PREVIEW_SECONDS: Readonly<Record<BuilderAction, number>> = Object.freeze({
  idle: 4, walk: 3.2, work: 2.2, inspect: 2.4, finish: 1.4, greet: 2,
});

export function builderPreviewActive(preview: WorldDevBuilderPreview | null | undefined, elapsed: number, startedAt = elapsed): boolean {
  if (!preview) return false;
  const duration = BUILDER_PREVIEW_SECONDS[preview.action];
  const age = Math.max(0, Number.isFinite(elapsed - startedAt) ? elapsed - startedAt : 0);
  return Boolean(duration && (preview.repeat || age < duration));
}

/** Sampling changes only the drawing. Feet, route, work order and AI are untouched. */
export function previewForestBuilder(natural: BuilderResidentFrame | null, elapsed: number, still: boolean,
  preview: WorldDevBuilderPreview | null, startedAt = elapsed): BuilderResidentFrame | null {
  if (!natural || !preview || !builderPreviewActive(preview, elapsed, startedAt)) return natural;
  const age = Math.max(0, Number.isFinite(elapsed - startedAt) ? elapsed - startedAt : 0);
  const duration = BUILDER_PREVIEW_SECONDS[preview.action];
  const time = preview.repeat ? age % duration : age;
  return { ...natural, action: preview.action, direction: preview.direction,
    phase: still ? .5 : Math.min(1, time / duration),
    frame: still ? 0 : Math.floor(time * 8) % (preview.action === "walk" ? 8 : 32) };
}
