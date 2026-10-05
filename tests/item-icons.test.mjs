import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ItemIcon, CollectionIcon, itemIconIds, collectionIconIds } = await vite.ssrLoadModule("/features/items/item-icon.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { worldCatalog } = await vite.ssrLoadModule("/features/world/model.ts");
const { quarryCollectionFinds } = await vite.ssrLoadModule("/features/world/collection-book.ts");
const { WorldCollections } = await vite.ssrLoadModule("/features/world/world-collections.tsx");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("every economic item, currency and wardrobe item has artwork", () => {
  const expected = [...economyCatalog.items.map(item => item.id), ...worldCatalog.items.map(item => item.id), "coins", "pearls"];
  assert.deepEqual([...itemIconIds].sort(), expected.sort());
  assert.equal(new Set(itemIconIds).size, itemIconIds.length);
});

test("collection finds each have their own illustration despite shared legacy symbols", () => {
  assert.deepEqual([...collectionIconIds].sort(), [...worldCatalog.finds, ...quarryCollectionFinds].map(find => find.id).sort());
  const drawings = [...worldCatalog.finds, ...quarryCollectionFinds].map(find => render(CollectionIcon, { findId: find.id }).replace(/data-collection-icon="[^"]+"/, ""));
  assert.equal(new Set(drawings).size, worldCatalog.finds.length + quarryCollectionFinds.length);
});

test("repeated icons need no external asset or shared SVG ids at compact and large sizes", () => {
  for (const size of [16, 24, 48, 76]) {
    for (const id of itemIconIds) {
      const html = render(ItemIcon, { itemId: id, size });
      assert.match(html, new RegExp(`width="${size}" height="${size}"`));
      assert.match(html, /viewBox="0 0 48 48"/);
      assert.match(html, /aria-hidden="true"/);
      assert.doesNotMatch(html, /\bid="|<image|<use|<foreignObject|url\(|(?:href|src)=/);
    }
  }
});

test("standalone labels are accessible and unknown ids have a safe fallback", () => {
  const named = render(ItemIcon, { itemId: "stone", label: "Камень" });
  assert.match(named, /role="img" aria-label="Камень"/);
  assert.doesNotMatch(named, /aria-hidden/);
  for (const itemId of ["unknown", "constructor", "__proto__"]) assert.match(render(ItemIcon, { itemId }), /<path/);
  assert.match(render(CollectionIcon, { findId: "constructor", label: "Находка" }), /role="img" aria-label="Находка"/);
});

test("book keeps illustrated forest finds and saved ownership without the retired album", () => {
  const state = { collection: ["acorn", "old_float"], inventory: ["explorer_cap"], completedJourneys: 7 };
  const html = render(WorldCollections, { state, gifts: [] });
  assert.equal((html.match(/data-collection-icon=/g) ?? []).length, 6);
  assert.equal((html.match(/data-owned="true"/g) ?? []).length, 1);
  assert.match(html, /Книга коллекций/);
  assert.match(html, /Путешествия/); assert.match(html, /Рыбалка/); assert.match(html, /Каменоломня/);
  assert.match(html, /Полученную раньше одежду можно надеть/);
  assert.doesNotMatch(html, /Лесной альбом|В альбоме/);
  for (const find of worldCatalog.finds.filter(find => find.group === "forest")) assert.ok(html.includes(find.name));
});
