import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { ForestCookingFrame } from "./forest-cooking";
import { drawGroundedHero } from "./grounding";
import type { WorldPoint } from "./tiled/types";
import type { ForestProductionFrame } from "./economy-production-state";
import { drawForestCookingPot, drawForestCookingSteam } from "./forest-cooking-pot";

type Appearance = { palette: string; head: string | null; neck: string | null };
type CookingArm = { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint };
const TAU = Math.PI * 2;
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smooth = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };
const mix = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Compact paws have a shared grip with every utensil. Gestures enter and leave
 * through the same resting wrists; neither preparation nor serving stretches
 * an arm across the body to a distant counter. */
export function forestCookingHeroRig(frame: ForestCookingFrame, still = false) {
  const { x, y, size, action } = frame, side = frame.direction === "left" ? -1 : 1;
  const phase = still ? .5 : unit(frame.phase);
  const work = smooth(phase / .16) * (1 - smooth((phase - .84) / .16));
  const wave = still ? 0 : Math.sin(phase * TAU * (action === "prepare" ? 5 : 3));
  const point = (dx: number, dy: number) => ({ x: x + side * size * dx, y: y + size * dy });
  const nearShoulder = point(.195, -.25), farShoulder = point(-.195, -.25);
  const nearRest = point(.235, -.19), farRest = point(-.225, -.19);
  const board = point(-.02, -.027), pot = point(.42, -.07);
  const serving = action === "serve" ? work : 0;
  const bowl = mix(point(-.25, -.02), point(0, -.18), serving);
  let near = nearRest, far = farRest;
  if (action === "prepare") {
    near = mix(nearRest, point(.09, -.13 - Math.max(0, wave) * .045), work);
    far = mix(farRest, point(-.135, -.075), work);
  } else if (action === "stir") {
    near = mix(nearRest, point(.265 + wave * .025, -.26 + (still ? 0 : Math.cos(phase * TAU * 3) * .018)), work);
  } else if (action === "taste") {
    const tasting = smooth(phase / .32) * (1 - smooth((phase - .64) / .25));
    near = mix(nearRest, point(.095, -.335), tasting);
  } else {
    near = mix(nearRest, { x: bowl.x + side * size * .112, y: bowl.y - size * .02 }, serving);
    far = mix(farRest, { x: bowl.x - side * size * .112, y: bowl.y - size * .02 }, serving);
  }
  const arm = (shoulder: WorldPoint, hand: WorldPoint, sign: number): CookingArm => ({ shoulder, hand,
    elbow: { x: shoulder.x + (hand.x - shoulder.x) * .48 + side * sign * size * .018,
      y: Math.max(shoulder.y, hand.y) + size * .025 } });
  const toolTip = action === "prepare" ? { x: near.x - side * size * .015, y: near.y + size * .083 }
    : action === "taste" ? { x: near.x - side * size * .03, y: near.y - size * .06 }
      : point(.42 + wave * .025, -.14 + (still ? 0 : Math.cos(phase * TAU * 3) * .016));
  const pose: PixelPose = action === "taste" && phase > .35 && phase < .73 ? "chew"
    : action === "serve" && phase > .35 && phase < .7 ? "blink" : "idle";
  return { near: arm(nearShoulder, near, 1), far: arm(farShoulder, far, -1), toolTip, board, pot, bowl,
    phase, work, side, wave, pose, crouch: action === "prepare" ? Math.round(work * 2) : 0 };
}

/** The rehearsal's tools use the same grounded pot art as the real kitchen.
 * A paint never consumes an ingredient or advances a production job. */
export function drawForestCookingHero(ctx: CanvasRenderingContext2D, frame: ForestCookingFrame,
  appearance: Appearance | undefined, still: boolean, shadow = true) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const rig = forestCookingHeroRig(frame, still), { size, action, direction } = frame;
  const { board, pot, bowl, side, phase } = rig;
  const back = direction === "back";
  const armShade = back ? appearance?.palette === "fern" ? "#345649" : appearance?.palette === "autumn" ? "#7a5637" : "#58683b" : "#d8bf83";
  const armLight = back ? appearance?.palette === "fern" ? "#49816b" : appearance?.palette === "autumn" ? "#b27b42" : "#7c8845" : "#f4e4ae";
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
  };
  const segment = (a: WorldPoint, b: WorldPoint, color: string, width: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = size * width; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  const drawArm = (arm: CookingArm) => {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const [color, width, dy] of [[armShade, .082, 0], [armLight, .054, -.01]] as const) {
      ctx.strokeStyle = color; ctx.lineWidth = size * width;
      ctx.beginPath(); ctx.moveTo(arm.shoulder.x, arm.shoulder.y + size * dy);
      ctx.lineTo(arm.elbow.x, arm.elbow.y + size * dy); ctx.lineTo(arm.hand.x, arm.hand.y + size * dy); ctx.stroke();
    }
  };
  const drawBoard = () => {
    oval(board.x, board.y + size * .025, size * .245, size * .052, "#65503a");
    oval(board.x, board.y, size * .245, size * .047, "#b38a55");
    oval(board.x, board.y - size * .008, size * .217, size * .031, "#d2ab72");
    segment({ x: board.x - size * .12, y: board.y + size * .004 },
      { x: board.x + size * .14, y: board.y + size * .004 }, "#bc935e", .012);
    if (action !== "prepare") return;
    // Only the knife-side ingredient separates into pieces. The supporting paw
    // remains beside the cut, with the blade fixed to the other actual wrist.
    const chopped = phase > .2 ? Math.min(4, Math.floor(phase * 5)) : 0;
    for (let index = 0; index < 5; index++) {
      const dx = index < chopped ? -.065 + index * .032 : -.075 + index * .025;
      oval(board.x + side * size * dx, board.y - size * (.023 + (index < chopped ? .008 : 0)),
        size * .019, size * .014, index % 2 ? "#d49c55" : "#dfb977");
    }
    oval(board.x - side * size * .145, board.y - size * .026, size * .035, size * .017, "#7f9b4d");
  };
  const drawPot = () => drawForestCookingPot(ctx, pot, size, { time: phase * 4, still, steam: frame.steam });
  const drawBowl = () => {
    oval(bowl.x, bowl.y + size * .004, size * .115, size * .06, "#795438");
    oval(bowl.x, bowl.y - size * .022, size * .12, size * .039, "#c3965e");
    oval(bowl.x, bowl.y - size * .025, size * .098, size * .025, action === "serve" ? "#deb575" : "#896945");
    if (action === "serve") {
      oval(bowl.x - size * .032, bowl.y - size * .028, size * .025, size * .012, "#ece0b1");
      oval(bowl.x + size * .035, bowl.y - size * .029, size * .025, size * .012, "#749552");
    }
  };
  const drawTool = () => {
    if (action === "serve") return;
    const grip = rig.near.hand, tip = rig.toolTip;
    const dx = tip.x - grip.x, dy = tip.y - grip.y;
    const handle = { x: grip.x - dx * .25, y: grip.y - dy * .25 };
    segment(handle, tip, "#66523b", .024);
    if (action === "prepare") {
      ctx.fillStyle = "#adc1bd";
      ctx.beginPath(); ctx.moveTo(grip.x, grip.y + size * .018);
      ctx.lineTo(tip.x + side * size * .052, tip.y - size * .008);
      ctx.lineTo(tip.x + side * size * .05, tip.y + size * .013);
      ctx.lineTo(tip.x, tip.y + size * .019); ctx.closePath(); ctx.fill();
    } else {
      oval(tip.x, tip.y, size * .038, size * .018, "#7f6544");
      oval(tip.x, tip.y - size * .004, size * .026, size * .01, "#d7b478");
    }
  };
  const drawWork = () => {
    drawBoard(); drawPot(); drawBowl(); drawArm(rig.far); drawArm(rig.near); drawTool();
    for (const arm of [rig.far, rig.near]) oval(arm.hand.x, arm.hand.y, size * .033, size * .033, armLight);
    if (action !== "serve") {
      // A crease across the actual utensil handle keeps the grip legible at 36 px.
      segment({ x: rig.near.hand.x - size * .018, y: rig.near.hand.y + size * .009 },
        { x: rig.near.hand.x + size * .018, y: rig.near.hand.y + size * .009 }, armShade, .012);
    }
  };
  ctx.save();
  if (shadow) {
    oval(pot.x, frame.y + size * .012, size * .19, size * .044, "rgba(28,42,30,.13)");
    oval(board.x, board.y + size * .047, size * .255, size * .038, "rgba(28,42,30,.10)");
    if (action !== "serve") oval(bowl.x, bowl.y + size * .05, size * .115, size * .025, "rgba(28,42,30,.1)");
  }
  if (back) drawWork();
  drawGroundedHero(ctx, { x: frame.x, y: frame.y, size, pose: rig.pose, direction,
    frame: still ? 0 : frame.frame, appearance, shadow, rig: { gardening: true, crouch: rig.crouch },
    breathe: still ? 0 : Math.sin(phase * TAU) * .003 });
  if (!back) drawWork();
  drawForestCookingSteam(ctx, pot, size, phase * 8, frame.steam, still);
  ctx.restore();
}

/** The authored hearth owns placement, while the job owns working/ready.
 * Rendering a closed ready pot never collects a batch or restarts the fire. */
export function drawForestProductionCooking(ctx: CanvasRenderingContext2D, frame: ForestProductionFrame, still: boolean) {
  if (frame.stationId !== "dryer" || ![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const pot = { x: frame.x, y: frame.y - frame.size * .13 }, working = frame.phase === "working";
  ctx.save();
  drawForestCookingPot(ctx, pot, frame.size, { time: frame.elapsed, still, steam: working ? .75 : 0,
    covered: !working, onHearth: true, burner: working });
  drawForestCookingSteam(ctx, pot, frame.size, frame.elapsed, working ? .75 : 0, still);
  ctx.restore();
}

export function forestProductionCookingBounds(frame: Pick<ForestProductionFrame, "x" | "y" | "size">) {
  return { x: frame.x - frame.size * .24, y: frame.y - frame.size * .72,
    width: frame.size * .48, height: frame.size * .77 };
}
