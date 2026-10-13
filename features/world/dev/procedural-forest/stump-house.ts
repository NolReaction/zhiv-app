/** Painted stump cottage. Its ground anchor is directly below the doorway. */
type Context = CanvasRenderingContext2D;
type Random = () => number;
type Paint = string | CanvasGradient;

function randomFor(variant: number): Random {
  let value = (Math.imul(variant | 0, 747796405) + 23971937) >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

function shape(ctx: Context, outline: string, paint: Paint, edge?: string, width = 1) {
  const path = new Path2D(outline);
  ctx.fillStyle = paint; ctx.fill(path);
  if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = width; ctx.stroke(path); }
}

function ellipse(ctx: Context, x: number, y: number, rx: number, ry: number, paint: Paint, angle = 0) {
  ctx.fillStyle = paint; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2); ctx.fill();
}

function line(ctx: Context, outline: string, paint: string, width = 1) {
  ctx.strokeStyle = paint; ctx.lineWidth = width; ctx.stroke(new Path2D(outline));
}

/** The leaves have pointed ends and shaded halves; larger leaves also carry veins. */
function leaf(ctx: Context, x: number, y: number, length: number, width: number, angle: number, tone: number, veins = false) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  const colors = ["#667b28", "#86952d", "#a7b43b", "#bac64b", "#c7ce59", "#d5d572"];
  const paint = colors[Math.max(0, Math.min(colors.length - 1, tone))];
  shape(ctx, `M0 1 C${-width} ${-length * .22} ${-width * .9} ${-length * .7} 0 ${-length} C${width * .88} ${-length * .62} ${width * .95} ${-length * .18} 0 1Z`, paint, veins ? "#4d602b" : undefined, .6);
  shape(ctx, `M0 0 C${width * .9} ${-length * .2} ${width * .8} ${-length * .65} 0 ${-length} Q${width * .16} ${-length * .46} 0 0Z`, veins ? "#71852f66" : "#435e262e");
  if (veins) {
    line(ctx, `M0 0 Q${width * .16} ${-length * .48} 0 ${-length * .94}`, "#d4d077", .9);
    for (let i = 1; i <= 4; i++) {
      const y = -length * (i * .16 + .06), reach = width * Math.sin((i * .16 + .06) * Math.PI) * .73;
      line(ctx, `M0 ${y} Q${-reach * .45} ${y - length * .03} ${-reach} ${y - length * .12} M0 ${y} Q${reach * .5} ${y - length * .01} ${reach} ${y - length * .1}`, "#4e652d83", .65);
    }
  }
  ctx.restore();
}

function moss(ctx: Context, random: Random, x: number, y: number, rx: number, ry: number, count: number, light = 0) {
  ellipse(ctx, x + 1, y + 2, rx, ry, "#465326a6", -.12);
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2, r = Math.sqrt(random());
    const px = x + Math.cos(a) * r * rx, py = y + Math.sin(a) * r * ry;
    leaf(ctx, px, py, 2 + random() * 4.5, 1 + random() * 1.4, random() * Math.PI * 2, Math.floor(random() * 4) + light);
    if (i % 8 === 0) ellipse(ctx, px - 1, py - 1, .8, .5, "#d6d16ba8");
  }
}

function trailingMoss(ctx: Context, random: Random, x: number, y: number, length: number, direction = 1) {
  const bend = direction * (3 + random() * 5);
  line(ctx, `M${x} ${y} Q${x + bend} ${y + length * .45} ${x + bend * .45} ${y + length}`, "#607029", 1.4);
  for (let i = 0; i < length / 3; i++) {
    const t = i * 3 / length, px = x + Math.sin(t * Math.PI) * bend;
    leaf(ctx, px, y + t * length, (1 - t * .5) * (4 + random() * 2), 1.4, i % 2 ? -.85 : .95, 1 + Math.floor(random() * 3));
  }
}

function fern(ctx: Context, x: number, y: number, size: number, angle: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  for (const direction of [-.65, -.12, .48]) {
    const length = size * (direction === -.12 ? 1 : .83);
    ctx.save(); ctx.rotate(direction);
    line(ctx, `M0 0 Q3 ${-length * .45} 0 ${-length}`, "#719030", 1);
    for (let i = 0; i < 5; i++) {
      const yy = -length * (.14 + i * .16), reach = length * (.28 - i * .038);
      leaf(ctx, 0, yy, reach, reach * .29, -.88, 2 + i % 3);
      leaf(ctx, 0, yy, reach * .93, reach * .27, .88, 2 + (i + 1) % 3);
    }
    leaf(ctx, 0, -length * .78, length * .28, length * .08, 0, 4);
    ctx.restore();
  }
  ctx.restore();
}

const trunk = `M-73 -167 C-79 -136 -74 -97 -90 -55 C-97 -27 -122 -13 -151 10
  Q-167 18 -155 25 C-132 30 -113 11 -91 12 Q-106 34 -88 28 L-63 18
  C-61 30 -78 35 -64 38 C-40 35 -27 21 -15 20 L39 19 Q56 37 75 35
  C87 36 97 28 103 24 C126 27 146 39 162 31 Q168 27 158 14
  C139 -3 128 -16 123 -45 C112 -81 118 -122 111 -162
  C94 -191 65 -202 31 -203 C-9 -210 -46 -194 -73 -167Z`;

function bark(ctx: Context, random: Random) {
  const base = ctx.createLinearGradient(-85, -100, 120, -90);
  base.addColorStop(0, "#76552e"); base.addColorStop(.2, "#b4894f"); base.addColorStop(.53, "#876136"); base.addColorStop(.82, "#63482a"); base.addColorStop(1, "#3d3926");
  shape(ctx, trunk, base, "#303523", 2);
  ctx.save(); ctx.clip(new Path2D(trunk));
  // Long irregular plates, branching into the buttress roots, give the bark thickness.
  for (let i = 0; i < 18; i++) {
    const x = -86 + i * 11.5, width = 8 + random() * 9;
    const start = -164 + Math.sqrt(Math.max(0, 1 - ((x - 19) / 98) ** 2)) * 48;
    const end = x < -40 ? x - 37 : x > 70 ? x + 27 : x + (random() - .5) * 24;
    const shade = i < 8 ? ["#c69b5a", "#ab7d43", "#8d6638"] : ["#99703f", "#725333", "#aa804b"];
    const outline = `M${x} ${start - 8} C${x + width * .35} ${start + 31} ${x - width * .25} -48 ${end} 37
      L${end + width} 40 C${x + width * .4} -40 ${x + width * 1.2} ${start + 18} ${x + width} ${start - 10}Z`;
    shape(ctx, outline, shade[i % shade.length], "#3c342675", 1.3);
    line(ctx, `M${x + 1} ${start} C${x + 3} ${start + 37} ${x - 6} -36 ${end + 1} 29`, i < 10 ? "#dfb97695" : "#c19a6178", 1.5);
    line(ctx, `M${x + width - 2} ${start + 2} Q${x + width + 1} -60 ${end + width - 2} 37`, "#352d236c", 1.1);
  }
  for (let i = 0; i < 108; i++) {
    const x = -115 + random() * 267, y = -169 + random() * 201;
    const length = 7 + random() * 25, bend = (random() - .5) * 8;
    line(ctx, `M${x} ${y} Q${x + bend} ${y + length * .45} ${x - bend * .3} ${y + length}`, i % 4 === 0 ? "#ddad6865" : i % 3 ? "#3d342754" : "#b38c4f80", .4 + random() * .8);
  }
  ctx.restore();
  // Two roots cross the silhouette rather than ending in a flat, cylindrical base.
  const root = ctx.createLinearGradient(-40, -8, 7, 44);
  root.addColorStop(0, "#bd9154"); root.addColorStop(.55, "#9b7140"); root.addColorStop(1, "#5d492d");
  shape(ctx, "M43 -34 C40 -6 22 5 4 20 Q-17 34 -43 43 Q-39 49 -21 48 L-2 39 Q-13 50 1 48 C24 39 48 20 60 2 Q56 -15 57 -34Z", root, "#393727", 1.5);
  line(ctx, "M49 -25 C44 1 20 24 -30 43 M56 -12 C51 8 34 23 3 43", "#d0a5689a", 2);
  line(ctx, "M50 -12 C49 9 26 25 -7 46 M-21 38 L-27 44", "#523e2e9c", 1.3);
}

function cutFace(ctx: Context, random: Random) {
  const rim = "M-80 -167 C-86 -184 -59 -203 -34 -208 C-8 -222 29 -214 60 -204 C88 -207 115 -187 116 -166 C123 -148 107 -130 94 -121 C65 -103 20 -103 -13 -117 C-39 -127 -64 -142 -80 -167Z";
  shape(ctx, rim, "#7b5b33", "#3c3926", 1.8);
  const cut = ctx.createLinearGradient(-51, -201, 71, -124);
  cut.addColorStop(0, "#c49a5f"); cut.addColorStop(.48, "#d7ae6b"); cut.addColorStop(1, "#bd8f4e");
  ctx.save(); ctx.translate(21, -163); ctx.rotate(.17);
  ellipse(ctx, 0, 0, 87, 46, cut);
  ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 87, 46, 0, 0, Math.PI * 2); ctx.clip();
  for (let ring = 1; ring <= 15; ring++) {
    const rx = ring * 6.1, ry = ring * 3.16;
    ctx.beginPath();
    for (let step = 0; step <= 72; step++) {
      const angle = step / 72 * Math.PI * 2, ripple = Math.sin(angle * 5 + ring * .31) * .65 + Math.sin(angle * 9 - ring * .4) * .3;
      const x = Math.cos(angle) * (rx + ripple) - 3, y = Math.sin(angle) * (ry + ripple * .5) + 1;
      if (step) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.strokeStyle = ring % 3 ? "#8f63368f" : "#a5753ca6"; ctx.lineWidth = ring % 4 === 0 ? 1.8 : 1.1; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-3, 1, rx - 1.4, ry - .65, 0, 0, Math.PI * 2); ctx.strokeStyle = "#e3c18368"; ctx.lineWidth = .7; ctx.stroke();
  }
  for (const [x, y] of [[-74, -20], [73, -17], [47, 37], [-10, 45], [3, -46]]) {
    const endX = x * (.27 + random() * .25), endY = y * (.26 + random() * .3);
    line(ctx, `M${x} ${y} L${x * .71} ${y * .74} L${x * .66 + 3} ${y * .59} L${endX} ${endY}`, "#503d277d", 1.4);
    line(ctx, `M${x - 2} ${y + 1} L${x * .7 - 2} ${y * .72 + 1}`, "#ead199a0", 1);
  }
  ellipse(ctx, -3, 1, 3.8, 2.2, "#bd9355");
  ctx.restore(); ctx.restore();
  // Broken outer bark around the cut is visibly thicker than the growth rings.
  for (const [x, y, w, h] of [[-77, -169, 12, 10], [-59, -193, 16, 9], [-28, -212, 15, 6], [56, -204, 12, 7], [102, -181, 10, 13], [107, -145, 9, 13], [79, -123, 11, 8], [34, -112, 14, 7], [-22, -124, 14, 9]]) {
    shape(ctx, `M${x} ${y} l${w * .6} ${-h * .3} l${w * .4} ${h * .7} l${-w * .2} ${h * .6} l${-w * .8} ${-h * .2}Z`, "#aa804b", "#644c2e", .7);
    line(ctx, `M${x + 1} ${y} l${w * .58} ${-h * .23} l${w * .3} ${h * .55}`, "#dfb877", 1.4);
  }
}

function doorway(ctx: Context) {
  const opening = "M-42 1 C-43 -29 -48 -46 -37 -65 C-24 -89 -2 -88 12 -66 C23 -48 27 -18 22 5 L-42 1Z";
  shape(ctx, opening, "#242a23", "#403624", 3);
  ctx.save(); ctx.clip(new Path2D(opening));
  const dark = ctx.createLinearGradient(-38, -73, 26, 4);
  dark.addColorStop(0, "#171f1d"); dark.addColorStop(.5, "#30342a"); dark.addColorStop(1, "#51442d");
  ctx.fillStyle = dark; ctx.fillRect(-50, -95, 90, 110);
  for (let i = 0; i < 8; i++) {
    const x = -39 + i * 8;
    line(ctx, `M${x} -85 Q${x + 3} -51 ${x + 1} -19`, i % 3 ? "#151e1b98" : "#70553575", 2);
    line(ctx, `M${x + 2} -80 L${x + 3} -23`, "#75604739", .6);
  }
  const floor = "M-43 -16 L8 -38 L39 -9 L22 7 L-40 3Z";
  shape(ctx, floor, "#8e693d", "#3f3426", 1);
  ctx.save(); ctx.clip(new Path2D(floor));
  for (let i = 0; i < 7; i++) {
    const y = -56 + i * 8;
    const outline = `M-70 ${y} L45 ${y + 48} L45 ${y + 56} L-70 ${y + 8}Z`;
    shape(ctx, outline, ["#997343", "#a37e49", "#b08a50", "#8c673d"][i % 4], "#493b297e", 1);
    line(ctx, `M-61 ${y + 5} Q-18 ${y + 20} 23 ${y + 43} M-35 ${y + 16} Q-20 ${y + 22} -11 ${y + 26}`, "#dfb3725c", .6);
  }
  ctx.restore(); ctx.restore();
  // Uneven carved jambs expose a lighter edge around the deep, dark opening.
  line(ctx, "M-48 1 C-52 -29 -47 -50 -33 -70 Q-10 -98 10 -73 C25 -56 28 -25 25 4", "#775230", 6);
  line(ctx, "M-48 -1 C-49 -28 -43 -56 -31 -69 M13 -69 C25 -48 28 -16 24 3", "#d0a164b5", 2.1);
  line(ctx, "M-37 -71 Q-19 -84 -8 -83", "#e0b67583", 2);
  shape(ctx, "M-42 2 L22 7 L20 11 L-41 6Z", "#8b6c41", "#403826", .8);
}

function lantern(ctx: Context) {
  ctx.save(); ctx.translate(39, -27);
  const glow = ctx.createRadialGradient(0, -1, 1, 0, -1, 29);
  glow.addColorStop(0, "#ffdb6c4d"); glow.addColorStop(.5, "#e7af3a22"); glow.addColorStop(1, "#e7af3a00");
  ellipse(ctx, 0, -1, 29, 33, glow);
  line(ctx, "M-1 -21 L1 -30 L10 -36", "#3b3528", 4);
  line(ctx, "M-1 -22 L1 -30 L10 -35", "#af8950", 2);
  ctx.strokeStyle = "#423929"; ctx.lineWidth = 1.7; ctx.beginPath(); ctx.ellipse(-1, -25, 3.5, 5, .15, 0, Math.PI * 2); ctx.stroke();
  shape(ctx, "M-10 -12 L-9 11 Q0 19 9 10 L10 -12Z", "#4d3e26", "#302f24", 1.5);
  const glass = ctx.createLinearGradient(-8, 0, 8, 0);
  glass.addColorStop(0, "#df9226"); glass.addColorStop(.35, "#ffeb8a"); glass.addColorStop(.6, "#ffcf49"); glass.addColorStop(1, "#b96d1d");
  shape(ctx, "M-7 -9 L-6 10 Q0 13 6 9 L7 -9Z", glass);
  shape(ctx, "M-1 8 C-8 4 -4 -2 1 -6 C0 1 6 3 2 9Z", "#fff4b3");
  line(ctx, "M-8 -11 L-7 12 M0 -11 L0 13 M8 -11 L7 12", "#76582b", 1.5);
  shape(ctx, "M-12 -12 Q-11 -18 -5 -20 L-1 -26 L4 -20 Q10 -17 12 -12 Q0 -6 -12 -12Z", "#7c623b", "#343326", 1.4);
  line(ctx, "M-10 -13 Q0 -9 10 -13 M-6 -19 L-2 -24", "#b49a62", 1);
  shape(ctx, "M-11 11 Q0 16 10 10 L9 15 Q0 21 -9 15Z", "#685133", "#343025", 1);
  ctx.restore();
}

function sapling(ctx: Context) {
  line(ctx, "M82 -179 C85 -201 93 -223 101 -243 Q107 -257 117 -266", "#3d4428", 5.5);
  line(ctx, "M82 -178 C86 -203 94 -226 101 -242 Q108 -258 117 -266", "#9e8045", 3.4);
  line(ctx, "M83 -181 C88 -204 94 -226 103 -244", "#cfaa64", 1.1);
  line(ctx, "M97 -232 Q79 -237 73 -247 M94 -221 Q113 -232 123 -226 M104 -246 L100 -267", "#8d7940", 2.3);
  leaf(ctx, 99, -237, 34, 11.5, -1.05, 3, true);
  leaf(ctx, 107, -248, 32, 10.5, .52, 4, true);
  leaf(ctx, 101, -253, 24, 7, -.37, 2, true);
  leaf(ctx, 95, -218, 32, 10.5, 1.15, 2, true);
}

/** Local painted bounds, including roots and warm light: x -170…170, y -286…50. */
export function drawStumpHouse(ctx: Context, variant: number): void {
  const random = randomFor(variant);
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  const shadow = ctx.createRadialGradient(12, 10, 15, 12, 10, 170);
  shadow.addColorStop(0, "#15291ad1"); shadow.addColorStop(.7, "#172b197a"); shadow.addColorStop(1, "#172b1900");
  ellipse(ctx, 12, 11, 158, 38, shadow);
  ellipse(ctx, 14, 8, 141, 29, "#39492382");
  fern(ctx, -105, -6, 35, -.55); fern(ctx, 129, 6, 30, .8);
  moss(ctx, random, -111, 7, 28, 9, 40); moss(ctx, random, 118, 13, 36, 13, 45);
  bark(ctx, random); cutFace(ctx, random); doorway(ctx);
  // Back rim, left shoulder and right buttress carry separate, irregular leaf carpets.
  for (const [x, y, rx, ry, count] of [
    [-26, -205, 39, 13, 80], [13, -207, 27, 11, 50], [-62, -175, 24, 16, 45],
    [-48, -150, 29, 15, 70], [-13, -131, 31, 10, 50], [85, -183, 20, 13, 35],
    [102, -161, 16, 19, 40], [85, -123, 22, 13, 45], [28, -117, 27, 11, 55],
    [-75, -55, 10, 14, 22], [-99, -3, 23, 8, 34], [110, -3, 19, 15, 30],
    [65, 13, 18, 13, 40], [-2, 30, 23, 10, 40],
  ]) moss(ctx, random, x, y, rx, ry, count, y < -160 ? 1 : 0);
  for (const [x, y, length] of [[-69, -162, 44], [-48, -137, 51], [-29, -126, 24], [11, -116, 28], [36, -113, 47], [63, -118, 59], [91, -137, 41], [103, -158, 56]]) {
    trailingMoss(ctx, random, x, y, length);
    trailingMoss(ctx, random, x + 4, y + 3, length * .64, -1);
  }
  // The larger foreground rosettes echo the reference without masking the doorway.
  fern(ctx, -71, 18, 27, -.4); fern(ctx, 107, 26, 23, .45);
  for (const [x, y, size] of [[44, -111, 11], [-65, -171, 10], [-18, -197, 8], [89, -183, 10], [78, 15, 8]]) {
    for (let i = 0; i < 5; i++) leaf(ctx, x, y, size, size * .29, i / 5 * Math.PI * 2, 2 + i % 3);
  }
  // A worn doorstep sits in front of the floorboards, with a mossy, rounded foot.
  ellipse(ctx, -34, 15, 22, 10, "#263b2587", .12);
  shape(ctx, "M-56 10 Q-51 0 -35 -1 Q-22 -2 -12 8 L-11 13 Q-30 27 -53 18Z", "#9b9b6c", "#4f5734", 1.1);
  shape(ctx, "M-54 9 Q-48 1 -35 1 Q-22 0 -14 9 Q-20 17 -36 17 Q-50 17 -54 9Z", "#beb58a");
  for (let i = 0; i < 12; i++) ellipse(ctx, -49 + random() * 31, 4 + random() * 9, 1.1 + random() * 1.6, .6 + random(), i % 3 ? "#d4cba296" : "#8d90637d");
  moss(ctx, random, -51, 17, 8, 3, 12); moss(ctx, random, -17, 13, 5, 3, 10);
  lantern(ctx); sapling(ctx);
  ctx.restore();
}
