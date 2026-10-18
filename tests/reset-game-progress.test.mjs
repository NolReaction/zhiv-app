import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sql = await readFile(new URL("../scripts/reset-game-progress.sql", import.meta.url), "utf8");
const shell = await readFile(new URL("../scripts/reset-game-progress.sh", import.meta.url), "utf8");
const policy = name => [...sql.match(new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`))[1]
  .matchAll(/'([a-z_]+)'/g)].map(match => match[1]);

test("game reset reviews every table and the latest migration without clearing identity or social data", async () => {
  const migrationDir = new URL("../apps/api/src/main/resources/db/migration/", import.meta.url);
  const files = (await readdir(migrationDir, { recursive: true })).flatMap(file => {
    const match = file.match(/(?:^|[/\\])([BV])(\d+)__.*\.sql$/);
    return match ? [{ file, prefix: match[1], version: Number(match[2]) }] : [];
  });
  const reviewed = Number(sql.match(/max\(version::integer\)[\s\S]*?\) IS DISTINCT FROM (\d+)/)[1]);
  assert.equal(reviewed, Math.max(...files.map(file => file.version)));
  const cleared = policy("cleared_tables"), preserved = policy("preserved_tables"), partial = policy("partial_tables");
  const reinitialized = policy("reinitialized_tables");
  const classified = [...cleared, ...preserved, ...reinitialized, ...partial];
  assert.equal(new Set(classified).size, classified.length);
  const versioned = files.filter(file => file.prefix === "V");
  const paths = [{ name: "historical V chain", files: versioned },
    ...files.filter(file => file.prefix === "B").map(baseline => ({
      name: `${baseline.file} and later V migrations`,
      files: [baseline, ...versioned.filter(file => file.version > baseline.version)],
    }))];
  for (const path of paths) {
    const created = [];
    for (const { file } of path.files) {
      const migration = await readFile(new URL(file, migrationDir), "utf8");
      assert.doesNotMatch(migration, /^\s*(?:DROP\s+TABLE|ALTER\s+TABLE\s+(?:public\.)?\w+\s+RENAME\s+TO)\b/im,
        `${file}: review inventory parsing for a dropped/renamed table`);
      created.push(...[...migration.matchAll(/^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:public\.)?(\w+)\s*\(/gim)].map(match => match[1]));
    }
    assert.equal(new Set(created).size, created.length, `${path.name}: duplicate table definitions`);
    assert.deepEqual(classified.toSorted(), created.toSorted(), `${path.name}: game reset must classify every table`);
  }
  for (const name of ["app_users", "app_sessions", "account_login_identities", "account_recovery_codes",
    "circles", "circle_memberships", "direct_requests", "check_ins", "admin_actions", "promo_redemptions", "managed_promo_codes",
    "notification_subscriptions", "notification_preferences", "game_presence_daily", "player_mail_messages", "admin_mail_broadcasts", "player_security_observations",
    "earth_sharing_settings", "earth_sharing_recipients"]) assert.ok(preserved.includes(name), name);
  assert.ok(cleared.includes("earth_latest_locations"), "a gameplay reset discards ephemeral points without changing account consent");
  assert.deepEqual(partial, ["notification_events"]);
  for (const name of ["economy_profiles", "world_profiles", "forest_memory", "game_profiles"])
    assert.ok(reinitialized.includes(name), `${name}: preserve a monotonic revision fence`);
  assert.doesNotMatch(sql, /\bCASCADE\b|DISABLE\s+TRIGGER|DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.match(sql, /SET TRANSACTION READ ONLY/);
  assert.match(sql, /DELETE FROM public\.notification_events WHERE category NOT IN \('checkin','mail'\)/);
  assert.match(sql, /INSERT INTO public\.notification_events SELECT \* FROM game_reset_service_events/);
  assert.match(sql, /previous_revision >= 9007199254740990/);
  assert.match(sql, /\(previous_revision \+ 1\)::bigint/);
});

async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-game-reset-"));
  try {
    const project = join(directory, "repo"), bin = join(directory, "bin"), log = join(directory, "docker.log");
    await mkdir(join(project, "scripts"), { recursive: true });
    await mkdir(join(project, "deploy"));
    await mkdir(bin);
    await writeFile(join(project, "scripts/reset-game-progress.sh"), shell);
    await writeFile(join(project, "scripts/reset-game-progress.sql"), sql);
    await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RESET_TEST_LOG"
case "$*" in
  *psql*) cat >/dev/null
    if [[ \${RESET_TEST_FAIL:-} == preview && "$*" == *apply_reset=off* ]]; then exit 31; fi
    if [[ \${RESET_TEST_FAIL:-} == rehearsal && "$*" == *zhiv_game_reset_verify_* ]]; then exit 32; fi ;;
  *pg_dump*) printf 'fake dump for shell orchestration test\\n' ;;
  *pg_restore*) cat >/dev/null
    if [[ \${RESET_TEST_FAIL:-} == restore && "$*" == *--exit-on-error* ]]; then exit 33; fi ;;
esac
`);
    await chmod(join(bin, "docker"), 0o700);
    const invoke = (args = [], failure = "") => spawnSync("bash", [join(project, "scripts/reset-game-progress.sh"), ...args], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RESET_TEST_LOG: log, RESET_TEST_FAIL: failure },
    });
    const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    await run({ invoke, calls, directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("default preview cannot stop services, create a backup or apply SQL", () => sandbox(async ({ invoke, calls }) => {
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const commands = await calls();
  assert.equal(commands.length, 2);
  assert.match(commands[1], /psql .* -d zhiv .*apply_reset=off/);
  assert.doesNotMatch(commands.join("\n"), /stop|pg_dump|apply_reset=on/);
}));

test("unknown options fail before contacting Docker", () => sandbox(async ({ invoke, calls }) => {
  assert.equal(invoke(["--confirm-delete-all-users"]).status, 2);
  assert.deepEqual(await calls(), []);
}));

for (const failure of ["preview", "restore", "rehearsal"]) {
  test(`failed ${failure} never resets the live database`, () => sandbox(async ({ invoke, calls }) => {
    assert.notEqual(invoke(["--confirm-reset-game-progress"], failure).status, 0);
    const commands = await calls();
    assert.ok(!commands.some(command => /psql .* -d zhiv .*apply_reset=on/.test(command)));
    assert.ok(!commands.some(command => / up -d /.test(command)));
    if (failure === "preview") assert.ok(!commands.some(command => / stop |pg_dump/.test(command)));
  }));
}

test("live reset follows full backup restore and successful rehearsal, retaining a private original dump", () => sandbox(async ({ invoke, calls, directory }) => {
  const result = invoke(["--confirm-reset-game-progress"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = await calls();
  const at = pattern => commands.findIndex(command => pattern.test(command));
  const stop = at(/ stop caddy web api$/), dump = at(/pg_dump/), restore = at(/pg_restore .*--exit-on-error/);
  const rehearsal = at(/psql .* -d zhiv_game_reset_verify_.*apply_reset=on/);
  const live = at(/psql .* -d zhiv .*apply_reset=on/), start = at(/ up -d /);
  assert.ok(stop >= 0 && stop < dump && dump < restore && restore < rehearsal && rehearsal < live && live < start);
  const backupDir = join(directory, "zhiv-backups");
  const backups = (await readdir(backupDir)).filter(name => name.endsWith(".dump"));
  assert.equal(backups.length, 1);
  assert.equal((await stat(join(backupDir, backups[0]))).mode & 0o077, 0);
}));
