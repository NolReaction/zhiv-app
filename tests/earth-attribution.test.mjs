import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthAttribution } = await vite.ssrLoadModule("/features/earth/earth-attribution.tsx");

test("map data credits show each required source once with its canonical link", () => {
  const tree = EarthAttribution();
  const links = Children.toArray(tree.props.children).filter(child => child.type === "a");
  assert.deepEqual(links.map(link => [link.props.children, link.props.href]), [
    ["© OpenStreetMap", "https://www.openstreetmap.org/copyright"],
    ["OpenMapTiles", "https://openmaptiles.org/"],
  ]);
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/>© OpenStreetMap</g) || []).length, 1);
  assert.equal((html.match(/>OpenMapTiles</g) || []).length, 1);
  assert.doesNotMatch(html, /<button|<summary|<details|aria-hidden="true"[^>]*>©/);
});

test("source links remain standard keyboard links and isolate their external tabs", () => {
  for (const child of Children.toArray(EarthAttribution().props.children)) {
    if (child.type !== "a") continue;
    assert.equal(child.props.target, "_blank");
    assert.match(child.props.rel, /\bnoopener\b/);
    assert.match(child.props.rel, /\bnoreferrer\b/);
    assert.equal(child.props.tabIndex, undefined);
    assert.equal(child.props["aria-hidden"], undefined);
  }
});
