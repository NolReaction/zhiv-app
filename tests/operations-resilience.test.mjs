import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const readYaml = async path => yaml.load(await readFile(join(root, path), "utf8"));

test("optional alert configuration preserves existing scrapes and exposes no additional port or application secret", async () => {
  const base = await readYaml("deploy/monitoring/prometheus.yml");
  const enabled = await readYaml("deploy/monitoring/prometheus-alerting.yml");
  assert.deepEqual(enabled.global, base.global);
  assert.deepEqual(enabled.scrape_configs.filter(job => job.job_name !== "alertmanager"), base.scrape_configs);
  assert.deepEqual(enabled.rule_files.slice(0, 1), base.rule_files);
  assert.deepEqual(enabled.alerting.alertmanagers[0].static_configs[0].targets, ["alertmanager:9093"]);
  const overlay = await readYaml("deploy/monitoring/alerting.compose.yml");
  assert.deepEqual(Object.keys(overlay.services).sort(), ["alertmanager", "prometheus"]);
  assert.equal(overlay.services.alertmanager.ports, undefined);
  assert.deepEqual(overlay.services.alertmanager.networks, ["backend", "outbound"]);
  assert.equal(overlay.services.alertmanager.read_only, true);
  assert.deepEqual(overlay.services.alertmanager.profiles, ["monitoring"]);
  assert.ok(!JSON.stringify(overlay).includes("docker.sock"));
  assert.ok(!JSON.stringify(overlay).includes("auth-secrets"));
  assert.ok(!JSON.stringify(overlay).includes("db_admin"));
  const receiver = await readYaml("deploy/monitoring/alertmanager.yml");
  const webhook = receiver.receivers[0].webhook_configs[0];
  assert.equal(webhook.url, undefined);
  assert.equal(webhook.url_file, "/run/secrets/alert_webhook_url");
  assert.equal(webhook.http_config.follow_redirects, false);
  assert.equal(webhook.send_resolved, true);
  assert.ok(webhook.timeout && webhook.max_alerts);
});

const validConfig = () => ({
  services: {
    api: { read_only: true, environment: { SECRET: "SENSITIVE_VALUE" } },
    web: { read_only: true }, db: {},
    caddy: { ports: [{ target: 80, published: "80" }, { target: 443, published: "443" }] },
  }, networks: { backend: { internal: true } },
});
const check = config => spawnSync("python3", ["-B", join(root, "scripts/check-deploy-perimeter.py")], {
  input: typeof config === "string" ? config : JSON.stringify(config), encoding: "utf8",
});

test("offline perimeter checker rejects bypass paths and never echoes secrets or untrusted service names", () => {
  assert.equal(check(validConfig()).status, 0);
  const mutations = [
    config => { config.services.api.ports = [{ target: 8080, published: "8080" }]; },
    config => { config.services.db.network_mode = "host"; },
    config => { config.services.api.privileged = true; },
    config => { config.services.api.volumes = [{ type: "bind", source: "/var/run/docker.sock", target: "/socket" }]; },
    config => { config.services.api.volumes = [{ type: "bind", source: "/", target: "/host" }]; },
    config => { config.services["SENSITIVE_VALUE"] = { ports: [{ target: 9000, published: "9000" }] }; },
    config => { config.networks.backend.internal = false; },
    config => { config.services.caddy.ports.push({ target: 2019, published: "2019" }); },
    config => { config.services.web.read_only = false; },
  ];
  for (const mutate of mutations) {
    const config = validConfig(); mutate(config);
    const result = check(config);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL:/);
    assert.ok(!(result.stdout + result.stderr).includes("SENSITIVE_VALUE"));
  }
  for (const malformed of ['{"SECRET":"SENSITIVE_VALUE"', "null", "[]", '{"services":false}', '{"services":{"api":{},"web":{},"db":{},"caddy":{}},"networks":null}']) {
    const result = check(malformed);
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes("SENSITIVE_VALUE"));
    assert.ok(!result.stderr.includes("Traceback"));
  }
});

async function restoreFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-restore-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "temporary"));
  const dump = join(directory, "source.dump");
  await writeFile(dump, "PGDMP SENSITIVE_ROW");
  const log = join(directory, "calls.jsonl");
  await writeFile(join(directory, "bin/docker"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DRILL_TEST_LOG'], 'a') as output:
    output.write(json.dumps({'args':args, 'forbiddenEnv':[key for key in os.environ if key.startswith(('COMPOSE_', 'DOCKER_', 'POSTGRES_', 'PG'))]})+'\\n')
if 'pg_restore' in args:
    sys.stdin.buffer.read()
    print('SENSITIVE_ROW', file=sys.stderr)
    if os.environ.get('DRILL_TEST_FAILURE') == 'restore': sys.exit(42)
if 'psql' in args: print(os.environ.get('DRILL_TEST_VERSION', '61'))
if 'down' in args and os.environ.get('DRILL_TEST_FAILURE') == 'cleanup': sys.exit(42)
if 'config' in args:
    project = args[args.index('--project-name') + 1]
    print(json.dumps({'name':project,'services':{'db':{'image':'postgres:18-alpine','networks':{'restore':None},'volumes':[{'type':'volume','source':'restore_data','target':'/var/lib/postgresql'}],'environment':{'POSTGRES_DB':'zhiv_restore','POSTGRES_USER':'zhiv_restore','POSTGRES_PASSWORD':'SENSITIVE_VALUE'}}},'volumes':{'restore_data':{'name':('zhiv_postgres_data' if os.environ.get('DRILL_TEST_UNSAFE') else project+'_restore_data')}},'networks':{'restore':{'name':project+'_restore','internal':True}}}))
`, { mode: 0o755 });
  return { directory, dump, log, run(options = [], extraEnv = {}) {
    return spawnSync("python3", ["-B", join(root, "scripts/restore-backup-drill.py"), dump, ...options], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, ...extraEnv, PATH: `${join(directory, "bin")}:${process.env.PATH}`,
        TMPDIR: join(directory, "temporary"), DRILL_TEST_LOG: log, DOCKER_HOST: "tcp://production.invalid:2375",
        COMPOSE_PROJECT_NAME: "zhiv", COMPOSE_FILE: "/production/compose.yml", POSTGRES_PASSWORD: "SENSITIVE_VALUE", PGHOST: "production.invalid" },
    });
  } };
}

test("restore drill is plan-only by default and rejects non-archives before starting Docker", async t => {
  const fixture = await restoreFixture(t);
  assert.equal(fixture.run().status, 0);
  await assert.rejects(readFile(fixture.log));
  await writeFile(fixture.dump, "not an archive");
  assert.equal(fixture.run(["--execute"]).status, 1);
  await assert.rejects(readFile(fixture.log));
});

test("restore execution pins local daemon, isolated project and archive, then cleans up on success or restore failure", async t => {
  for (const failure of ["", "restore", "cleanup"]) {
    const fixture = await restoreFixture(t);
    const result = fixture.run(["--execute", "--expect-schema", "61"], { DRILL_TEST_FAILURE: failure });
    assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes("SENSITIVE"));
    const calls = (await readFile(fixture.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.length >= 3);
    const projects = new Set(calls.map(call => call.args[call.args.indexOf("--project-name") + 1]));
    assert.equal(projects.size, 1);
    assert.match([...projects][0], /^zhiv-restore-drill-[a-f0-9]{32}$/);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 3), ["--host", "unix:///var/run/docker.sock", "compose"]);
      assert.deepEqual(call.forbiddenEnv, []);
      assert.equal(call.args[call.args.indexOf("-f") + 1], join(root, "deploy/restore.compose.yml"));
    }
    const last = calls.at(-1).args;
    assert.deepEqual(last.slice(-5), ["down", "--volumes", "--remove-orphans", "--timeout", "10"]);
    assert.equal(await readFile(fixture.dump, "utf8"), "PGDMP SENSITIVE_ROW");
    assert.deepEqual(await readdir(join(fixture.directory, "temporary")), []);
    if (failure === "cleanup") assert.match(result.stdout, /Cleanup failed for isolated project zhiv-restore-drill-/);
  }
});

test("restore rehearsal rejects wrong schema and uses a private network with only project-scoped data", async t => {
  const fixture = await restoreFixture(t);
  const result = fixture.run(["--execute", "--expect-schema", "61"], { DRILL_TEST_VERSION: "60" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /verify migration history/);
  const compose = await readYaml("deploy/restore.compose.yml");
  assert.deepEqual(Object.keys(compose.services), ["db"]);
  assert.equal(compose.services.db.ports, undefined);
  assert.equal(compose.networks.restore.internal, true);
  assert.deepEqual(compose.services.db.volumes, ["restore_data:/var/lib/postgresql"]);
  assert.deepEqual(Object.keys(compose.volumes), ["restore_data"]);
  assert.equal(compose.volumes.restore_data?.external, undefined);
});

test("changed restore volume configuration cannot start containers or trigger cleanup of a production volume", async t => {
  const fixture = await restoreFixture(t);
  const result = fixture.run(["--execute"], { DRILL_TEST_UNSAFE: "yes" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /verify isolated Compose configuration/);
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-3), ["config", "--format", "json"]);
  assert.ok(!(result.stdout + result.stderr).includes("SENSITIVE_VALUE"));
});
