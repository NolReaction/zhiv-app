/** Code-painted foliage. Coordinates are relative to the contact point on the ground. */
type Random = () => number;

function randomFor(variant: number): Random {
  let state = (Math.imul(variant | 0, 747796405) + 2891336453) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function leaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  light: number,
  hue: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const gradient = ctx.createLinearGradient(-width, 0, width * 0.65, -length);
  gradient.addColorStop(0, `hsl(${hue + 14} 42% ${light * 0.43}%)`);
  gradient.addColorStop(0.52, `hsl(${hue} 44% ${light}%)`);
  gradient.addColorStop(1, `hsl(${hue - 8} 43% ${light * 1.18}%)`);
  ctx.fillStyle = gradient;
  ctx.strokeStyle = `hsla(${hue + 12},45%,9%,0.72)`;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(0, 1);
  ctx.bezierCurveTo(-width * 0.82, -length * 0.27, -width * 0.67, -length * 0.73, 0.1, -length);
  ctx.bezierCurveTo(width * 0.8, -length * 0.65, width * 0.64, -length * 0.22, 0, 1);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.12, -length * 0.12);
  ctx.quadraticCurveTo(-width * 0.08, -length * 0.5, 0.15, -length * 0.86);
  ctx.strokeStyle = `hsla(${hue - 14},49%,${light * 1.45}%,0.36)`;
  ctx.lineWidth = 0.55;
  ctx.stroke();
  ctx.restore();
}

function crownCluster(
  ctx: CanvasRenderingContext2D,
  random: Random,
  x: number,
  y: number,
  radius: number,
  light: number,
  hue: number,
) {
  // Overlapping pointed leaves make the silhouette; there is no circular canopy stamp.
  const count = 10 + Math.floor(random() * 5);
  const phase = random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const angle = phase + (i / count) * Math.PI * 2 + (random() - 0.5) * 0.17;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const litSide = -dx * 0.8 - dy * 0.7;
    const length = radius * (0.77 + random() * 0.28);
    leaf(ctx, x + dx * 0.4, y + dy * 0.4, angle, length, length * (0.24 + random() * 0.1), light + litSide * 7, hue);
  }
  // Short inner leaves prevent a repeated flower-like hole at the centre.
  for (let i = 0; i < 4; i++) {
    const angle = phase + i * 1.55 + random() * 0.4;
    const length = radius * (0.4 + random() * 0.24);
    leaf(ctx, x + (random() - 0.5) * 4, y + (random() - 0.5) * 3, angle, length, length * 0.3, light + 2, hue - 3);
  }
}

function trunk(ctx: CanvasRenderingContext2D, random: Random, lean: number) {
  const bark = ctx.createLinearGradient(-13, 0, 14, -10);
  bark.addColorStop(0, "#273828");
  bark.addColorStop(0.22, "#65482c");
  bark.addColorStop(0.44, "#a27a42");
  bark.addColorStop(0.63, "#765330");
  bark.addColorStop(1, "#25372a");
  ctx.fillStyle = bark;
  ctx.strokeStyle = "#173527";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-26, 4);
  ctx.bezierCurveTo(-8, -4, -13, -20, -13 + lean, -34);
  ctx.bezierCurveTo(-17 + lean, -47, -29, -54, -34, -69);
  ctx.lineTo(-24, -73);
  ctx.quadraticCurveTo(-17, -50, lean - 6, -47);
  ctx.lineTo(lean - 8, -77);
  ctx.lineTo(lean + 8, -83);
  ctx.lineTo(lean + 10, -52);
  ctx.quadraticCurveTo(26, -53, 31, -68);
  ctx.lineTo(36, -65);
  ctx.bezierCurveTo(30, -42, 7 + lean, -43, 11, -20);
  ctx.quadraticCurveTo(9, -3, 27, 6);
  ctx.quadraticCurveTo(18, 10, 7, 1);
  ctx.lineTo(2, 10);
  ctx.lineTo(-6, 2);
  ctx.quadraticCurveTo(-17, 10, -26, 4);
  ctx.fill();
  ctx.stroke();
  ctx.lineCap = "round";
  for (let i = 0; i < 11; i++) {
    const side = (i / 10) * 2 - 1;
    const start = side * 19;
    ctx.beginPath();
    ctx.moveTo(start, 4 - random() * 4);
    ctx.bezierCurveTo(side * 7, -10, side * 7 + lean, -20, side * 8 + lean + (random() - 0.5) * 4, -41 - random() * 18);
    ctx.strokeStyle = i % 3 === 0 ? "#bd8b4b" : i % 3 === 1 ? "#402f21" : "#9a6936";
    ctx.lineWidth = i % 3 === 0 ? 1.1 : 1.5;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // A few moss fibres bridge the painted trunk and the ground contact.
  for (let i = 0; i < 8; i++) {
    const x = (random() - 0.5) * 34;
    ctx.beginPath();
    ctx.moveTo(x, 4 + random() * 2);
    ctx.quadraticCurveTo(x - 3, 0, x - 1 - random() * 3, -2 - random() * 5);
    ctx.strokeStyle = i % 2 ? "#637c36" : "#395734";
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }
}

/** A mature broadleaf tree, x: approximately -72…72, y: -150…11. No ground shadow. */
export function drawTree(ctx: CanvasRenderingContext2D, variant: number): void {
  const random = randomFor(variant);
  const hue = 137 + random() * 15;
  const lean = (random() - 0.5) * 12;
  const width = 0.94 + random() * 0.09;
  const height = 0.91 + random() * 0.08;
  ctx.save();
  ctx.scale(width, height);
  trunk(ctx, random, lean);

  const clusters: { x: number; y: number; radius: number; light: number }[] = [];
  // Loose crown tiers, jittered and depth sorted, read as branches bearing leaves.
  const tiers = [
    { y: -129, count: 1, span: 0, radius: 18 },
    { y: -115, count: 3, span: 22, radius: 22 },
    { y: -98, count: 5, span: 43, radius: 22 },
    { y: -78, count: 5, span: 47, radius: 23 },
    { y: -59, count: 4, span: 33, radius: 21 },
    { y: -46, count: 2, span: 14, radius: 17 },
  ];
  for (const tier of tiers) {
    for (let i = 0; i < tier.count; i++) {
      const x = (tier.count > 1 ? ((i / (tier.count - 1)) * 2 - 1) * tier.span : 0) + (random() - 0.5) * 8 + lean;
      const y = tier.y + (random() - 0.5) * 10;
      clusters.push({ x, y, radius: tier.radius * (0.86 + random() * 0.2), light: 20 + (-y - 50) * 0.125 - x * 0.045 + (random() - 0.5) * 3 });
    }
  }
  clusters.sort((a, b) => a.y - b.y);
  for (const cluster of clusters) {
    crownCluster(ctx, random, cluster.x, cluster.y, cluster.radius, cluster.light, hue);
  }

  // Sunlit small shoots sit on the canopy rather than outlining every leaf equally.
  const shootCount = 3 + Math.floor(random() * 3);
  for (let i = 0; i < shootCount; i++) {
    const cluster = clusters[Math.floor(random() * clusters.length * 0.72)];
    crownCluster(ctx, random, cluster.x - 4, cluster.y - 7, 8 + random() * 4, 43 + random() * 7, 85 + random() * 10);
  }

  // Sparse warm seeds break the blue-green mass without turning it into polka dots.
  for (let i = 0; i < 3; i++) {
    const cluster = clusters[Math.floor(random() * clusters.length)];
    ctx.fillStyle = i % 2 ? "#b48243" : "#a14f2c";
    ctx.beginPath();
    ctx.ellipse(cluster.x + 1, cluster.y + 2, 0.85, 1.35, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Low undergrowth, x: approximately -30…30, y: -42…5. No ground shadow. */
export function drawShrub(ctx: CanvasRenderingContext2D, variant: number): void {
  const random = randomFor(variant + 7129);
  const hue = 125 + random() * 22;
  ctx.save();
  const clusters = [
    { x: -10, y: -24, radius: 15 },
    { x: 8, y: -27, radius: 14 },
    { x: -16, y: -12, radius: 13 },
    { x: 14, y: -13, radius: 14 },
    { x: 0, y: -10, radius: 14 },
  ];
  for (const cluster of clusters) {
    crownCluster(ctx, random, cluster.x, cluster.y, cluster.radius, 29 - cluster.x * 0.18 - cluster.y * 0.08, hue);
  }
  if (random() > 0.35) crownCluster(ctx, random, -6, -29, 8, 47, 88);
  ctx.restore();
}
