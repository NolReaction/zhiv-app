import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import yaml from "js-yaml";

const repository = fileURLToPath(new URL("../", import.meta.url));
const keyName = "NEXT_PUBLIC_MAPTILER_KEY";
const reference = `process.env.${keyName}`;

test("optional MapTiler configuration reaches the Docker build rather than runtime-only environment", async () => {
  const compose = yaml.load(await readFile(join(repository, "deploy/compose.yml"), "utf8"));
  assert.equal(compose.services.web.build.args[keyName], `\${${keyName}:-}`,
    "an unset or empty key must remain a valid ordinary-map deployment");
  assert.equal(compose.services.web.environment[keyName], undefined);
  assert.equal(compose.services.api.environment[keyName], undefined);

  const dockerfile = await readFile(join(repository, "deploy/web.Dockerfile"), "utf8");
  const [, build, runtime] = dockerfile.split(/^FROM /m);
  assert.match(build, /^ARG NEXT_PUBLIC_MAPTILER_KEY=$/m);
  assert.match(build, /^ENV NEXT_PUBLIC_MAPTILER_KEY=\$\{NEXT_PUBLIC_MAPTILER_KEY\}$/m);
  assert.ok(build.indexOf(`ENV ${keyName}=`) < build.indexOf("RUN npm run build:vps"),
    "Next must see the public key while compiling client code");
  assert.ok(!runtime.includes(keyName), "a runtime environment variable cannot change an embedded key");

  for (const path of [".env.example", "deploy/.env.example"]) {
    assert.equal(parseEnv(await readFile(join(repository, path), "utf8"))[keyName], "",
      `${path} must contain only an empty optional placeholder`);
  }
  const dockerignore = await readFile(join(repository, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\.env\*$/m, "local credentials must stay outside the Docker context");
  assert.match(dockerignore, /^\*\*\/\.env\*$/m);
});

test("Next and Sites use their standard public-env support for missing, empty, file and build-time keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-maptiler-env-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    // Resolve framework modules from the repository, but load env/config only
    // from the temporary fixture. Never inspect a developer's real .env.local.
    const imports = {
      nextEnv: import.meta.resolve("@next/env"),
      nextStatic: import.meta.resolve("next/dist/lib/static-env.js"),
      vinext: import.meta.resolve("vinext"),
      vite: import.meta.resolve("vite"),
    };
    const cases = [
      { name: "missing", file: null, expected: null },
      { name: "empty", file: "", expected: "" },
      { name: "local file", file: "fixture-maptiler-browser-key", expected: "fixture-maptiler-browser-key" },
      { name: "build environment overrides file", file: "fixture-file-key", environment: "fixture-build-key", expected: "fixture-build-key" },
      { name: "empty build environment disables file key", file: "fixture-file-key", environment: "", expected: "" },
    ];
    for (const scenario of cases) {
      await writeFile(join(directory, ".env.local"),
        `${scenario.file === null ? "" : `${keyName}=${scenario.file}\n`}MAPTILER_PRIVATE_FIXTURE=fixture-private-value\n`);
      const childEnvironment = { ...process.env, NODE_ENV: "production" };
      delete childEnvironment[keyName];
      delete childEnvironment.MAPTILER_PRIVATE_FIXTURE;
      if (scenario.environment !== undefined) childEnvironment[keyName] = scenario.environment;
      for (const framework of ["next", "sites"]) {
        const script = `
          import assert from 'node:assert/strict';
          const imports = ${JSON.stringify(imports)};
          let definitions;
          if (${JSON.stringify(framework)} === 'next') {
            const { default: nextEnv } = await import(imports.nextEnv);
            nextEnv.loadEnvConfig(process.cwd(), false, undefined, true);
            const { default: nextStatic } = await import(imports.nextStatic);
            definitions = nextStatic.getNextPublicEnvironmentVariables();
          } else {
            const { default: vinext } = await import(imports.vinext);
            const { resolveConfig } = await import(imports.vite);
            const config = await resolveConfig({
              root: process.cwd(), configFile: false, logLevel: 'silent',
              plugins: [vinext({ react: false, rsc: false, nextConfig: {} })],
            }, 'build', 'production');
            assert.equal(config.define['process.env.MAPTILER_PRIVATE_FIXTURE'], undefined);
            definitions = Object.fromEntries(Object.entries(config.define)
              .filter(([name]) => name.startsWith('process.env.NEXT_PUBLIC_'))
              .map(([name, value]) => [name, JSON.parse(value)]));
          }
          assert.equal(definitions[${JSON.stringify(reference)}] ?? null, ${JSON.stringify(scenario.expected)});
          assert.equal(definitions['process.env.MAPTILER_PRIVATE_FIXTURE'], undefined);
        `;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: directory, env: childEnvironment, encoding: "utf8", timeout: 20_000,
        });
        assert.equal(result.status, 0, `${framework}: ${scenario.name}\n${result.stderr}`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
