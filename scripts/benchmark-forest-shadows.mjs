// Isolated CPU benchmark, not a browser/GPU/FPS measurement.
// node scripts/benchmark-forest-shadows.mjs [baseline-ref] [frames-per-sample]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = "features/world/environment/lighting/forest-shadow-geometry.ts";
const baselineRef = process.argv[2] ?? "95f6832e216d9a242fa69393337df8738c1c1b8a";
const frames = Number(process.argv[3] ?? 1500);
if (!Number.isInteger(frames) || frames < 100 || frames > 100000) throw new Error("frames must be an integer from 100 to 100000");
async function moduleFrom(source) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const baseline = await moduleFrom(execFileSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, encoding: "utf8" }));
const current = await moduleFrom(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const lights = [
  { kind: "directional", direction: { x: -.7, y: -.7 }, elevation: 40 },
  { kind: "point", position: { x: 35, y: 70 }, height: 12, radius: 170 },
  { kind: "point", position: { x: 125, y: 95 }, height: 38, radius: 170 },
];
function sample(geometry, count) {
  let pieces = 0, vertices = 0;
  const start = performance.now();
  for (let frame = 0; frame < count; frame++) {
    for (let index = 0; index < 6; index++) {
      const body = geometry.createForestActorShadow({ x: 55 + index * 8 + Math.sin(frame * .03) * 12,
        y: 68 + index * 6 + Math.cos(frame * .04) * 9 }, 6, `actor-${index}`);
      body.height = 24; body.baseHeight = index === 0 ? Math.max(0, Math.sin(frame * .04)) * 7 : 0;
      for (const light of lights) {
        const shadow = geometry.projectForestShadow(body, light);
        pieces += shadow.length;
        for (const piece of shadow) vertices += piece.length;
      }
    }
  }
  return { ms: performance.now() - start, pieces, vertices };
}
sample(baseline, 500); sample(current, 500);
const before = [], after = [];
for (let index = 0; index < 7; index++) {
  // Alternate order to reduce a fixed warmup or CPU-load bias.
  if (index % 2) { after.push(sample(current, frames)); before.push(sample(baseline, frames)); }
  else { before.push(sample(baseline, frames)); after.push(sample(current, frames)); }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarize = values => ({ medianMs: Number(median(values.map(value => value.ms)).toFixed(3)),
  medianMsPerFrame: Number((median(values.map(value => value.ms)) / frames).toFixed(4)),
  projectedPieces: values[0].pieces, pathVertices: values[0].vertices });
const old = summarize(before), next = summarize(after);
console.log(JSON.stringify({ scope: "CPU projection only; excludes Canvas, scene cache and real device FPS", baselineRef,
  framesPerSample: frames, samples: 7, actors: 6, lights: lights.length, baseline: old, current: next,
  medianSpeedup: Number((old.medianMs / next.medianMs).toFixed(2)) }, null, 2));
