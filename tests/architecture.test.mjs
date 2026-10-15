import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectArchitecture, moduleReferences } from "../scripts/lib/architecture.mjs";

const inspect = entries => inspectArchitecture(new Map(Object.entries(entries)));

test("audio core stays independent from world state and browser-free rules stay pure", () => {
  for (const target of ["features/world/state/forest.ts", "features/economy/sync/session.ts", "features/app/composition.ts"]) {
    const findings = inspect({
      "features/audio/runtime/mixer.ts": 'import "@/' + target.slice(0, -3) + '";',
      [target]: "export {};",
    });
    assert.equal(findings[0].rule, "audio-dependency");
  }
  const findings = inspect({
    "features/audio/domain/mix.ts": 'import "../runtime/mixer";',
    "features/audio/runtime/mixer.ts": "export {};",
  });
  assert.equal(findings[0].rule, "domain-dependency");
  assert.deepEqual(inspect({
    "features/world/audio/adapter.ts": 'import "@/features/audio/runtime/mixer";',
    "features/audio/runtime/mixer.ts": 'import "../domain/mix";',
    "features/audio/domain/mix.ts": "export {};",
  }), []);
});

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

test("engine core, editor, examples and product hosts preserve independent dependency direction", () => {
  assert.deepEqual(inspect({
    "app/engine/page.tsx": 'export { Editor as default } from "@/apps/engine/src/editor";',
    "features/app/engine-route.tsx": 'export const load = () => import("@/apps/engine/src/editor");',
    "apps/engine/src/editor/index.tsx": 'import { useState } from "react"; import type { Root } from "react-dom/client"; import { Leaf } from "lucide-react"; import { scene } from "../../examples/forest"; import type { Scene } from "@/packages/engine/src/index"; export const Editor = useState;',
    "apps/engine/examples/forest.ts": 'import type { Scene } from "@/packages/engine/src/index"; export const scene: Scene = {};',
    "examples/minimal/main.ts": 'import type { Scene } from "@/packages/engine/src/index"; export const scene: Scene = {};',
    "packages/engine/src/index.ts": 'export type { Scene } from "./scene/model.js"; export { render } from "./rendering/index.js";',
    "packages/engine/src/scene/model.ts": 'export type Scene = {};',
    "packages/engine/src/rendering/index.ts": 'import type { Scene } from "../scene/model.js"; export const render = (scene: Scene) => scene;',
  }), []);
});

test("engine core rejects UI, editor, examples and product dependencies including erased types", () => {
  const localTargets = ["apps/engine/src/editor.ts", "apps/engine/examples/forest.ts", "examples/minimal.ts",
    "features/world/types.ts", "app/page.tsx", "lib/session.ts", "components/panel.tsx"];
  for (const target of localTargets) {
    for (const statement of [
      `import type { Value } from "@/${target.replace(/\.[^.]+$/, "")}";`,
      `export type { Value } from "@/${target.replace(/\.[^.]+$/, "")}";`,
      `export type Value = import("@/${target.replace(/\.[^.]+$/, "")}");`,
    ]) {
      const findings = inspect({ "packages/engine/src/scene/model.ts": statement, [target]: "export type Value = {};" });
      assert.ok(findings.some(item => item.rule === "engine-core-dependency"), statement);
    }
  }
  for (const statement of ['import type { ReactNode } from "react";', 'export type { Root } from "react-dom/client";',
    'type Router = import("next/navigation");', 'export { Leaf } from "lucide-react";', 'import "@radix-ui/react-dialog";']) {
    const findings = inspect({ "packages/engine/src/scene/model.ts": statement });
    assert.equal(findings[0].rule, "engine-core-dependency", statement);
  }
  assert.equal(inspect({ "packages/engine/src/types.d.ts": 'import type { ReactNode } from "react";' })[0].rule, "engine-core-dependency");
  assert.equal(inspect({ "packages/engine/src/view.tsx": "export const View = () => <div />;" })[0].rule, "engine-core-dependency", "automatic JSX imports cannot bypass the framework boundary");
});

test("engine relative source references are portable while product aliases are rejected inside core", () => {
  const entries = { "packages/engine/src/index.ts": 'import type { Scene } from "@/packages/engine/src/scene/model";',
    "packages/engine/src/scene/model.ts": "export type Scene = {};" };
  assert.equal(inspect(entries)[0].rule, "engine-core-portability");
  entries["packages/engine/src/index.ts"] = 'import type { Scene } from "./scene/model.js"; import "./math.mjs";';
  entries["packages/engine/src/math.mts"] = "export {};";
  assert.deepEqual(inspect(entries), []);
});

test("engine editor permits only its app, core, own examples and declared UI packages", () => {
  for (const target of ["features/world/state.ts", "lib/session.ts", "components/panel.tsx", "app/page.tsx", "examples/other.ts", "apps/other/src/index.ts"]) {
    const findings = inspect({ "apps/engine/src/editor/controller.ts": `import type { Value } from "@/${target.replace(/\.[^.]+$/, "")}";`,
      [target]: "export type Value = {};" });
    assert.ok(findings.some(item => item.rule === "engine-editor-dependency"), target);
  }
  for (const statement of ['import type { LinkProps } from "next/link";', 'import "next/navigation";', 'import { z } from "zod";']) {
    assert.equal(inspect({ "apps/engine/src/editor/ui/panel.tsx": statement })[0].rule, "engine-editor-dependency", statement);
  }
});

test("examples consume core without depending on product or editor types", () => {
  for (const example of ["apps/engine/examples/forest.ts", "examples/minimal/scene.ts"]) {
    for (const target of ["features/world/state.ts", "lib/session.ts", "apps/engine/src/editor/controller.ts"]) {
      const findings = inspect({ [example]: `import type { Value } from "@/${target.replace(/\.[^.]+$/, "")}";`,
        [target]: "export type Value = {};" });
      assert.ok(findings.some(item => item.rule === "engine-example-dependency"), `${example}: ${target}`);
    }
  }
});

test("runtime cycles include core, editor, examples and product hosts while type cycles stay erased", () => {
  const findings = inspect({
    "packages/engine/src/a.ts": 'export const load = () => import("./b.js");',
    "packages/engine/src/b.ts": 'export * from "./a.js";',
    "apps/engine/src/a.ts": 'import "../examples/forest";',
    "apps/engine/examples/forest.ts": 'import "../src/a";',
    "app/engine/page.tsx": 'import "@/apps/engine/src/host";',
    "apps/engine/src/host.ts": 'import "@/app/engine/page";',
    "packages/engine/src/types-a.ts": 'import type { B } from "./types-b.js"; export type A = B;',
    "packages/engine/src/types-b.ts": 'import type { A } from "./types-a.js"; export type B = A;',
  });
  const cycles = findings.filter(item => item.rule === "engine-cycle");
  assert.equal(cycles.length, 3);
  assert.ok(cycles.some(item => item.message.includes("packages/engine/src/a.ts")));
  assert.ok(cycles.some(item => item.message.includes("apps/engine/examples/forest.ts")));
  assert.ok(cycles.some(item => item.message.includes("app/engine/page.tsx")));
  assert.equal(findings.some(item => item.file.includes("types-")), false);
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

test("CLI scans engine and example sources but ignores generated output and the server API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhiv-engine-architecture-"));
  const script = fileURLToPath(new URL("../scripts/check-architecture.mjs", import.meta.url));
  try {
    const files = {
      "packages/engine/src/model.ts": 'import type { ReactNode } from "react";',
      "apps/engine/src/editor.ts": 'import type { Game } from "@/features/missing";',
      "apps/engine/examples/forest.ts": 'import "@/lib/missing";',
      "examples/minimal/main.ts": 'import "@/features/missing";',
      "apps/api/src/main/problem.ts": 'import "@/features/missing";',
      "packages/engine/dist/problem.js": 'import "@/features/missing";',
      "apps/engine/src/dist/problem.js": 'import "@/features/missing";',
      "examples/minimal/node_modules/problem.js": 'import "@/features/missing";',
    };
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    const broken = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(broken.status, 1);
    for (const file of Object.keys(files).slice(0, 4)) assert.ok(broken.stderr.includes(`${file}:`), file);
    for (const file of Object.keys(files).slice(4)) assert.equal(broken.stderr.includes(`${file}:`), false, file);
    for (const file of Object.keys(files).slice(0, 4)) await writeFile(path.join(root, file), "export {};");
    const fixed = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /Architecture check passed: 4 modules/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
