import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../features/world/dev/world-dev-hmr-cache.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { retainWorldDevClientState } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function withEnvironment(mode, windowValue, run) {
  const previousMode = process.env.NODE_ENV;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  process.env.NODE_ENV = mode;
  if (windowValue === undefined) delete globalThis.window;
  else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowValue });
  try { return run(); }
  finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}

test("server and production calls create independent state without a browser registry", () => {
  for (const [mode, browser] of [["development", undefined], ["production", {}]]) {
    withEnvironment(mode, browser, () => {
      const first = retainWorldDevClientState("session", "1", () => ({}));
      const second = retainWorldDevClientState("session", "1", () => ({}));
      assert.notEqual(first.value, second.value);
      assert.equal(first.reused, false);
      assert.equal(second.reused, false);
      if (browser) assert.equal(browser.__zhivWorldDevHmrCacheV1, undefined);
    });
  }
});

test("development refresh retains the exact live state and avoids rerunning its factory", () => {
  withEnvironment("development", {}, () => {
    let created = 0;
    const identity = {};
    const first = retainWorldDevClientState("editor", "3", () => { created++; return { undo: [1], selection: "tree" }; }, { identity });
    first.value.undo.push(2);
    const refreshed = retainWorldDevClientState("editor", "3", () => { created++; return {}; }, { identity });
    assert.equal(refreshed.value, first.value);
    assert.equal(refreshed.reused, true);
    assert.equal(created, 1);
    assert.deepEqual(refreshed.value.undo, [1, 2]);
    assert.equal(refreshed.value.selection, "tree");
  });
});

test("schema or owner changes dispose the previous instance before creating its replacement", () => {
  withEnvironment("development", {}, () => {
    const events = [];
    const firstOwner = {}, nextOwner = {};
    const original = retainWorldDevClientState("coordinator", "1", () => ({ id: 1 }), { identity: firstOwner });
    const replacement = retainWorldDevClientState("coordinator", "1", () => { events.push("create:2"); return { id: 2 }; }, {
      identity: nextOwner, dispose: value => { assert.equal(value, original.value); events.push("dispose:1"); },
    });
    assert.equal(replacement.reused, false);
    const upgraded = retainWorldDevClientState("coordinator", "2", () => { events.push("create:3"); return { id: 3 }; }, {
      identity: nextOwner, dispose: value => { assert.equal(value, replacement.value); events.push("dispose:2"); },
    });
    assert.equal(upgraded.reused, false);
    assert.deepEqual(events, ["dispose:1", "create:2", "dispose:2", "create:3"]);
  });
});
