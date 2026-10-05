import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { BranchPage } = await vite.ssrLoadModule("/features/progression/branch-page.tsx");
const { progressionGraph: graph } = await vite.ssrLoadModule("/features/progression/graph.ts");
const html = renderToStaticMarkup(createElement(BranchPage));

test("branch renders every location, level, recipe and exploration as an accessible selectable graph node", () => {
  const buttons = Array.from(html.matchAll(/<button\b([^>]*)data-node-id="([^"]+)"([^>]*)>/g));
  assert.equal(buttons.length, graph.nodes.length);
  const byId = new Map(buttons.map(match => [match[2], match[1] + match[3]]));
  assert.equal(byId.size, graph.nodes.length);
  for (const node of graph.nodes) {
    const attributes = byId.get(node.id);
    assert(attributes, node.id);
    assert.match(attributes, /aria-pressed="(?:true|false)"/);
    assert.match(attributes, /aria-label="[^"]+"/);
    assert.match(attributes, new RegExp(`data-kind="${node.kind}"`));
    assert.match(attributes, new RegExp(`data-status="${node.status}"`));
  }
  assert.equal(buttons.filter(match => (match[1] + match[3]).includes('data-kind="location"')).length, 6);
  assert(!/\b(?:NaN|Infinity|undefined)\b/.test(html), "Positions, connections and requirement labels must stay finite");
  assert.match(html, /Дом 2 · шахта, печь и рынок/);
});

test("branch opens the free start while keeping places, equipment and future work distinct", () => {
  assert.match(html, /data-node-id="place:workshop"[^>]*data-kind="location"/);
  assert.match(html, /data-node-id="b:workshop:1"[^>]*data-kind="building"/);
  assert.match(html, /data-node-id="b:kiln:1"[^>]*data-kind="building"/);
  const detail = html.slice(html.indexOf("<aside"));
  assert.match(detail, />Начало</);
  assert.match(detail, /бесплатную лесную разведку/);
  assert.match(detail, /Тапы не дают хозяйственную валюту/);
  assert.match(html, /data-node-id="start"[^>]*aria-pressed="true"/);
  assert.match(html, /Схема правил и возможностей/);
  assert.match(html, /data-node-id="public_profiles"[^>]*data-status="active"/);
  assert.match(html, /data-node-id="friend_glade"[^>]*data-status="plan"/);
  assert.match(html, /data-node-id="pleska_home"[^>]*data-status="plan"/);
  assert.match(html, /Внутри места/);
  assert.match(html, /data-node-id="mine_interior"[^>]*data-status="plan"/);
});

test("branch renders the rare acquisition node as a selectable active source rather than guaranteed production", () => {
  const rareButton = html.match(/<button\b[^>]*data-node-id="rare_materials"[\s\S]*?<\/button>/)?.[0];
  assert(rareButton);
  assert.match(rareButton, /data-kind="acquisition"/);
  assert.match(rareButton, /data-status="active"/);
  assert.match(rareButton, /aria-label="Реликвии исследований"/);
  assert.match(rareButton, /Реликвии исследований/);
  assert.doesNotMatch(rareButton, /data-kind="(?:recipe|market)"/);
});
