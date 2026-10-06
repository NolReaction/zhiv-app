// Small alpha-only Canvas model for occlusion regressions. It rasterizes paths,
// round strokes and affine drawImage, so tests assert pixels after composition,
// not merely that destination-out was assigned. Production uses native Canvas.
export function occlusionRaster(width = 200, height = 200) {
  let data = new Float64Array(width * height), matrix = [1, 0, 0, 1, 0, 0], path = [];
  const stack = [], canvas = {};
  Object.defineProperties(canvas, {
    width: { get: () => width, set(value) { width = value; data = new Float64Array(width * height); } },
    height: { get: () => height, set(value) { height = value; data = new Float64Array(width * height); } },
  });
  const contains = (points, x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
    }
    return inside;
  };
  const distance = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
  };
  const apply = source => {
    const [a, b, c, d, e, f] = matrix, det = a * d - b * c;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const alpha = source({ x: (d * (x + .5 - e) - c * (y + .5 - f)) / det,
        y: (-b * (x + .5 - e) + a * (y + .5 - f)) / det });
      if (!alpha) continue;
      const index = y * width + x, value = alpha * ctx.globalAlpha;
      data[index] = ctx.globalCompositeOperation === "destination-out" ? data[index] * (1 - value)
        : value + data[index] * (1 - value);
    }
  };
  const ctx = {
    canvas, globalAlpha: 1, globalCompositeOperation: "source-over", imageSmoothingEnabled: false,
    lineWidth: 1, lineJoin: "round", lineCap: "round", fillStyle: "#000", strokeStyle: "#000",
    drawCalls: [], strokeCalls: 0,
    setTransform(...values) { matrix = values; },
    getTransform() { const [a, b, c, d, e, f] = matrix; return { a, b, c, d, e, f }; },
    save() { stack.push({ matrix: [...matrix], globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation, imageSmoothingEnabled: this.imageSmoothingEnabled }); },
    restore() { const state = stack.pop(); matrix = state.matrix; delete state.matrix; Object.assign(this, state); },
    clearRect() { data.fill(0); },
    beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); }, closePath() {},
    fill() { apply(point => Number(contains(path, point.x, point.y))); },
    stroke() { this.strokeCalls++; apply(point => Number(path.some((a, i) => distance(point, a, path[(i + 1) % path.length]) <= this.lineWidth / 2))); },
    fillRect(x, y, w, h) { apply(point => Number(point.x >= x && point.x < x + w && point.y >= y && point.y < y + h)); },
    drawImage(source, x, y, w = source.width, h = source.height) {
      this.drawCalls.push({ source, x, y, w, h, alpha: this.globalAlpha, matrix: [...matrix] });
      apply(point => {
        const sx = (point.x - x) * source.width / w, sy = (point.y - y) * source.height / h;
        return sx >= 0 && sy >= 0 && sx < source.width && sy < source.height ? source.alpha(Math.floor(sx), Math.floor(sy)) : 0;
      });
    },
    getImageData() { throw new Error("must not read pixels from the scene"); },
  };
  canvas.alpha = (x, y) => data[y * width + x] ?? 0;
  canvas.getContext = () => ctx;
  return canvas;
}
