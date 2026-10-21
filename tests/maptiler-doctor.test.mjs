import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const doctor = fileURLToPath(new URL("../scripts/maptiler-doctor.mjs", import.meta.url));
const keyName = "NEXT_PUBLIC_MAPTILER_KEY";
const fixtureKey = "fixture-maptiler-doctor-value";

async function diagnose(t, files, override) {
  const cwd = await mkdtemp(join(tmpdir(), "zhiv-maptiler-doctor-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(cwd, name), contents);
  const env = { ...process.env, NODE_ENV: "production" };
  delete env[keyName];
  delete env.__NEXT_PROCESSED_ENV;
  if (override !== undefined) env[keyName] = override;
  const result = spawnSync(process.execPath, [doctor], { cwd, env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(fixtureKey), "the key must never appear in the diagnostic report");
  return result;
}

test("doctor identifies a loaded Next DEV file even under inherited production mode without exposing its value", async t => {
  const result = await diagnose(t, {
    ".env.local": `${keyName}=${fixtureKey}\n`,
    ".env.production.local": `${keyName}=https://production.invalid/\n`,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\.env.local: найден/);
  assert.match(result.stdout, /Источник NEXT_PUBLIC_MAPTILER_KEY: \.env.local/);
  assert.match(result.stdout, /ключ прочитан, формат допустим/);
});

test("doctor explains a missing file and hidden Windows txt extension", async t => {
  const result = await diagnose(t, { ".env.local.txt": `${keyName}=${fixtureKey}\n` });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\.env.local: не найден/);
  assert.match(result.stdout, /уберите расширение \.txt/);
  assert.match(result.stdout, /ключ отсутствует или пуст/);
});

test("doctor diagnoses a UTF-16 file that Next cannot parse", async t => {
  const result = await diagnose(t, { ".env.local": Buffer.from(`\ufeff${keyName}=${fixtureKey}\n`, "utf16le") });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /UTF-16/);
  assert.match(result.stdout, /сохраните его как обычный текст UTF-8/);
});

test("doctor identifies an empty terminal override instead of blaming a valid local file", async t => {
  const result = await diagnose(t, { ".env.local": `${keyName}=${fixtureKey}\n` }, "");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Источник NEXT_PUBLIC_MAPTILER_KEY: переменная терминала/);
  assert.match(result.stdout, /Пустая переменная терминала перекрывает/);
});

test("doctor identifies the exact required variable name and refuses URL values without echoing them", async t => {
  const alias = await diagnose(t, { ".env.local": `MAPTILER_KEY=${fixtureKey}\n` });
  assert.equal(alias.status, 1);
  assert.match(alias.stdout, /Использовано другое имя переменной/);
  const url = `https://api.maptiler.com/maps/satellite-v2/tiles.json?key=${fixtureKey}`;
  const invalid = await diagnose(t, { ".env.local": `${keyName}=${url}\n` });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /неверный формат/);
  assert.ok(!invalid.stdout.includes(url));
});

test("doctor shows file precedence when another DEV file overrides .env.local", async t => {
  const result = await diagnose(t, {
    ".env.local": `${keyName}=${fixtureKey}\n`,
    ".env.development.local": `${keyName}=\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Источник NEXT_PUBLIC_MAPTILER_KEY: \.env.development.local/);
});
