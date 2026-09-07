import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("../scripts/configure-admin.py", import.meta.url));
function setup(path, ids) {
  return execFileSync("python3", ["-B", "-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("admin_setup", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.configure(pathlib.Path(sys.argv[2]), sys.argv[3:])
`, script, path, ...ids], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function fixture(t, content) {
  const root = mkdtempSync(join(tmpdir(), "zhiv-admin-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, ".env");
  writeFileSync(path, content);
  return { root, path };
}
test("admin setup preserves deployment secrets, existing admins and optional profiles on repeated execution", t => {
  const { root, path } = fixture(t, '# Existing configuration\nDB_PASSWORD="unchanged-$literal"\nADMIN_PUBLIC_IDS=7K3P-2Q9M-W8ZR\nCOMPOSE_PROFILES=optional\n');
  assert.equal(setup(path, ["8K3P-2Q9M-W8ZR"]), "");
  const tokenPath = join(root, ".secrets/monitoring/token");
  const token = readFileSync(tokenPath, "utf8");
  assert.match(token.trim(), /^[A-Za-z0-9_-]{64}$/);
  chmodSync(tokenPath, 0o600);
  setup(path, ["8K3P-2Q9M-W8ZR"]);
  assert.equal(readFileSync(tokenPath, "utf8"), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o444);
  assert.equal(statSync(join(root, ".secrets")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = readFileSync(path, "utf8");
  assert.ok(saved.includes('DB_PASSWORD="unchanged-$literal"'));
  assert.equal(saved.match(/^ADMIN_PUBLIC_IDS=/gm)?.length, 1);
  assert.match(saved, /^ADMIN_PUBLIC_IDS=7K3P-2Q9M-W8ZR,8K3P-2Q9M-W8ZR$/m);
  assert.match(saved, /^COMPOSE_PROFILES=optional,monitoring$/m);
  assert.match(saved, /^METRICS_TOKEN_FILE=\/run\/monitoring-secrets\/token$/m);
  assert.ok(!saved.includes(token.trim()));
});
test("invalid administrator input leaves configuration and secrets untouched", t => {
  const original = "DB_PASSWORD=preserved\nADMIN_PUBLIC_IDS=\n";
  const { root, path } = fixture(t, original);
  for (const ids of [[], ["*"], ["7k3p-2q9m-w8zr"], ["7K3P-2Q9M-W8ZR\nADMIN_PUBLIC_IDS=*"]]) {
    assert.throws(() => setup(path, ids));
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(existsSync(join(root, ".secrets")), false);
  }
});
test("invalid existing token is never rotated or activated implicitly", t => {
  const original = "ADMIN_PUBLIC_IDS=\n";
  const { root, path } = fixture(t, original);
  mkdirSync(join(root, ".secrets/monitoring"), { recursive: true });
  const tokenPath = join(root, ".secrets/monitoring/token");
  writeFileSync(tokenPath, "invalid-token\n");
  assert.throws(() => setup(path, ["7K3P-2Q9M-W8ZR"]));
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(readFileSync(tokenPath, "utf8"), "invalid-token\n");
});
test("deployment credentials remain readable by non-root containers under umask 077", t => {
  const { root } = fixture(t, "");
  mkdirSync(join(root, "scripts"));
  const fixtureScript = join(root, "scripts/create-deploy-secrets.mjs");
  writeFileSync(fixtureScript, readFileSync(new URL("../scripts/create-deploy-secrets.mjs", import.meta.url)));
  execFileSync(process.execPath, ["--input-type=module", "-e", "process.umask(0o077); await import(process.argv[1]);", pathToFileURL(fixtureScript).href]);
  const secretRoot = join(root, "deploy/.secrets");
  assert.equal(statSync(secretRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(secretRoot, "monitoring")).mode & 0o777, 0o755);
  for (const file of ["db_admin", "db_migration", "db_app", "monitoring/token"]) {
    assert.equal(statSync(join(secretRoot, file)).mode & 0o777, 0o444);
  }
});
