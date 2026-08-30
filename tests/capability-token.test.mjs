import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const capability = await vite.ssrLoadModule("/lib/capability-token.ts");

after(async () => {
  await vite.close();
});

const token = "K_Px9NhbG9Y6vnUg3BDnv-o4m5GkSb9uLrv0ptuGSvU";

test("uses and normalizes an explicit public application origin", () => {
  const result = capability.resolveShareOrigin({
    currentOrigin: "http://localhost:3000",
    configuredOrigin: "  https://zhiv.example.ru/  ",
  });

  assert.deepEqual(result, {
    origin: "https://zhiv.example.ru",
    source: "configured",
    reason: null,
  });
});

test("allows an explicit LAN application origin for cross-device development", () => {
  const result = capability.resolveShareOrigin({
    currentOrigin: "http://localhost:3000",
    configuredOrigin: "http://192.168.1.232:3000/",
  });

  assert.deepEqual(result, {
    origin: "http://192.168.1.232:3000",
    source: "configured",
    reason: null,
  });
});

test("uses a non-loopback browser origin when no override is configured", () => {
  const result = capability.resolveShareOrigin({
    currentOrigin: "https://zhiv.example.ru/",
    configuredOrigin: "",
  });

  assert.deepEqual(result, {
    origin: "https://zhiv.example.ru",
    source: "current",
    reason: null,
  });
});

test("refuses loopback and unspecified browser origins without an override", () => {
  for (const currentOrigin of [
    "http://localhost:3000",
    "http://localhost.:3000",
    "http://app.localhost:3000",
    "http://app.localhost.:3000",
    "http://127.0.0.1:3000",
    "http://127.42.10.9:3000",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]:3000",
    "http://0.0.0.0:3000",
    "http://[::]:3000",
    "http://[::ffff:0.0.0.0]:3000",
  ]) {
    assert.deepEqual(
      capability.resolveShareOrigin({ currentOrigin, configuredOrigin: null }),
      { origin: null, source: null, reason: "loopback-origin" },
      currentOrigin,
    );
  }
});

test("rejects malformed or unsafe configured origins instead of silently falling back", () => {
  for (const configuredOrigin of [
    "ftp://zhiv.example.ru",
    "https://user:pass@zhiv.example.ru",
    "https://zhiv.example.ru/app",
    "https://zhiv.example.ru/?mode=invite",
    "https://zhiv.example.ru/#fragment",
    "//zhiv.example.ru",
    "not a URL",
  ]) {
    assert.deepEqual(
      capability.resolveShareOrigin({
        currentOrigin: "https://safe.example.ru",
        configuredOrigin,
      }),
      { origin: null, source: null, reason: "invalid-configured-origin" },
      configuredOrigin,
    );
  }
});

test("distinguishes missing and invalid browser origins", () => {
  assert.deepEqual(
    capability.resolveShareOrigin({ currentOrigin: null, configuredOrigin: null }),
    { origin: null, source: null, reason: "missing-origin" },
  );
  assert.deepEqual(
    capability.resolveShareOrigin({
      currentOrigin: "file:///tmp/index.html",
      configuredOrigin: null,
    }),
    { origin: null, source: null, reason: "invalid-current-origin" },
  );
});

test("builds an exact cross-device invite URL from the resolved origin", () => {
  const origin = capability.resolveShareOrigin({
    currentOrigin: "http://localhost:3000",
    configuredOrigin: "http://192.168.1.232:3000",
  });

  assert.deepEqual(capability.capabilityUrl("invite", token, origin), {
    url: `http://192.168.1.232:3000/#/invite/${token}`,
    reason: null,
  });
});

test("returns a structured unavailable result instead of emitting a localhost QR URL", () => {
  const origin = capability.resolveShareOrigin({
    currentOrigin: "http://localhost:3000",
    configuredOrigin: null,
  });

  assert.deepEqual(capability.capabilityUrl("invite", token, origin), {
    url: null,
    reason: "loopback-origin",
  });
});

test("builds recovery URLs through the same validated origin contract", () => {
  const origin = capability.resolveShareOrigin({
    currentOrigin: "https://zhiv.example.ru",
    configuredOrigin: null,
  });

  assert.deepEqual(capability.capabilityUrl("recover", token, origin), {
    url: `https://zhiv.example.ru/#/recover/${token}`,
    reason: null,
  });
});
