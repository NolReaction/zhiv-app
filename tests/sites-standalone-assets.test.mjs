import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactSitesStandalone } from "../scripts/compact-sites-standalone.mjs";

test("Sites removes only a wholly duplicated public directory and keeps the served files", async t => {
  const root = await mkdtemp(join(tmpdir(), "sites-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, "public/world"), servedDir = join(root, "dist/client/world");
  await mkdir(publicDir, { recursive: true });
  await mkdir(servedDir, { recursive: true });
  await writeFile(join(publicDir, "hull.svg"), "hull");
  assert.equal(await compactSitesStandalone(root), 0);
  await writeFile(join(servedDir, "hull.svg"), "keel");
  assert.equal(await compactSitesStandalone(root), 0);
  assert.equal(await readFile(join(publicDir, "hull.svg"), "utf8"), "hull");
  if (process.platform !== "win32") {
    await rm(join(servedDir, "hull.svg"));
    await symlink(join(publicDir, "hull.svg"), join(servedDir, "hull.svg"));
    assert.equal(await compactSitesStandalone(root), 0);
    await rm(join(servedDir, "hull.svg"));
  }
  await writeFile(join(servedDir, "hull.svg"), "hull");
  assert.equal(await compactSitesStandalone(root), 4);
  await assert.rejects(readFile(join(publicDir, "hull.svg")), { code: "ENOENT" });
  assert.equal(await readFile(join(servedDir, "hull.svg"), "utf8"), "hull");
  assert.equal(await compactSitesStandalone(root), 0);
});
