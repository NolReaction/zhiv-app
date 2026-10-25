import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const model = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { worldCatalog } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const { wardrobeItems, wardrobeOwned } = await vite.ssrLoadModule("/features/world/domain/wardrobe.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { itemIconIds } = await vite.ssrLoadModule("/features/items/item-icon.tsx");
const { pixelSprite, pixelSpriteContact } = await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts");
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement() {
  const pixels = new Map(), surface = { width: 48, height: 48, pixels };
  return Object.assign(surface, { getContext: () => ({ fillStyle: "", fillRect(x, y, width, height) {
    for (let row = Math.max(0, Math.floor(y)); row < Math.min(surface.height, Math.ceil(y + height)); row++)
      for (let column = Math.max(0, Math.floor(x)); column < Math.min(surface.width, Math.ceil(x + width)); column++)
        pixels.set(`${column}:${row}`, this.fillStyle);
  } }) });
} };
after(async () => {
  if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else delete globalThis.document;
  await vite.close();
});

test("neighbor's special clothes have visible art and remain outside all player ownership and reward catalogs", () => {
  const ids = model.neighborExclusiveWardrobeItems.map(item => item.id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(new Set(model.neighborExclusiveWardrobeItems.map(item => item.slot)), new Set(["palette", "head", "neck"]));
  for (const item of model.neighborExclusiveWardrobeItems) {
    assert.equal(model.neighborDefaultSettings.equipment[item.slot], item.id);
    assert.ok(model.neighborWardrobeItems.some(option => option.id === item.id));
    assert.ok(itemIconIds.includes(item.id), "an exclusive thing has its own illustration");
    assert.ok(!JSON.stringify(worldCatalog).includes(item.id), "not a player item, find, trip or collection reward");
    assert.ok(!JSON.stringify(economyCatalog).includes(item.id), "not a purchase, trade or order item");
    assert.ok(!wardrobeItems.some(option => option.id === item.id));
  }
  assert.deepEqual(wardrobeOwned(ids), wardrobeOwned(), "even accidental inventory IDs do not grant player wardrobe pieces");
});

test("neighbor wardrobe accepts correctly slotted personal clothes and preserves ordinary administrator choices", () => {
  assert.equal(model.neighborSettingsSchema.safeParse(model.neighborDefaultSettings).success, true);
  assert.equal(model.neighborEquipmentSchema.safeParse({ palette: "moss", head: "leaf_cap", neck: "amber_scarf", rod: null }).success, true);
  const defaults = model.neighborDefaultSettings.equipment;
  for (const equipment of [
    { ...defaults, head: defaults.neck }, { ...defaults, neck: defaults.head },
    { ...defaults, rod: defaults.head }, { ...defaults, palette: "berest_unknown" },
  ]) assert.equal(model.neighborEquipmentSchema.safeParse(equipment).success, false);
});

test("special hat and clasp follow native work poses without covering eyes or moving the ground contact", () => {
  const look = model.neighborDefaultSettings.equipment;
  for (const pose of ["idle", "walk", "greet", "carry", "reach", "hold", "crouch", "wonder", "stretch", "chew", "fish", "sleep", "drowsy"])
    for (const direction of ["front", "back", "left", "right"]) for (let frame = 0; frame < 4; frame++) {
      const bare = pixelSprite(pose, direction, frame, { ...look, head: null, neck: null });
      const dressed = pixelSprite(pose, direction, frame, look);
      if (pose === "sleep" || pose === "drowsy") assert.deepEqual(dressed.pixels, bare.pixels, "sleep retains the uncluttered curled silhouette");
      else assert.notDeepEqual([...dressed.pixels], [...bare.pixels], `${pose}/${direction} has a drawn outfit`);
      for (const [key, color] of bare.pixels) if (color === "#30291d")
        assert.equal(dressed.pixels.get(key), color, `${pose}/${direction}: eyes stay visible`);
      const soles = sprite => [...sprite.pixels].filter(([key]) => Number(key.split(":")[1]) >= 42).sort();
      assert.deepEqual(soles(dressed), soles(bare), `${pose}/${direction}: feet stay planted`);
      assert.deepEqual(pixelSpriteContact(dressed), pixelSpriteContact(bare), "clothes do not shift the contact shadow");
    }
  assert.equal(pixelSprite("idle", "front", 0, look), pixelSprite("idle", "front", 0, look), "the normal bounded sprite cache is reused");
});
