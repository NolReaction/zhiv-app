import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepositorySecrets, scanSecretText } from "../scripts/check-secrets.mjs";

const script = fileURLToPath(new URL("../scripts/check-secrets.mjs", import.meta.url));
const alphabet = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const fakeProviderToken = ["ghp", alphabet.slice(0, 36)].join("_");
const assignment = (name, value) => `${name} = ${JSON.stringify(value)}`;
const environmentLine = (name, value, separator = "=") => name + separator + value;
const fixture = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "zhiv-secret-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Scanner test");
  git("config", "user.email", "scanner@example.invalid");
  return { dir, git, put: (file, value) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), value); } };
};

test("provider tokens and private keys are detected even in test and example files", () => {
  const providerSamples = [
    fakeProviderToken,
    ["github", "pat", alphabet.repeat(2)].join("_"),
    ["sk", "proj", alphabet].join("-"),
    ["AK", "IA", "A1B2C3D4E5F6G7H8"].join(""),
    ["AI", "za", alphabet.slice(0, 35)].join(""),
    ["xoxb", alphabet].join("-"),
    ["sk", "live", alphabet].join("_"),
    ["123456789", alphabet.slice(0, 35)].join(":"),
    ["eyJ" + alphabet, alphabet, alphabet].join("."),
    ["-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"].join(""),
    ["-----BEGIN ", "ENCRYPTED ", "PRIVATE KEY-----"].join(""),
  ];
  for (const value of providerSamples) {
    const findings = scanSecretText("tests/.env.example", value);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 1);
    assert.match(findings[0].fingerprint, /^[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(findings).includes(value), false);
  }
});

test("quoted, JSON, YAML and dotenv literals are checked without entropy shortcuts", () => {
  const lines = [assignment("clientSecret", "short-value"), JSON.stringify({ ["access" + "_token"]: "another-value" }), environmentLine("DATABASE_PASSWORD", "plain-password"), environmentLine("API_KEY", "service-value", ": ")];
  const findings = scanSecretText("config.txt", lines.join("\n"));
  assert.deepEqual(findings.map(({ line, kind }) => [line, kind]), [[1, "credential-literal"], [2, "credential-literal"], [3, "credential-literal"], [4, "credential-literal"]]);
  for (const key of ["AWS_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "SMTP_PASS", "METRICS_BEARER_TOKEN", "Authorization"]) {
    assert.equal(scanSecretText("config.txt", assignment(key, alphabet)).length, 1);
  }
});

test("credential URLs are rejected but public identifiers and runtime references are allowed", () => {
  const url = ["https://", "user", ":", "private-value", "@", "example.invalid/path"].join("");
  assert.equal(scanSecretText("config.ts", url)[0].kind, "credential-url");
  const safe = ["password = process.env.DB_PASSWORD", "const apiKey = readSecret()", "DATABASE_PASSWORD_FILE=/run/secrets/db", "API_KEY=${SERVICE_KEY}", assignment("clientSecret", "<secret>"), assignment("password", "$(cat /run/secrets/db-app)"), JSON.stringify({ oauthClientId: "public-client", databaseId: alphabet, "react-password-toggle-field": "1.0.0" })];
  assert.deepEqual(scanSecretText("config.txt", safe.join("\n")), []);
});

test("placeholder word inside an actual credential is not an exemption", () => {
  for (const value of ["test-" + alphabet, "${ENV}-" + alphabet, "<replace>" + alphabet]) {
    assert.equal(scanSecretText(".env.example", assignment("apiKey", value)).length, 1);
  }
});

test("fixture exemptions are exact file and value, never a whole test directory", () => {
  const knownPath = "apps/api/src/test/kotlin/ru/zhiv/auth/VkIdTest.kt";
  const harmlessFixture = assignment("access_token", "secret");
  assert.deepEqual(scanSecretText(knownPath, harmlessFixture), []);
  assert.equal(scanSecretText("app/api.ts", harmlessFixture).length, 1);
  assert.equal(scanSecretText(knownPath, assignment("access_token", "a-different-value")).length, 1);
  assert.ok(scanSecretText(knownPath, fakeProviderToken).some(({ kind }) => kind === "github-token"));
});

test("default scans tracked working bytes, including unstaged changes and text disguised as an image", (t) => {
  const repo = fixture(t);
  repo.put("config.txt", "safe"); repo.git("add", "config.txt");
  repo.put("config.txt", fakeProviderToken);
  repo.put("leak.png", fakeProviderToken); repo.git("add", "leak.png");
  repo.put("ignored.env", fakeProviderToken);
  const result = checkRepositorySecrets(repo.dir);
  assert.equal(result.mode, "tracked-working-tree");
  assert.deepEqual(result.findings.map(({ file }) => file), ["config.txt", "leak.png"]);
});

test("unreadable or deleted tracked file never produces a clean scan", (t) => {
  const repo = fixture(t);
  repo.put("missing.txt", "safe"); repo.git("add", "missing.txt"); rmSync(path.join(repo.dir, "missing.txt"));
  const result = spawnSync(process.execPath, [script], { cwd: repo.dir, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no clean result/);
  assert.equal(result.stdout, "");
});

test("tracked symlinks never read local files outside the repository", (t) => {
  const repo = fixture(t);
  symlinkSync(path.join(repo.dir, ".."), path.join(repo.dir, "outside")); repo.git("add", "outside");
  assert.throws(() => checkRepositorySecrets(repo.dir), /outside repository/);
});

test("large text files fail visibly instead of being skipped", (t) => {
  const repo = fixture(t);
  repo.put("oversized.txt", "a".repeat(4 * 1024 * 1024 + 1)); repo.git("add", "oversized.txt");
  assert.throws(() => checkRepositorySecrets(repo.dir), /size limit/);
  repo.git("rm", "--cached", "oversized.txt");
  repo.put("disguised.png", "a".repeat(4 * 1024 * 1024 + 1)); repo.git("add", "disguised.png");
  assert.throws(() => checkRepositorySecrets(repo.dir), /size limit/);
});

test("history scans deleted credentials from reachable commits with no raw values in the report", (t) => {
  const repo = fixture(t);
  repo.put("old.txt", fakeProviderToken); repo.git("add", "old.txt"); repo.git("commit", "-qm", "Synthetic fixture");
  repo.put("old.txt", "safe"); repo.git("add", "old.txt"); repo.git("commit", "-qm", "Remove synthetic fixture");
  assert.deepEqual(checkRepositorySecrets(repo.dir).findings, []);
  const result = checkRepositorySecrets(repo.dir, { history: true });
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].object, /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(result).includes(fakeProviderToken), false);
  const cli = spawnSync(process.execPath, [script, "--history"], { cwd: repo.dir, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal((cli.stdout + cli.stderr).includes(fakeProviderToken), false);
});

test("history refuses shallow checkouts", (t) => {
  const repo = fixture(t);
  repo.put("safe.txt", "safe"); repo.git("add", "safe.txt"); repo.git("commit", "-qm", "Fixture");
  writeFileSync(path.join(repo.dir, ".git/shallow"), repo.git("rev-parse", "HEAD") + "\n");
  assert.throws(() => checkRepositorySecrets(repo.dir, { history: true }), /non-shallow/);
});

test("fixture registry has specific paths, documented reasons and full fingerprints only", () => {
  const registry = JSON.parse(readFileSync(new URL("../scripts/secret-scan-fixtures.json", import.meta.url)));
  assert.equal(new Set(registry.map(({ file }) => file)).size, registry.length);
  for (const item of registry) {
    assert.equal(/[?*]/.test(item.file), false);
    assert.ok(item.reason.length > 10);
    assert.ok(item.sha256.length > 0);
    for (const fingerprint of item.sha256) assert.match(fingerprint, /^[a-f0-9]{64}$/);
  }
});
