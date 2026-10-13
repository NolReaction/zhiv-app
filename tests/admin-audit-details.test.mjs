import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { adminActionName, adminActionDetails } = await vite.ssrLoadModule("/features/admin/admin-audit-details.ts");

test("audit renders visible grant amounts, catalog names and target levels", () => {
  const details = adminActionDetails(JSON.stringify({ request: { coins: 1000, pearls: 15,
    items: { wood: 3 }, buildings: { home: 2 }, productionSlots: {}, rods: [], hooks: [] } }));
  assert.match(details.replaceAll("\u00a0", " "), /\+1 000 монет/);
  assert.match(details, /\+15 жемчуга/);
  assert.match(details, /× 3/);
  assert.match(details, /→ ур\. 2/);
  assert.doesNotMatch(details, /requestId|undefined|NaN/);
  assert.equal(adminActionName("grant_economy"), "Выдача игроку");
});

test("promo audit preserves campaign identity and action for archived codes", () => {
  assert.equal(adminActionDetails(JSON.stringify({ request: { action: "delete", promoId: "gift-2026" }, version: 4 })), "gift-2026 · удалён");
  assert.equal(adminActionDetails(JSON.stringify({ request: { action: "update", promoId: "gift-2026",
    definition: { code: "AUTUMN", title: "Подарок", enabled: false } } })), "AUTUMN · Подарок · выключен");
});

test("old moderation history and malformed payloads stay readable", () => {
  assert.equal(adminActionDetails(JSON.stringify({ action: "set_tag", tag: { text: "Друг", color: "green" } })), "[Друг] · green");
  assert.equal(adminActionDetails(JSON.stringify({ action: "set_tag", tag: null })), "Тег снят");
  for (const value of ["broken", "null", "[]", "{}"])
    assert.equal(adminActionDetails(value), "Записано в журнал");
});
