import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../apps/api/src/main/resources/db/migration/", import.meta.url);
const files = (await readdir(migrations)).filter(file => /^V\d+__.*\.sql$/.test(file));
const reset = await readFile(new URL("../scripts/reset-user-data.sql", import.meta.url), "utf8");

test("the destructive reset explicitly reviews the latest migration", () => {
  const latestVersion = Math.max(...files.map(file => Number(file.match(/^V(\d+)__/)[1])));
  const reviewedVersion = Number(reset.match(/ORDER BY installed_rank DESC LIMIT 1\) IS DISTINCT FROM '(\d+)'/)?.[1]);
  assert.equal(reviewedVersion, latestVersion, "Review the new schema and update reset-user-data.sql before release");
});

test("the reset inventory covers every migrated user table and preserves global configuration", async () => {
  // Migrations currently only add tables. A future drop/rename needs an explicit
  // update to this reader as well as a review of the destructive reset policy.
  const createdTables = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    assert.doesNotMatch(sql, /^\s*(?:DROP\s+TABLE|ALTER\s+TABLE\s+\w+\s+RENAME\s+TO)\b/im,
      `${file}: update the reset schema inventory for dropped or renamed tables`);
    createdTables.push(...[...sql.matchAll(/^\s*CREATE\s+TABLE\s+(\w+)\s*\(/gim)].map(match => match[1]));
  }
  const userTableArray = reset.match(/user_tables text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1];
  assert.ok(userTableArray, "Reset must declare its reviewed user table inventory");
  const cleared = [...userTableArray.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.equal(new Set(cleared).size, cleared.length, "Reset table list must not contain duplicates");
  assert.deepEqual([...cleared, "game_tap_collection_metadata", "managed_promo_codes"].sort(), createdTables.sort(),
    "New tables must be reviewed: user data is cleared, collection metadata and global campaigns are preserved");
  assert.match(reset, /IF promo_configuration IS DISTINCT FROM/);
});
