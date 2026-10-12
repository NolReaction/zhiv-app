import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/configure-web-push.mjs", import.meta.url));
const names = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"];

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), "zhiv-push-setup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".env");
  if (source !== null) writeFileSync(path, source, { mode: 0o644 });
  const run = (...args) => spawnSync(process.execPath, [script, "--env", path, ...args], { encoding: "utf8" });
  return { directory, path, run };
}

function config(source) {
  return Object.fromEntries(source.split("\n").flatMap(line => {
    const match = line.match(/^(WEB_PUSH_VAPID_[A-Z_]+)=([^\s#]+)/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

test("setup generates a matching P-256 pair without dependencies or secret output and preserves unrelated settings", t => {
  const retained = '# SMTP must stay intact\nDOMAIN="im-alive.ru" # public origin\nSMTP_PASSWORD_FILE=/run/auth-secrets/smtp_password\nUNRELATED="literal # comment"\n';
  const { path, directory, run } = fixture(t, `${retained}WEB_PUSH_VAPID_PUBLIC_KEY= # browser key\nWEB_PUSH_VAPID_PRIVATE_KEY=\nWEB_PUSH_VAPID_SUBJECT=\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const saved = readFileSync(path, "utf8");
  assert.ok(saved.startsWith(retained));
  assert.match(saved, /WEB_PUSH_VAPID_PUBLIC_KEY=[A-Za-z0-9_-]+ # browser key\n/);
  const values = config(saved);
  const curve = createECDH("prime256v1");
  const privateBytes = Buffer.from(values[names[1]], "base64url");
  assert.equal(privateBytes.length, 32);
  curve.setPrivateKey(privateBytes);
  assert.equal(curve.getPublicKey().toString("base64url"), values[names[0]]);
  assert.equal(values[names[2]], "https://im-alive.ru");
  for (const name of names.slice(0, 2)) assert.ok(!(result.stdout + result.stderr).includes(values[name]));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), [".env"]);
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(path, "utf8"), saved);
  assert.match(repeated.stdout, /already configured/);
});

test("setup supports missing entries, CRLF, explicit contact and short padded private scalars", t => {
  const { path, run } = fixture(t, "# retained\r\nDOMAIN=im-alive.ru\r\n");
  assert.equal(run("--subject", "mailto:admin@example.com").status, 0);
  let saved = readFileSync(path, "utf8");
  assert.ok(saved.startsWith("# retained\r\nDOMAIN=im-alive.ru\r\n"));
  assert.equal(saved.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(config(saved)[names[2]], "mailto:admin@example.com");
  const scalar = Buffer.alloc(32); scalar[31] = 1;
  const curve = createECDH("prime256v1"); curve.setPrivateKey(scalar);
  saved = `${names[0]}='${curve.getPublicKey().toString("base64url")}' # existing\n${names[1]}="${scalar.toString("base64url")}"\n${names[2]}=mailto:admin@example.com\n`;
  writeFileSync(path, saved);
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(path, "utf8"), saved);
});

test("partial, duplicate and interpolated settings are refused without replacement", t => {
  const { path, directory, run } = fixture(t, "");
  for (const source of [
    "DOMAIN=im-alive.ru\nWEB_PUSH_VAPID_PRIVATE_KEY=existing-private-material\n",
    "DOMAIN=im-alive.ru\nWEB_PUSH_VAPID_SUBJECT=mailto:admin@example.com\n",
    "DOMAIN=im-alive.ru\nWEB_PUSH_VAPID_PUBLIC_KEY=\nWEB_PUSH_VAPID_PUBLIC_KEY=\n",
    "DOMAIN=${DEPLOY_DOMAIN}\n",
    "DOMAIN=im-alive.ru\nWEB_PUSH_VAPID_PRIVATE_KEY='unterminated\n",
  ]) {
    writeFileSync(path, source);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path, "utf8"), source);
    assert.ok(!(result.stdout + result.stderr).includes("existing-private-material"));
    assert.deepEqual(readdirSync(directory), [".env"]);
  }
});

test("invalid and mismatched existing keys are preserved and never logged", t => {
  const { path, run } = fixture(t, "DOMAIN=im-alive.ru\n");
  assert.equal(run().status, 0);
  const saved = readFileSync(path, "utf8");
  const values = config(saved);
  const other = createECDH("prime256v1"); other.generateKeys();
  for (const [name, replacement] of [
    [names[0], other.getPublicKey().toString("base64url")],
    [names[1], "invalid-secret-key"],
    [names[1], Buffer.alloc(32).toString("base64url")],
    [names[2], "http://insecure.example.com"],
  ]) {
    const source = saved.replace(`${name}=${values[name]}`, `${name}=${replacement}`);
    writeFileSync(path, source);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path, "utf8"), source);
    for (const secret of [values[names[1]], "invalid-secret-key"]) assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test("bad subjects and concurrent setup lock preserve the existing environment", t => {
  const source = "DOMAIN=im-alive.ru\n";
  const { path, run } = fixture(t, source);
  const authenticatedUrl = new URL("https://example.com");
  authenticatedUrl.username = "test-user";
  authenticatedUrl.password = randomBytes(16).toString("hex");
  for (const subject of ["http://example.com", authenticatedUrl.href, "mailto:invalid", "https://example.com\nOTHER=1"]) {
    assert.equal(run("--subject", subject).status, 1);
    assert.equal(readFileSync(path, "utf8"), source);
  }
  const lockPath = `${path}.web-push.lock`;
  writeFileSync(lockPath, "another setup");
  assert.equal(run().status, 1);
  assert.equal(readFileSync(path, "utf8"), source);
  assert.equal(readFileSync(lockPath, "utf8"), "another setup");
});

test("existing contact is not overwritten by a subsequent setup request", t => {
  const { path, run } = fixture(t, "DOMAIN=im-alive.ru\n");
  assert.equal(run().status, 0);
  const saved = readFileSync(path, "utf8");
  assert.equal(run("--subject", "mailto:new@example.com").status, 1);
  assert.equal(readFileSync(path, "utf8"), saved);
});

test("setup refuses missing environment and symlinks without creating a deployment", t => {
  const { directory, path, run } = fixture(t, null);
  assert.equal(run().status, 1);
  assert.deepEqual(readdirSync(directory), []);
  const target = join(directory, "original.env");
  const source = "DOMAIN=im-alive.ru\n";
  writeFileSync(target, source);
  symlinkSync(target, path);
  assert.equal(run().status, 1);
  assert.equal(readFileSync(target, "utf8"), source);
});
