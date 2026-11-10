import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

// A newly packaged migration must also be an explicitly known canonical history
// row. Otherwise the first migration succeeds but the next container restart fails.
test("admin compatibility recognizes exactly the packaged canonical migration tail", async () => {
  const root = new URL("../", import.meta.url);
  const [source, files] = await Promise.all([
    readFile(new URL("apps/api/src/main/kotlin/ru/zhiv/db/AdminMigrationCompatibility.kt", root), "utf8"),
    readdir(new URL("apps/api/src/main/resources/db/migration/", root)),
  ]);
  const expected = files.filter(name => /^V\d+__.+\.sql$/.test(name))
    .map(name => [Number(name.match(/^V(\d+)__/)[1]), name]).sort((a, b) => a[0] - b[0]);
  const constants = new Map([...source.matchAll(/private const val (\w+) = "([^"]+)"/g)].map(match => [match[1], match[2]]));
  const tail = source.match(/internal val canonicalTailScripts = mapOf\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(tail, "Canonical history must keep its explicit version-to-script map");
  const actual = [...tail.matchAll(/^\s*(\d+) to (?:"([^"]+)"|(\w+)),?$/gm)]
    .map(match => [Number(match[1]), match[2] ?? constants.get(match[3])]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(actual, expected, "Register the exact packaged script; do not accept arbitrary future versions or filenames");
  assert.deepEqual(actual.map(([version]) => version), Array.from({ length: actual.length }, (_, index) => index + 50));
});
