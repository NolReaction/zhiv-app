import { pixelSprite, type PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldState } from "./model";
import { FOREST_MAP } from "./map-manifest";
import { journeyTimeline, type Journey } from "./journey-timeline";

// The southeast passage follows the supplied route, under the painted crowns,
// to the bank above the boat. Feet stay on land; only the float enters water.
export const FISHING_PATH = [
  { x: 611, y: 665 }, { x: 648, y: 685 }, { x: 675, y: 697 },
  { x: 710, y: 712 }, { x: 752, y: 751 }, { x: 786, y: 789 },
  { x: 816, y: 816 }, { x: 849, y: 842 }, { x: 889, y: 865 },
  { x: 927, y: 885 }, { x: 967, y: 901 }, { x: 996, y: 918 },
] as const;
export const FISHING_BOBBER = { x: 1035, y: 965 };
const foreground = [
  [{ x: 685, y: 687 }, { x: 711, y: 673 }, { x: 758, y: 698 }, { x: 794, y: 736 }, { x: 825, y: 776 }, { x: 841, y: 806 }, { x: 824, y: 827 }, { x: 788, y: 808 }, { x: 747, y: 776 }, { x: 712, y: 750 }, { x: 681, y: 720 }],
  [{ x: 1008, y: 926 }, { x: 1012, y: 909 }, { x: 1020, y: 899 }, { x: 1025, y: 905 }, { x: 1032, y: 910 }, { x: 1030, y: 926 }],
];
const lengths = FISHING_PATH.slice(1).map((point, i) => Math.hypot(point.x - FISHING_PATH[i].x, point.y - FISHING_PATH[i].y));
const distance = lengths.reduce((sum, length) => sum + length, 0);

export function fishingPosition(progress: number) {
  let remaining = Math.max(0, Math.min(1, progress)) * distance;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const from = FISHING_PATH[i], to = FISHING_PATH[i + 1], part = remaining / lengths[i];
      return { x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part };
    }
    remaining -= lengths[i];
  }
  return { ...FISHING_PATH[0] };
}

export function fishingFrame(journey: Journey, now: number, reducedMotion = false) {
  const timeline = journeyTimeline(journey, now);
  const walking = timeline.phase === "outbound" && timeline.elapsed >= timeline.preparation || timeline.phase === "returning";
  const direction: PixelDirection = timeline.phase === "home" ? "front" : timeline.phase === "returning" ? "left" : "right";
  const seed = [...journey.id].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  const cycle = 28 + seed % 11, beat = timeline.fishingElapsed / 1000 % cycle;
  const catching = !reducedMotion && timeline.phase === "fishing" && beat > cycle - 4;
  return { ...timeline, ...fishingPosition(timeline.position), walking, direction,
    frame: reducedMotion ? 0 : Math.floor(timeline.elapsed / (walking ? 150 : 700)) % 4,
    casting: !reducedMotion && timeline.phase === "fishing" && timeline.fishingElapsed < 1800,
    catchProgress: catching ? (beat - cycle + 4) / 4 : 0,
    bob: reducedMotion ? 0 : Math.sin(timeline.fishingElapsed / 650) * .8 };
}

export function drawFishingJourney(ctx: CanvasRenderingContext2D, journey: Journey, now: number, equipment: WorldState["equipment"], reducedMotion: boolean) {
  const state = fishingFrame(journey, now, reducedMotion), { x, y } = state;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.beginPath(); ctx.rect(0, 0, FOREST_MAP.size, FOREST_MAP.size);
  for (const polygon of foreground) {
    polygon.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
  }
  ctx.clip("evenodd");
  ctx.fillStyle = "#172c2866"; ctx.beginPath(); ctx.ellipse(x, y - 2, 15, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(pixelSprite(state.walking ? "carry" : state.phase === "fishing" ? "fish" : "idle", state.direction, state.frame, equipment), Math.round(x - 24), Math.round(y - 48), 48, 48);
  if (state.phase !== "home") {
    const fishing = state.phase === "fishing", side = state.direction === "left" ? -1 : 1;
    const lift = Math.sin(state.catchProgress * Math.PI), hand = { x: x + side * 7, y: y - 17 };
    const tip = fishing ? { x: x + 28 - lift * 6, y: y - 36 - lift * 12 } : { x: hand.x - side * 17, y: y - 49 };
    ctx.strokeStyle = "#503a22"; ctx.lineWidth = 2.5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(hand.x, hand.y); ctx.quadraticCurveTo(tip.x - side * 4, tip.y + 9, tip.x, tip.y); ctx.stroke();
    ctx.strokeStyle = "#b6a06a"; ctx.lineWidth = 1; ctx.stroke();
    if (fishing) {
      const cast = state.casting ? state.fishingElapsed / 1800 : 1;
      const float = { x: hand.x + (FISHING_BOBBER.x - hand.x) * cast, y: hand.y + (FISHING_BOBBER.y - hand.y) * cast - Math.sin(cast * Math.PI) * 30 - lift * 29 + state.bob };
      ctx.strokeStyle = "#dedab798"; ctx.lineWidth = .7;
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.quadraticCurveTo((tip.x + float.x) / 2, tip.y + 24, float.x, float.y); ctx.stroke();
      ctx.fillStyle = "#d4ba7f"; ctx.fillRect(Math.round(float.x - 1), Math.round(float.y - 2), 2, 3);
      ctx.fillStyle = "#b75d43"; ctx.fillRect(Math.round(float.x - 1), Math.round(float.y - 3), 2, 2);
      if (lift > .05) {
        ctx.fillStyle = "#a5bec0"; ctx.beginPath(); ctx.ellipse(float.x, float.y + 5, 3, 1.5, -.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(Math.round(float.x + 3), Math.round(float.y + 4), 2, 2);
      }
      if (!reducedMotion && !state.casting) {
        const ring = (state.fishingElapsed / 1600) % 1;
        ctx.strokeStyle = `rgba(183,215,201,${(1 - ring) * .4})`; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.ellipse(FISHING_BOBBER.x, FISHING_BOBBER.y + 2, 2 + ring * 7, 1 + ring * 2, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  ctx.restore();
}
