import type { WorldPoint } from "@/features/world/tiled/types";

const TAU = Math.PI * 2;
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
type PotOptions = { time: number; still: boolean; steam: number; covered?: boolean; onHearth?: boolean; burner?: boolean };

/** The rehearsal and real kitchen share one pot. Motion is sampled from the
 * caller's clock; no particle list or timer survives a paint. */
export function drawForestCookingPot(ctx: CanvasRenderingContext2D, pot: WorldPoint, size: number, options: PotOptions) {
  const { still, covered, onHearth, burner } = options;
  const time = still || !Number.isFinite(options.time) ? 0 : options.time;
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
  };
  ctx.save(); ctx.translate(pot.x, pot.y); ctx.scale(size, size);
  if (onHearth) {
    ctx.strokeStyle = "#343d34"; ctx.lineWidth = .025; ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(side * .095, .018); ctx.lineTo(side * .125, .13);
      ctx.lineTo(side * .145, .13); ctx.stroke();
    }
  } else {
    for (const offset of [-.09, 0, .09]) {
      oval(offset, .055, .048, .032, "#626d5e");
      oval(offset - .008, .046, .035, .017, "#b0ab8e");
      oval(offset + .02, .059, .018, .013, "#7c836e");
    }
  }
  if (burner && !covered) {
    const pulse = still ? 1 : 1 + Math.sin(time * 4.3) * .055;
    oval(0, .118, .125, .035, "#573c2c");
    oval(0, .117, .09, .023, "#d98943");
    for (const side of [-1, 1]) {
      const x = side * .065, height = .095 * pulse;
      ctx.fillStyle = "#e9993e";
      ctx.beginPath(); ctx.moveTo(x - .033, .12);
      ctx.bezierCurveTo(x - .037, .09, x + side * .02, .12 - height, x, .12 - height);
      ctx.bezierCurveTo(x + .032, .075, x + .036, .10, x + .033, .12); ctx.closePath(); ctx.fill();
      oval(x, .107, .019, .018, "#ffdb91");
    }
  }
  for (const side of [-1, 1]) {
    ctx.strokeStyle = "#31473f"; ctx.lineWidth = .031;
    ctx.beginPath(); ctx.ellipse(side * .153, -.043, .033, .026, side * -.18, 0, TAU); ctx.stroke();
    ctx.strokeStyle = "#a6b29b"; ctx.lineWidth = .009;
    ctx.beginPath(); ctx.ellipse(side * .155, -.05, .027, .019, side * -.18, Math.PI, TAU); ctx.stroke();
  }
  const body = () => {
    ctx.beginPath(); ctx.moveTo(-.146, -.075); ctx.lineTo(-.133, .021);
    ctx.bezierCurveTo(-.121, .094, .119, .094, .133, .021);
    ctx.lineTo(.146, -.075); ctx.closePath();
  };
  body(); ctx.fillStyle = "#2b4039"; ctx.fill();
  const metal = ctx.createLinearGradient(-.14, 0, .14, 0);
  metal.addColorStop(0, "#42594d"); metal.addColorStop(.24, "#839382");
  metal.addColorStop(.42, "#a4b29c"); metal.addColorStop(.64, "#657c6b"); metal.addColorStop(1, "#354e43");
  ctx.save(); ctx.translate(0, -.005); ctx.scale(.93, .89); body(); ctx.fillStyle = metal; ctx.fill(); ctx.restore();
  ctx.strokeStyle = "#b8c3a5"; ctx.lineWidth = .009; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-.079, -.025); ctx.quadraticCurveTo(-.082, .027, -.043, .044); ctx.stroke();
  oval(0, .065, .086, .014, "#31483c");
  for (const side of [-1, 1]) {
    oval(side * .119, -.044, .012, .008, "#c7ba8d");
    oval(side * .12, -.041, .005, .004, "#516453");
  }
  oval(0, -.077, .152, .053, "#9b9d7d");
  oval(0, -.079, .142, .044, "#c9c2a0");
  oval(0, -.081, .131, .036, "#32473a");
  if (covered) {
    oval(0, -.086, .143, .043, "#586d5a");
    oval(-.013, -.096, .13, .032, "#a2ae91");
    oval(-.023, -.099, .089, .02, "#bdc7a6");
    oval(0, -.111, .028, .012, "#4a5847");
    oval(0, -.124, .021, .013, "#7c633f");
    oval(-.005, -.129, .013, .007, "#b29660");
  } else {
    oval(0, -.081, .123, .03, "#a87740");
    oval(-.025, -.087, .084, .02, "#d5ab62");
    ctx.strokeStyle = "#e7c184"; ctx.lineWidth = .007;
    ctx.beginPath(); ctx.ellipse(-.005, -.082, .089, .018, 0, .1, Math.PI * 1.15); ctx.stroke();
    for (let index = 0; index < 5; index++) {
      const angle = index * 2.1 + time * .45;
      const x = Math.cos(angle) * .077, y = -.082 + Math.sin(angle) * .013;
      oval(x, y, index % 2 ? .015 : .02, .008, index % 2 ? "#648253" : "#e9d293");
      if (index % 2) oval(x - .003, y - .002, .006, .003, "#97b36b");
    }
    if (!still && options.steam > 0) for (let index = 0; index < 3; index++) {
      const age = ((time * .7 + index / 3) % 1 + 1) % 1;
      ctx.strokeStyle = `rgba(252,237,194,${(1 - age) * .55})`; ctx.lineWidth = .006;
      ctx.beginPath(); ctx.ellipse((index - 1) * .063, -.085 + index % 2 * .011,
        .006 + age * .014, .003 + age * .007, 0, 0, TAU); ctx.stroke();
    }
    // A warm narrow front edge gives the ladle a clear entry into the soup.
    ctx.strokeStyle = "#d6c79c"; ctx.lineWidth = .01;
    ctx.beginPath(); ctx.ellipse(0, -.079, .144, .044, 0, 0, Math.PI); ctx.stroke();
  }
  ctx.restore();
}

/** Exactly three soft tracks; reduced motion removes rising steam entirely. */
export function drawForestCookingSteam(ctx: CanvasRenderingContext2D, pot: WorldPoint, size: number,
  time: number, strength: number, still: boolean) {
  if (still || strength <= 0) return;
  time = Number.isFinite(time) ? time : 0;
  const opacity = ctx.globalAlpha;
  ctx.save(); ctx.lineCap = "round";
  for (let index = 0; index < 3; index++) {
    const age = ((time * .27 + index / 3) % 1 + 1) % 1;
    const sx = pot.x + ((index - 1) * .044 + Math.sin(age * 4.5 + index) * .034) * size;
    const sy = pot.y - size * (.13 + age * .21);
    ctx.globalAlpha = opacity * unit(strength) * Math.sin(age * Math.PI) ** 2 * .26;
    ctx.strokeStyle = "#faf1d4"; ctx.lineWidth = size * (.013 + age * .019);
    ctx.beginPath(); ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + size * .039, sy - size * .039, sx - size * .047, sy - size * .083,
      sx + size * .005, sy - size * .115); ctx.stroke();
    ctx.globalAlpha *= .38; ctx.lineWidth *= 1.9; ctx.stroke();
  }
  ctx.restore();
}
