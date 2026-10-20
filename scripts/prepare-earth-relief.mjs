import { readFileSync, writeFileSync } from "node:fs";

// Development-only geometry preparation. The browser imports the resulting JSON
// and never repeats these coastal checks on the main thread.
const guides = JSON.parse(readFileSync(new URL("../art/earth/relief/ranges.json", import.meta.url), "utf8"));
if (guides.schemaVersion !== 1) throw new Error("Unsupported illustrated relief guide version");
const ranges = guides.ranges;
const land = JSON.parse(readFileSync(new URL("../features/earth/data/land-110m.json", import.meta.url), "utf8"));

const polygons = land.features.map(feature => {
  const rings = feature.geometry.coordinates;
  const outer = rings[0];
  const xs = outer.map(point => point[0]); const ys = outer.map(point => point[1]);
  return { rings, west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
});

function insideRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [a, b] = ring[index]; const [c, d] = ring[previous];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}

function onLand(point) {
  return polygons.some(polygon => point[0] >= polygon.west && point[0] <= polygon.east
    && point[1] >= polygon.south && point[1] <= polygon.north
    && insideRing(point, polygon.rings[0]) && !polygon.rings.slice(1).some(ring => insideRing(point, ring)));
}

function rounded([x, y]) { return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]; }

function createReliefData() {
  const features = [];
  const add = (range, tone, points) => {
    // Never paint invented islands. Also sample each edge: a face with land at
    // both ends can still cross a coarse coastal inlet or a lake hole.
    const ring = points.map(rounded);
    if (!ring.every((point, index) => {
      const next = ring[(index + 1) % ring.length];
      return onLand(point) && onLand([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]);
    })) return;
    features.push({ type: "Feature", properties: { range, tone },
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } });
  };
  for (const range of ranges) {
    const centers = [];
    for (let index = 1; index < range.points.length; index += 1) {
      const from = range.points[index - 1]; const to = range.points[index];
      const cos = Math.cos((from[1] + to[1]) / 2 * Math.PI / 180);
      const steps = Math.ceil(Math.hypot((to[0] - from[0]) * cos, to[1] - from[1]) / 1.5);
      for (let step = 0; step < steps; step += 1) centers.push([
        from[0] + (to[0] - from[0]) * step / steps, from[1] + (to[1] - from[1]) * step / steps,
      ]);
    }
    centers.push(range.points[range.points.length - 1]);
    const sections = centers.map((point, index) => {
      const before = centers[Math.max(0, index - 1)]; const after = centers[Math.min(centers.length - 1, index + 1)];
      const cos = Math.cos(point[1] * Math.PI / 180);
      const dx = (after[0] - before[0]) * cos; const dy = after[1] - before[1];
      const length = Math.hypot(dx, dy) || 1;
      const width = range.width * (0.67 + 0.18 * Math.sin(index * 2.3 + 0.4)
        + 0.15 * Math.sin(index * 0.9)) * (index === 0 || index === centers.length - 1 ? 0.24 : 1);
      const side = (amount) => [point[0] - dy / length / cos * width * amount, point[1] + dx / length * width * amount];
      return { left: side(1), right: side(-1), crest: side(0.48 * Math.sin(index * 2.2)),
        outerLeft: side(1.65), outerRight: side(-1.65) };
    });
    // All foothills first, then both faces: transparent envelopes cannot cover
    // the neighbouring segment's illuminated slope.
    for (let index = 1; index < sections.length; index += 1) {
      const a = sections[index - 1]; const b = sections[index];
      add(range.id, "foothill", [a.outerLeft, b.outerLeft, b.outerRight, a.outerRight]);
    }
    for (let index = 1; index < sections.length; index += 1) {
      const a = sections[index - 1]; const b = sections[index];
      const northWestLit = (b.crest[0] - a.crest[0]) * Math.cos(b.crest[1] * Math.PI / 180) + b.crest[1] - a.crest[1] >= 0;
      add(range.id, northWestLit ? "light" : "shade", [a.left, b.left, b.crest, a.crest]);
      add(range.id, northWestLit ? "shade" : "light", [a.crest, b.crest, b.right, a.right]);
      // Short triangular side ridges break up a flat ribbon into illuminated
      // peaks and branching valleys, using the same bounded static fill layer.
      const middle = (from, to) => [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      const lightEdge = northWestLit ? [a.left, b.left] : [a.right, b.right];
      const darkEdge = northWestLit ? [a.right, b.right] : [a.left, b.left];
      add(range.id, "valley", [lightEdge[0], middle(lightEdge[0], lightEdge[1]), b.crest]);
      add(range.id, "spur", [a.crest, middle(darkEdge[0], darkEdge[1]), darkEdge[1]]);
    }
  }
  return { type: "FeatureCollection", features };
}

const output = new URL("../features/earth/data/relief-illustrated.json", import.meta.url);
const data = createReliefData();
const serialized = `${JSON.stringify(data)}\n`;
const bytes = Buffer.byteLength(serialized);
if (data.features.length > 1100 || bytes > 230_000) throw new Error("Illustrated relief exceeds its local geometry budget");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-earth-relief.mjs [--check]");
if (args.includes("--check")) {
  if (readFileSync(output, "utf8") !== serialized) throw new Error("Illustrated relief is stale: run node scripts/prepare-earth-relief.mjs");
  console.log(`Illustrated relief checked: ${data.features.length} faces, ${bytes} bytes`);
} else {
  writeFileSync(output, serialized);
  console.log(`Illustrated relief prepared: ${data.features.length} faces, ${bytes} bytes`);
}
