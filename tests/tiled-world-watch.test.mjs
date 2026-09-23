import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/tiled-world.mjs");
const run = promisify(execFile);
const properties = values => Object.entries(values).map(([name, value]) => ({ name, type: "string", value }));

async function fixture(t) {
  const directory = await mkdtemp(path.join(root, "public", "tiled-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "fixture.tmj");
  const output = path.join(directory, "fixture.generated.json");
  await sharp({ create: { width: 20, height: 20, channels: 4, background: "#284533" } }).webp().toFile(path.join(directory, "ground.webp"));
  const map = {
    type: "map", orientation: "orthogonal", infinite: false,
    width: 100, height: 100, tilewidth: 1, tileheight: 1, properties: properties({ worldId: "watch-forest" }),
    tilesets: [{ firstgid: 1, name: "Images", columns: 0, tilecount: 1, tilewidth: 20, tileheight: 20, objectalignment: "topleft", tiles: [
      { id: 0, image: "ground.webp", imagewidth: 20, imageheight: 20, properties: properties({ role: "terrain" }) },
    ] }],
    layers: [{ id: 1, name: "World", type: "objectgroup", draworder: "index", objects: [
      { id: 1, name: "ground", x: 0, y: 0, width: 100, height: 100, gid: 1, properties: properties({ role: "terrain" }) },
      { id: 2, name: "focus", x: 10, y: 20, width: 50, height: 50, properties: properties({ role: "focus" }) },
    ] }],
  };
  await writeFile(input, JSON.stringify(map));
  return { input, output, map, directory };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message());
}

function startWatcher(t, input, output, cli = script) {
  const child = spawn(process.execPath, [cli, "--watch", input, output], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const stopped = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
  });
  return { child, stdout: () => stdout, stderr: () => stderr, logs: () => stdout + stderr };
}

async function atomicSave(input, contents) {
  const temporary = `${input}.saving`;
  await writeFile(temporary, contents);
  await rename(temporary, input);
}

test("watch keeps the last valid export, recovers after atomic Tiled saves, and never rewrites unchanged output", { timeout: 15000 }, async t => {
  const { input, output, map, directory } = await fixture(t);
  const originalSource = await readFile(input, "utf8");
  const watcher = startWatcher(t, input, output);
  await waitFor(() => watcher.stdout().includes("Exported "), watcher.logs);
  const initial = await readFile(output, "utf8");
  assert.equal(JSON.parse(initial).focus.x, 10);
  assert.equal(await readFile(input, "utf8"), originalSource, "watch does not rewrite the authoring map");
  const originalStat = await stat(output, { bigint: true });
  await atomicSave(input, `${JSON.stringify(map, null, 2)}\n`);
  await waitFor(() => watcher.stdout().includes("output unchanged"), watcher.logs);
  assert.equal((await stat(output, { bigint: true })).mtimeNs, originalStat.mtimeNs);
  assert.equal((await stat(output, { bigint: true })).ino, originalStat.ino);

  await atomicSave(input, '{"incomplete":');
  await waitFor(() => watcher.stderr().includes("still watching"), watcher.logs);
  assert.equal(await readFile(output, "utf8"), initial);
  assert.equal(watcher.child.exitCode, null, "invalid JSON does not stop the watcher");

  map.layers[0].objects[1].x = 14;
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stdout().includes("Tiled map recovered."), watcher.logs);
  assert.equal(JSON.parse(await readFile(output, "utf8")).focus.x, 14);

  const valid = await readFile(output, "utf8");
  map.layers[0].objects[1].x = 90;
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stderr().includes("outside world bounds"), watcher.logs);
  assert.equal(await readFile(output, "utf8"), valid, "semantically invalid geometry also preserves the last valid output");
  map.layers[0].objects[1].x = 18;
  await atomicSave(input, JSON.stringify(map));
  await waitFor(async () => JSON.parse(await readFile(output, "utf8")).focus.x === 18, watcher.logs);

  // Rapid editor saves settle on the newest snapshot rather than concurrent exports.
  for (const x of [19, 20, 21]) {
    map.layers[0].objects[1].x = x;
    await atomicSave(input, JSON.stringify(map));
  }
  await waitFor(async () => JSON.parse(await readFile(output, "utf8")).focus.x === 21, watcher.logs);
  const settled = await stat(output, { bigint: true });
  const settledLogs = watcher.logs();
  await writeFile(path.join(directory, "fixture.tiled-session"), "editor state");
  await delay(600);
  assert.equal(watcher.logs(), settledLogs, "generated output and unrelated files do not trigger a watch loop");
  assert.equal((await stat(output, { bigint: true })).mtimeNs, settled.mtimeNs);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
});

test("watch starts with invalid input and exports after its first valid save", { timeout: 10000 }, async t => {
  const { input, output, map } = await fixture(t);
  await writeFile(input, "{");
  const watcher = startWatcher(t, input, output);
  await waitFor(() => watcher.stderr().includes("still watching"), watcher.logs);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stdout().includes("Tiled map recovered."), watcher.logs);
  assert.equal(JSON.parse(await readFile(output, "utf8")).id, "watch-forest");
});

test("watch updates nested water masks and retains the last valid mask while a polygon is malformed", { timeout: 10000 }, async t => {
  const { input, output, map } = await fixture(t);
  const polygon = (id, name, x, y, size) => ({ id, name, x, y, polygon: [
    { x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size },
  ] });
  const river = polygon(3, "river-main", 5, 50, 40);
  const leaf = polygon(4, "leaf-1", 12, 65, 3);
  map.layers.push({ id: 2, name: "Water", type: "objectgroup", draworder: "topdown", objects: [river] },
    { id: 3, name: "WaterExclusions", type: "group", layers: [
      { id: 4, name: "Leaves", type: "objectgroup", draworder: "topdown", objects: [leaf] },
    ] });
  await writeFile(input, JSON.stringify(map));
  const watcher = startWatcher(t, input, output);
  await waitFor(() => watcher.stdout().includes("Exported "), watcher.logs);
  const scene = async () => JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual((await scene()).water.surfaces[0].points[0], { x: 5, y: 50 });
  assert.deepEqual((await scene()).water.exclusions[0].points[0], { x: 12, y: 65 });
  river.polygon[1].x = 43.125;
  leaf.x = 15.75;
  await atomicSave(input, JSON.stringify(map));
  await waitFor(async () => (await scene()).water.exclusions[0].points[0].x === 15.75, watcher.logs);
  assert.deepEqual((await scene()).water.surfaces[0].points[1], { x: 48.125, y: 50 });
  const valid = await readFile(output, "utf8");
  leaf.polyline = leaf.polygon;
  delete leaf.polygon;
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stderr().includes('(leaf-1) shape: expected "polygon"'), watcher.logs);
  assert.equal(await readFile(output, "utf8"), valid);
  leaf.polygon = leaf.polyline;
  delete leaf.polyline;
  leaf.x = 18.25;
  const saved = JSON.stringify(map);
  await atomicSave(input, saved);
  await waitFor(async () => (await scene()).water.exclusions[0].points[0].x === 18.25, watcher.logs);
  assert.equal(await readFile(input, "utf8"), saved, "watch never rewrites hand-authored vertices");
  // Stop before fixture cleanup so its pending filesystem events cannot recreate
  // the generated output while the fixture directory is being removed.
  const stopped = once(watcher.child, "exit");
  watcher.child.kill("SIGTERM");
  await stopped;
});

test("export avoids unchanged writes; check rejects stale, invalid and incompatible watch mode without writing", async t => {
  const { input, output, map } = await fixture(t);
  const command = [script, input, output];
  await run(process.execPath, command);
  const before = await stat(output, { bigint: true });
  await run(process.execPath, command);
  assert.equal((await stat(output, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal((await stat(output, { bigint: true })).ino, before.ino);
  await run(process.execPath, [...command, "--check"]);
  await writeFile(output, "stale\n");
  await assert.rejects(run(process.execPath, [...command, "--check"]), error => error.code === 1 && /Generated world is stale/.test(error.stderr));
  map.layers[0].objects[1].x = 90;
  await writeFile(input, JSON.stringify(map));
  await assert.rejects(run(process.execPath, [...command, "--check"]), error => error.code === 1 && /outside world bounds/.test(error.stderr));
  await assert.rejects(run(process.execPath, [...command, "--check", "--watch"]), error => error.code === 1 && /Usage:/.test(error.stderr));
  assert.equal(await readFile(output, "utf8"), "stale\n");
});

test("the application output requires spawn before any export write and watch preserves it when spawn is deleted", { timeout: 10000 }, async t => {
  const { input, output: customOutput, map, directory } = await fixture(t);
  // A copied CLI gives this isolated fixture its own canonical application path.
  // The repository's live map and generated output are never changed by this test.
  const cli = path.join(directory, "scripts/tiled-world.mjs");
  await mkdir(path.join(directory, "scripts/lib"), { recursive: true });
  await mkdir(path.join(directory, "public"));
  await copyFile(script, cli);
  await copyFile(path.join(root, "scripts/lib/tiled-world.mjs"), path.join(directory, "scripts/lib/tiled-world.mjs"));
  await rename(path.join(directory, "ground.webp"), path.join(directory, "public/ground.webp"));
  map.tilesets[0].tiles[0].image = "public/ground.webp";
  const spawnPoint = { id: 3, name: "mochlik-spawn", x: 40, y: 50, width: 0, height: 0, point: true, properties: [
    ...properties({ role: "spawn" }), { name: "size", type: "float", value: 36 },
  ] };
  map.layers[0].objects.push(spawnPoint);
  await writeFile(input, JSON.stringify(map));
  const output = path.join(directory, "features/world/tiled/forest.generated.json");
  const command = [cli, input];
  await run(process.execPath, command);
  const valid = await readFile(output, "utf8");
  assert.equal(JSON.parse(valid).actor.spawn.x, 40);

  map.layers[0].objects.pop();
  map.tilesets[0].tiles[0].imagewidth = 10;
  const staleMetadataSource = JSON.stringify(map);
  await writeFile(input, staleMetadataSource);
  await assert.rejects(run(process.execPath, command), error => error.code === 1 && /role=spawn/.test(error.stderr));
  assert.equal(await readFile(input, "utf8"), staleMetadataSource, "missing spawn is rejected before authoring metadata is refreshed");
  assert.equal(await readFile(output, "utf8"), valid);

  map.tilesets[0].tiles[0].imagewidth = 20;
  await writeFile(input, JSON.stringify(map));
  await assert.rejects(run(process.execPath, [...command, "--check"]), error => error.code === 1 && /role=spawn/.test(error.stderr));
  await run(process.execPath, [...command, customOutput]);
  assert.equal(JSON.parse(await readFile(customOutput, "utf8")).actor, undefined, "custom output preserves legacy maps without a character");

  const watcher = startWatcher(t, input, output, cli);
  await waitFor(() => watcher.stderr().includes("role=spawn"), watcher.logs);
  assert.equal(await readFile(output, "utf8"), valid);
  spawnPoint.x = 42;
  map.layers[0].objects.push(spawnPoint);
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stdout().includes("Tiled map recovered."), watcher.logs);
  const recovered = await readFile(output, "utf8");
  assert.equal(JSON.parse(recovered).actor.spawn.x, 42);
  map.layers[0].objects.pop();
  await atomicSave(input, JSON.stringify(map));
  await waitFor(() => watcher.stderr().split("role=spawn").length === 3, watcher.logs);
  assert.equal(await readFile(output, "utf8"), recovered);
  assert.equal(watcher.child.exitCode, null);
});
