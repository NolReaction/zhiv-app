import { readFileSync, writeFileSync } from "node:fs";

// Development-only geometry preparation. The browser imports the resulting JSON
// and never repeats these coastal checks on the main thread.
const guides = JSON.parse(readFileSync(new URL("../art/earth/relief/ranges.json", import.meta.url), "utf8"));
if (guides.schemaVersion !== 1) throw new Error("Unsupported illustrated relief guide version");
const ranges = guides.ranges;
const landforms = JSON.parse(readFileSync(new URL("../art/earth/relief/landforms.json", import.meta.url), "utf8"));
if (landforms.schemaVersion !== 1) throw new Error("Unsupported illustrated landform guide version");
const land = JSON.parse(readFileSync(new URL("../features/earth/data/land-110m.json", import.meta.url), "utf8"));

const physical = JSON.parse(readFileSync(new URL("../features/earth/data/physical-110m.json", import.meta.url), "utf8"));
const excludedPhysicalRings = physical.features.flatMap(feature => feature.geometry.type === "Polygon"
  ? [feature.geometry.coordinates] : feature.geometry.coordinates);

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

function onDryLand(point) {
  return onLand(point) && !excludedPhysicalRings.some(rings => insideRing(point, rings[0])
    && !rings.slice(1).some(ring => insideRing(point, ring)));
}

function rounded([x, y]) { return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]; }
function mix(from, to, amount) { return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount]; }

function createReliefData() {
  const features = [];
  const add = (range, tone, points, form) => {
    // Never paint invented islands. Also sample each edge: a face with land at
    // both ends can still cross a coarse coastal inlet or a lake hole.
    const ring = points.map(rounded);
    const allowed = form === "dune" || form === "outcrop" ? onDryLand : onLand;
    if (!ring.every((point, index) => {
      const next = ring[(index + 1) % ring.length];
      return allowed(point) && allowed([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]);
    })) return;
    features.push({ type: "Feature", properties: { range, tone, ...(form ? { form } : {}) },
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } });
  };
  // Low, broad flat tops and a broken shaded apron distinguish plateaus from
  // narrow jagged ranges. They are painted first, below mountain ridge facets.
  for (const plateau of landforms.plateaus) {
    const points = plateau.points;
    const center = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]; const b = points[(index + 1) % points.length];
      const outerA = mix(center, a, 1.13); const outerB = mix(center, b, 1.13);
      add(plateau.id, index < Math.ceil(points.length / 2) ? "plateau-rim-light" : "plateau-rim-shade",
        [a, b, outerB, outerA], "plateau");
      add(plateau.id, plateau.tone, [center, a, b], "plateau");
    }
  }
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
    // A few authored summit accents, not a continuous snow belt or an altitude
    // model. Fractional positions stay attached to the same hand-drawn range as
    // it is resampled, with asymmetric lit/cool faces over the existing ridge.
    const snowIndices = new Set((range.snowPeaks ?? []).map(fraction => {
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) throw new Error("Invalid illustrated snow peak");
      return Math.max(1, Math.min(sections.length - 2, Math.round(fraction * (sections.length - 1))));
    }));
    for (const index of snowIndices) {
      const before = sections[index - 1]; const peak = sections[index]; const after = sections[index + 1];
      const left = mix(mix(before.crest, peak.crest, 0.66), peak.left, 0.34);
      const right = mix(mix(peak.crest, after.crest, 0.32), peak.right, 0.26);
      const tail = mix(peak.crest, after.crest, 0.56);
      const northWestLit = (after.crest[0] - before.crest[0]) * Math.cos(peak.crest[1] * Math.PI / 180)
        + after.crest[1] - before.crest[1] >= 0;
      add(range.id, northWestLit ? "snow" : "snow-shade", [left, peak.crest, tail]);
      add(range.id, northWestLit ? "snow-shade" : "snow", [peak.crest, right, tail]);
    }
  }
  // A few broad cones, each with a low shadow apron, asymmetric facets and a
  // quiet crater. No smoke, eruption animation or scientific activity claim.
  for (const volcano of landforms.volcanoes) {
    const [x, y] = volcano.center; const [rx, ry] = volcano.radius;
    const center = [x, y + ry * 0.23];
    const points = Array.from({ length: 8 }, (_, index) => {
      const angle = index * Math.PI / 4;
      const uneven = 1 + Math.sin(index * 2.1) * 0.08;
      return [x + Math.cos(angle) * rx * uneven, y + Math.sin(angle) * ry * uneven];
    });
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]; const b = points[(index + 1) % points.length];
      const outerA = mix([x, y - ry * 0.15], a, 1.35); const outerB = mix([x, y - ry * 0.15], b, 1.35);
      add(volcano.id, "volcano-apron", [a, b, outerB, outerA], "volcano");
      add(volcano.id, index >= 2 && index <= 5 ? "volcano-light" : "volcano-shade", [center, a, b], "volcano");
    }
    if (volcano.snow) {
      add(volcano.id, "volcano-snow", [mix(center, points[2], 0.3), mix(center, points[4], 0.3), mix(center, points[6], 0.23)], "volcano");
      add(volcano.id, "volcano-snow-shade", [mix(center, points[6], 0.23), mix(center, points[0], 0.24), mix(center, points[2], 0.3)], "volcano");
    }
    const crater = [[x - rx * 0.16, center[1]], [x, center[1] + ry * 0.07],
      [x + rx * 0.13, center[1]], [x, center[1] - ry * 0.07]];
    add(volcano.id, "volcano-crater", crater, "volcano");
  }
  // Sparse small ice tongues sit on the illustrated relief and share its fade.
  // They do not modify Natural Earth's physical ice polygons or live snow.
  for (const glacier of landforms.glaciers) {
    for (let index = 1; index < glacier.points.length; index += 1) {
      const a = glacier.points[index - 1]; const b = glacier.points[index];
      const width = glacier.width * (1 - index / glacier.points.length * 0.55);
      const leftA = [a[0] - width, a[1]]; const rightA = [a[0] + width, a[1]];
      const leftB = [b[0] - width * 0.7, b[1]]; const rightB = [b[0] + width * 0.7, b[1]];
      add(glacier.id, "glacier-light", [leftA, a, b, leftB], "glacier");
      add(glacier.id, "glacier-shade", [a, rightA, rightB, b], "glacier");
    }
  }
  // Three narrow curved crests per patch give warm deserts their own quiet
  // surface character. Each crest uses only six small tapered quadrilaterals;
  // no giant triangles, image pattern, simulation or repeated global lattice.
  for (const cluster of landforms.duneClusters ?? []) {
    const angle = cluster.rotation * Math.PI / 180;
    const cosLatitude = Math.cos(cluster.center[1] * Math.PI / 180);
    const world = (x, y) => [cluster.center[0] + (x * Math.cos(angle) - y * Math.sin(angle)) / cosLatitude,
      cluster.center[1] + x * Math.sin(angle) + y * Math.cos(angle)];
    for (let ridge = 0; ridge < 3; ridge += 1) {
      const length = cluster.length * (1 - ridge * 0.075);
      const sections = Array.from({ length: 4 }, (_, index) => {
        const t = index / 3;
        const x = (t - 0.5) * length;
        const y = (ridge - 1) * cluster.spacing + Math.sin(t * Math.PI) * length * 0.12;
        const width = cluster.width * (0.12 + Math.sin(t * Math.PI) * 0.88);
        return { crest: world(x, y), lit: world(x, y + width * 0.65), shade: world(x, y - width) };
      });
      for (let index = 1; index < sections.length; index += 1) {
        const a = sections[index - 1]; const b = sections[index];
        add(cluster.id, "dune-light", [a.lit, b.lit, b.crest, a.crest], "dune");
        add(cluster.id, "dune-shade", [a.crest, b.crest, b.shade, a.shade], "dune");
      }
    }
  }
  // Two tiny broken flat-topped rock outcrops contrast with the flowing sand.
  for (const rock of landforms.outcrops ?? []) {
    const [x, y] = rock.center; const [rx, ry] = rock.radius;
    const top = [[x - rx, y], [x - rx * 0.4, y + ry * 0.65], [x + rx * 0.6, y + ry * 0.5], [x + rx, y - ry * 0.1]];
    const foot = top.map(point => [point[0] + rx * 0.18, point[1] - ry * 0.7]);
    for (let index = 0; index < top.length; index += 1) {
      const next = (index + 1) % top.length;
      add(rock.id, index < 2 ? "rock-light" : "rock-shade", [top[index], top[next], foot[next], foot[index]], "outcrop");
    }
    add(rock.id, "rock-top", [top[0], top[1], top[2]], "outcrop");
    add(rock.id, "rock-top", [top[0], top[2], top[3]], "outcrop");
  }
  return { type: "FeatureCollection", features };
}

const output = new URL("../features/earth/data/relief-illustrated.json", import.meta.url);
const data = createReliefData();
const serialized = `${JSON.stringify(data)}\n`;
const bytes = Buffer.byteLength(serialized);
if (data.features.length > 1350 || bytes > 275_000) throw new Error("Illustrated relief exceeds its local geometry budget");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-earth-relief.mjs [--check]");
if (args.includes("--check")) {
  if (readFileSync(output, "utf8") !== serialized) throw new Error("Illustrated relief is stale: run node scripts/prepare-earth-relief.mjs");
  console.log(`Illustrated relief checked: ${data.features.length} faces, ${bytes} bytes`);
} else {
  writeFileSync(output, serialized);
  console.log(`Illustrated relief prepared: ${data.features.length} faces, ${bytes} bytes`);
}
