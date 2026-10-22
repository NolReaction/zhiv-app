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
  assert.match(reset, /generate_series\(1,70\)/);
  assert.match(reset, /49:SQL_BASELINE/);
  assert.match(reset, /WHERE NOT success/);
});

test("fresh database reset and its CI verifier accept the complete current baseline chain", async () => {
  const baseline = files.filter(file => file.prefix === "B").toSorted((a, b) => b.version - a.version)[0];
  assert.ok(baseline);
  const expected = [`${baseline.version}:SQL_BASELINE:true`, ...files.filter(file => file.prefix === "V" && file.version > baseline.version)
    .toSorted((a, b) => a.version - b.version).map(file => `${file.version}:SQL:true`)];
  for (const path of ["scripts/reset-database.sh", "scripts/verify-reset-database-ci.py"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const reviewed = source.match(/ARRAY\['\d+:SQL_BASELINE:true'[^\]]*\]/)?.[0];
    assert.ok(reviewed, `${path}: the rebuilt database must have an explicit reviewed baseline history`);
    assert.deepEqual([...reviewed.matchAll(/'([^']+)'/g)].map(match => match[1]), expected,
      `${path}: review every new migration before accepting a rebuilt database`);
  }
});

test("the reset inventory covers every migrated user table and preserves global configuration", async () => {
  const userTableArray = reset.match(/user_tables text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1];
  assert.ok(userTableArray, "Reset must declare its reviewed user table inventory");
  const cleared = [...userTableArray.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.equal(new Set(cleared).size, cleared.length, "Reset table list must not contain duplicates");
  for (const table of ["earth_sharing_settings", "earth_sharing_recipients", "earth_latest_locations", "earth_frozen_locations"])
    assert.ok(cleared.includes(table), `${table}: full account deletion clears geolocation data and consent`);
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
      createdTables.push(...[...sql.matchAll(/^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:public\.)?(\w+)\s*\(/gim)].map(match => match[1]));
    }
    assert.equal(new Set(createdTables).size, createdTables.length, `${path.name}: duplicate table definitions`);
    assert.deepEqual([...cleared, "game_tap_collection_metadata", "managed_promo_codes", "gameplay_generations", "gameplay_reset_runs"].sort(), createdTables.sort(),
      `${path.name}: every table must be reviewed; collection metadata and global campaigns are preserved`);
  }
  assert.match(reset, /IF promo_configuration IS DISTINCT FROM/);
});
