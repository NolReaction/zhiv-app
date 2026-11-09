import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The vinext standalone server serves static files from dist/client. The build
// also copies public beside server.js. Keep it intact if the two ever diverge.
export async function compactSitesStandalone(standalone) {
  const root = await realpath(standalone);
  const publicRoot = join(root, "public");
  const stat = await lstat(publicRoot).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!stat?.isDirectory()) return 0;

  let bytes = 0;
  for (const entry of await readdir(publicRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) return 0;
    const file = join(entry.parentPath, entry.name);
    const servedFile = join(root, "dist", "client", relative(publicRoot, file));
    const onDisk = await realpath(servedFile).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (onDisk !== servedFile) return 0;
    const served = await readFile(servedFile);
    if (!served.equals(await readFile(file))) return 0;
    bytes += served.length;
  }
  await rm(publicRoot, { recursive: true });
  return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const removed = await compactSitesStandalone(resolve(import.meta.dirname, "../dist/standalone"));
  console.info(`Sites standalone: removed ${removed} duplicate public bytes.`);
}
