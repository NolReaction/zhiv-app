import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../apps/api/src/main/resources/db/migration/", import.meta.url);
const files = (await readdir(migrations, { recursive: true })).flatMap(file => {
  const match = file.match(/(?:^|[/\\])([BV])(\d+)__.*\.sql$/);
  return match ? [{ file, prefix: match[1], version: Number(match[2]) }] : [];
});
const reset = await readFile(new URL("../scripts/reset-user-data.sql", import.meta.url), "utf8");

test("the destructive reset explicitly reviews the latest migration", () => {
  const latestVersion = Math.max(...files.map(file => file.version));
  const reviewedVersion = Number(reset.match(/max\(version::integer\)[\s\S]*?\) IS DISTINCT FROM (\d+)/)?.[1]);
  assert.equal(reviewedVersion, latestVersion, "Review the new schema and update reset-user-data.sql before release");
  assert.doesNotMatch(reset, /ORDER BY installed_rank DESC LIMIT 1/,
    "An admin compatibility upgrade can apply V50 after V52; installation order cannot identify the schema version");
  assert.match(reset, /generate_series\(1,61\)/);
  assert.match(reset, /49:SQL_BASELINE/);
  assert.match(reset, /WHERE NOT success/);
});

test("the reset inventory covers every migrated user table and preserves global configuration", async () => {
  const userTableArray = reset.match(/user_tables text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1];
  assert.ok(userTableArray, "Reset must declare its reviewed user table inventory");
  const cleared = [...userTableArray.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.equal(new Set(cleared).size, cleared.length, "Reset table list must not contain duplicates");
  const versioned = files.filter(file => file.prefix === "V");
  const paths = [{ name: "historical V chain", files: versioned },
    ...files.filter(file => file.prefix === "B").map(baseline => ({
      name: `${baseline.file} and later V migrations`,
      files: [baseline, ...versioned.filter(file => file.version > baseline.version)],
    }))];
  for (const path of paths) {
    // Never concatenate a baseline and the history it replaces. Check each
    // supported path independently, including schema-qualified pg_dump tables.
    const createdTables = [];
    for (const { file } of path.files) {
      const sql = await readFile(new URL(file, migrations), "utf8");
      assert.doesNotMatch(sql, /^\s*(?:DROP\s+TABLE|ALTER\s+TABLE\s+(?:public\.)?\w+\s+RENAME\s+TO)\b/im,
        `${file}: update the reset schema inventory for dropped or renamed tables`);
      createdTables.push(...[...sql.matchAll(/^\s*CREATE\s+TABLE\s+(?:public\.)?(\w+)\s*\(/gim)].map(match => match[1]));
    }
    assert.equal(new Set(createdTables).size, createdTables.length, `${path.name}: duplicate table definitions`);
    assert.deepEqual([...cleared, "game_tap_collection_metadata", "managed_promo_codes"].sort(), createdTables.sort(),
      `${path.name}: every table must be reviewed; collection metadata and global campaigns are preserved`);
  }
  assert.match(reset, /IF promo_configuration IS DISTINCT FROM/);
});
