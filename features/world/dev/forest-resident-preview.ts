import { pleskResidentFrame, pleskRoutineDuration, type PleskAction, type PleskResidentFrame } from "../plesk-resident";
import type { FixedWorldScene } from "../tiled/types";
import type { WorldDevState } from "./world-dev-store";

export const RESIDENT_PREVIEW_SECONDS: Record<PleskAction, number> = {
  walk: 3.2, idle: 4, cast: 1.8, fish: 12, bite: 1.5, reel: 3,
  catch: 4, pack: 3, trade: 6, rest: 6, greet: 2.5,
};

/** DEV samples its own elapsed time; the world's routine clock never jumps. */
export function previewForestResidents(scene: FixedWorldScene, elapsed: number, still: boolean,
  preview: WorldDevState["residentPreview"], startedAt = elapsed, natural?: readonly PleskResidentFrame[]): PleskResidentFrame[] {
  const ordinary = () => { if (natural) return [...natural]; const frame = pleskResidentFrame(scene, elapsed, still); return frame ? [frame] : []; };
  if (!preview) return ordinary();
  const age = Math.max(0, Number.isFinite(elapsed - startedAt) ? elapsed - startedAt : 0);
  const duration = preview.action === "routine" ? pleskRoutineDuration(scene) : RESIDENT_PREVIEW_SECONDS[preview.action];
  if (!duration || !preview.repeat && age >= duration) return ordinary();
  const time = preview.repeat ? age % duration : age;
  if (preview.action === "routine") {
    const frame = pleskResidentFrame(scene, time, still); return frame ? [frame] : [];
  }
  const base = pleskResidentFrame(scene, 0, true);
  if (!base) return [];
  const phase = still ? .5 : Math.min(1, time / duration);
  return [{ ...base, action: preview.action, direction: preview.direction, phase,
    frame: still ? 0 : Math.floor(time * (preview.action === "walk" ? 8 : 5)) % 8,
    carryingFish: ["catch", "pack", "trade"].includes(preview.action),
    basketFilled: preview.action === "trade" || preview.action === "pack" && phase > .65 }];
}
