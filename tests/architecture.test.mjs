import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectArchitecture, moduleReferences } from "../scripts/lib/architecture.mjs";

const inspect = entries => inspectArchitecture(new Map(Object.entries(entries)));

test("application composition and erased cross-layer types preserve valid dependency direction", () => {
  const files = {
    "app/page.tsx": 'export { AppShell as default } from "@/features/app/app-shell";',
    "features/app/app-shell.tsx": 'import { Panel } from "@/features/economy/ui/market/panel"; export const AppShell = Panel;',
    "features/economy/ui/market/panel.tsx": 'import { useEconomy } from "../../sync/use-economy"; export const Panel = useEconomy;',
    "features/economy/sync/use-economy.ts": 'import { useState } from "react"; import { price } from "../domain/rules"; export const useEconomy = () => useState(price);',
    "features/economy/domain/rules.ts": 'import type { ScreenProps } from "../ui/types"; import { type State } from "../sync/types"; export type { ScreenProps } from "../ui/types"; export type Hook = import("../sync/use-economy"); export const price = 1;',
    "features/economy/ui/types.ts": 'export type ScreenProps = {};',
    "features/economy/sync/types.ts": 'export type State = {};',
  };
  assert.deepEqual(inspect(files), []);
});

test("domain boundaries cover imports, re-exports, dynamic literals, CSS and mixed type/value imports", () => {
  for (const statement of [
    'import { useState } from "react";',
    'export { useState } from "react";',
    'const load = () => import("next/navigation");',
    'const load = () => import(`react/jsx-runtime`);',
    'import { type Props, Panel } from "../ui/panel";',
    'export { type Props, Panel } from "../ui/panel";',
    'import "../ui/panel.module.css";',
    'import { session } from "../sync/session";',
  ]) {
    const diagnostics = inspect({
      "features/economy/domain/rules.ts": statement,
      "features/economy/ui/panel.tsx": 'export type Props = {}; export const Panel = 1;',
      "features/economy/ui/panel.module.css": '.panel {}',
      "features/economy/sync/session.ts": 'export const session = 1;',
    });
    assert.equal(diagnostics.length, 1, statement);
    assert.equal(diagnostics[0].rule, "domain-dependency", statement);
    assert.equal(diagnostics[0].line, 1);
  }
  assert.equal(inspect({ "features/world/domain/rules.ts": 'import React from "react";' })[0].rule, "domain-dependency");
});

test("sync cannot import screen helpers while JSON catalogs and integration remain usable", () => {
  assert.deepEqual(inspect({
    "features/economy/domain/model.ts": 'import catalog from "@/apps/api/catalog.json"; export const data = catalog;',
    "apps/api/catalog.json": '{}',
    "features/economy/integration/adapter.ts": 'import { state } from "@/features/world/state/snapshot";',
    "features/world/state/snapshot.ts": 'export const state = {};',
  }), []);
  const diagnostics = inspect({
    "features/economy/sync/command.ts": 'import { locked } from "../ui/parts";',
    "features/economy/ui/parts.ts": 'export const locked = false;',
  });
  assert.equal(diagnostics[0].rule, "sync-ui-dependency");
});

test("reusable features cannot depend on app-shell or route orchestration", () => {
  const diagnostics = inspect({
    "features/economy/ui/panel.tsx": 'export { AppShell } from "@/features/app/app-shell"; const page = () => import("@/app/page");',
    "features/app/app-shell.tsx": 'export const AppShell = 1;',
    "app/page.tsx": 'export default 1;',
  });
  assert.deepEqual(diagnostics.map(item => item.rule).sort(), ["app-orchestration", "route-orchestration"]);
});

test("missing aliases and relative imports are checked even when type-only; comments and packages are ignored", () => {
  const diagnostics = inspect({
    "features/world/domain/rules.ts": '// import missing from "./comment";\nconst label = "import broken from \'./text\'";\nimport type { Missing } from "./missing";\nexport { missing } from "@/features/missing";\nimport { z } from "zod";',
  });
  assert.deepEqual(diagnostics.map(item => [item.rule, item.line]), [["missing-local-import", 3], ["missing-local-import", 4]]);
});

test("local module resolution supports directories, explicit JS source imports and asset queries", () => {
  assert.deepEqual(inspect({
    "features/world/scene/scene.ts": 'import "../navigation"; import "./math.js"; import "./style.css?inline";',
    "features/world/navigation/index.ts": 'export {};',
    "features/world/scene/math.ts": 'export {};',
    "features/world/scene/style.css": '.scene {}',
  }), []);
});

test("runtime feature cycles include dynamic imports but not erased types or local API store cycles", () => {
  const diagnostics = inspect({
    "features/world/state/a.ts": 'export const load = () => import("./b");',
    "features/world/state/b.ts": 'export * from "./a";',
    "features/economy/domain/a.ts": 'import type { B } from "./b"; export type A = B;',
    "features/economy/domain/b.ts": 'import type { A } from "./a"; export type B = A;',
    "lib/dev/a.ts": 'import "./b";',
    "lib/dev/b.ts": 'import "./a";',
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "feature-cycle");
  assert.match(diagnostics[0].message, /features\/world\/state\/a\.ts/);
});

test("module parser distinguishes type-only declarations, mixed imports and empty side-effect imports", () => {
  const references = moduleReferences("fixture.ts", `
    import type { A } from "./types";
    import { type A } from "./types";
    export type * from "./types";
    export { type A } from "./types";
    import Default, { type A } from "./runtime";
    import {} from "./runtime";
    export {} from "./runtime";
    import "./runtime";
    const load = () => import(variable);
  `);
  assert.deepEqual(references.map(item => item.typeOnly), [true, true, true, true, false, false, false, false]);
});

test("CLI fails a broken checkout with actionable paths and succeeds after correcting the reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhiv-architecture-"));
  const script = fileURLToPath(new URL("../scripts/check-architecture.mjs", import.meta.url));
  try {
    await mkdir(path.join(root, "features/world/domain"), { recursive: true });
    const file = path.join(root, "features/world/domain/model.ts");
    await writeFile(file, 'import { lost } from "./old-location";');
    const broken = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /features\/world\/domain\/model\.ts:1:1 \[missing-local-import\]/);
    await writeFile(file, 'export const model = {};');
    const fixed = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /Architecture check passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
