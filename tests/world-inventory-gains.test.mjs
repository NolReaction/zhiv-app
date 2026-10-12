import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createInventoryGainPlayback, INVENTORY_GAIN_MS, INVENTORY_GAIN_QUEUE_LIMIT } = await vite.ssrLoadModule("/features/world/ui/feedback/inventory-gain-playback.ts");
const { WorldInventoryGains, InventoryGainContents } = await vite.ssrLoadModule("/features/world/ui/feedback/world-inventory-gains.tsx");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const gain = (id, ownerPublicId = owner) => ({ id, ownerPublicId, revision: 1, source: "claim", items: [{ itemId: "fish", quantity: 3 }] });
function playback(initial = [], initialOwner = owner) {
  const shown = [], hidden = [], cancelled = [], timers = [];
  const player = createInventoryGainPlayback(initialOwner, initial, {
    show(event) { shown.push(event); return true; }, hide(event) { hidden.push(event); },
    schedule(finish, milliseconds) { const timer = { finish, milliseconds }; timers.push(timer); return timer; },
    cancel(timer) { cancelled.push(timer); },
  });
  return { player, shown, hidden, cancelled, timers };
}

test("mounting/reopening skips historical gains, new receipts play once and unchanged renders keep their timer", () => {
  const old = gain("old"), fresh = gain("fresh"), { player, shown, hidden, timers } = playback([old]);
  player.receive(owner, [old], true); assert.deepEqual(shown, []);
  player.receive(owner, [old, fresh], true); assert.deepEqual(shown, [fresh]);
  for (let index = 0; index < 10; index++) player.receive(owner, [old, fresh], true);
  assert.equal(timers.length, 1); assert.equal(timers[0].milliseconds, INVENTORY_GAIN_MS);
  timers[0].finish(); assert.deepEqual(hidden, [fresh]);
  player.receive(owner, [old, fresh], true); assert.equal(shown.length, 1);
  const reopened = playback([old, fresh]); reopened.player.receive(owner, [old, fresh], true); assert.deepEqual(reopened.shown, []);
});

test("burst claims use a bounded queue and hidden pages discard rather than replay old loot", () => {
  const { player, shown, hidden, timers, cancelled } = playback();
  const first = gain("first"); player.receive(owner, [first], true);
  const burst = Array.from({ length: 10 }, (_, index) => gain(`burst-${index}`));
  player.receive(owner, [first, ...burst], true);
  assert.deepEqual(shown, [first]);
  timers[0].finish(); assert.equal(shown[1].id, burst.at(-INVENTORY_GAIN_QUEUE_LIMIT).id);
  player.receive(owner, [first, ...burst], false);
  assert.equal(hidden.at(-1).id, shown.at(-1).id); assert.equal(cancelled.length, 1);
  player.receive(owner, [first, ...burst], true); assert.equal(shown.length, 2);
  player.receive(owner, [gain("while-hidden")], false);
  player.receive(owner, [gain("while-hidden")], true); assert.equal(shown.length, 2);
});

test("account switches hide old cards, ignore foreign events and invalidate delayed cleanup callbacks", () => {
  const { player, shown, hidden, timers } = playback();
  player.receive(owner, [gain("first")], true);
  const staleCallback = timers[0].finish;
  player.receive(other, [gain("already-loaded", other)], true);
  assert.equal(hidden[0].id, "first");
  player.receive(other, [gain("foreign"), gain("new", other)], true);
  assert.equal(shown.at(-1).id, "new");
  staleCallback(); assert.equal(hidden.length, 1, "an old timer cannot hide another account's badge");
  player.clear(); assert.equal(hidden.at(-1).id, "new");
});

test("cards use the shared item drawings and exact positive quantities, with bounded rows and accessible overflow", () => {
  const event = { ...gain("claim"), items: [{ itemId: "fish", quantity: 3 }, { itemId: "wood", quantity: 2 },
    { itemId: "berries", quantity: 12 }, { itemId: "stone", quantity: 4 }] };
  const html = renderToStaticMarkup(createElement(InventoryGainContents, { event, state: { fishing: { catches: { fish: 3 } } },
    names: { fish: "Речная рыба", wood: "Древесина", berries: "Ягоды", stone: "Камень" } }));
  assert.match(html, /В кладовую/); assert.match(html, /data-item-icon="fish"/);
  assert.match(html, /data-inventory-item="fish" data-quantity="3"/); assert.match(html, /<strong>\+3<\/strong>/);
  assert.match(html, /Ещё предметов: 1/); assert.match(html, /Камень \+4/);
  assert.equal((html.match(/data-inventory-item=/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<button|tabindex|role="dialog"/);
  assert.equal(renderToStaticMarkup(createElement(WorldInventoryGains, {
    economy: { snapshot: { ownerPublicId: owner, catalog: { items: [] } }, inventoryGains: [event] },
  })), "", "SSR and first hydration cannot manufacture an animated old payout");
});

test("the fixed upper overlay clears modal stacks, never catches input and removes motion for accessibility", async () => {
  const [css, shop, hud, component, world] = await Promise.all([
    "../features/world/ui/feedback/world-inventory-gains.module.css", "../features/world/ui/characters/world-resident-dialog.module.css",
    "../features/world/world-map-hud.module.css", "../features/world/ui/feedback/world-inventory-gains.tsx", "../features/world/world-view.tsx",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  const overlayLevel = Number(css.match(/z-index:\s*(\d+)/)[1]);
  const interactiveLayers = [...shop.matchAll(/z-index:\s*(\d+)/g), ...hud.matchAll(/z-index:\s*(\d+)/g)].map(match => Number(match[1]));
  assert.match(css, /position: fixed/); assert.match(css, /safe-area-inset-top/);
  assert.match(css, /pointer-events: none/);
  assert.ok(interactiveLayers.every(level => overlayLevel > level), "claim/purchase feedback remains above the open expedition card, shop and its scrim");
  assert.match(component, /createPortal\([\s\S]*document\.body\)/, "the HUD's stacking context must not trap the receipt effect under an open menu");
  assert.match(world, /<WorldInventoryGains\s+key=\{ownerPublicId\}\s+economy=\{economy\}\s+hud=\{topHud\}\s*\/>/);
  assert.match(css, /\.effect\[hidden\] \{ display: none; \}/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none[\s\S]*\.glints \{ display: none/);
});


test("purchase feedback shows owned fish art without requiring a personal catch", () => {
  const event = { ...gain("bought"), source: "purchase" };
  const props = { event, names: { fish: "Речная рыба", fish_shark: "Теневая акула" }, state: { fishing: { catches: {} }, inventory: { fish: 1, fish_shark: 1 } } };
  const material = renderToStaticMarkup(createElement(InventoryGainContents, props));
  assert.match(material, /data-item-icon="fish"/); assert.doesNotMatch(material, /data-hidden-fish/);
  event.items = [{ itemId: "fish_shark", quantity: 1 }];
  const purchased = renderToStaticMarkup(createElement(InventoryGainContents, props));
  assert.match(purchased, /data-item-icon="fish_shark"/); assert.doesNotMatch(purchased, /data-hidden-fish/);
  assert.deepEqual(props.state.fishing.catches, {});
  props.state.fishing.catches.fish_shark = 1;
  const caught = renderToStaticMarkup(createElement(InventoryGainContents, props));
  assert.match(caught, /data-item-icon="fish_shark"/); assert.doesNotMatch(caught, /data-hidden-fish/);
});
