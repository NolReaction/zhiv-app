import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { NeighborIntroduction, WorkshopConstructionContents, WorkshopTutorialConstruction } =
  await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding-cards.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { WORLD_CHARACTERS } = await vite.ssrLoadModule("/features/world/characters/world-characters-model.ts");
after(() => vite.close());
const controller = () => {
  const calls = [];
  return { calls, busy: false, uncertain: false, retryAt: 0, now: 1000,
    snapshot: { catalog: structuredClone(economyCatalog), buildings: { home: 1, quarry: 0, workshop: 0 },
      jobs: [], inventory: {}, wallet: { coins: 0, pearls: 0 }, workshopStarterClaimed: false },
    act(...args) { calls.push(args); },
  };
};

test("the introduction names every resident and explains later arrivals without advertising them as already available", () => {
  const economy = controller();
  const html = renderToStaticMarkup(NeighborIntroduction({ economy }));
  for (const character of WORLD_CHARACTERS) {
    assert.ok(html.includes(`data-guide-neighbor="${character.id}"`));
    assert.ok(html.includes(character.name));
  }
  assert.match(html, /Камнешмыг.*придёт после постройки каменоломни/);
  assert.match(html, /Листохвост.*вернётся на лодке.*3-го уровня/);
  assert.doesNotMatch(html, /<button/);
  economy.snapshot.buildings = { home: 3, quarry: 1, workshop: 0 };
  const later = renderToStaticMarkup(NeighborIntroduction({ economy }));
  assert.match(later, /приходит к построенной каменоломне/);
  assert.match(later, /прибывает на лодке/);
  assert.doesNotMatch(later, /все.*доступны/);
});

test("a spent starting inventory still shows the real earmarked quote and starts only on an explicit click", () => {
  const economy = controller();
  const cost = economy.snapshot.catalog.buildings.find(item => item.id === "workshop").levels.find(item => item.level === 1).cost;
  const html = renderToStaticMarkup(WorkshopConstructionContents({ economy }));
  assert.match(html, /Учебный набор Шишколапа/);
  assert.ok(html.includes(`${cost.coins} монет`));
  for (const amount of Object.values(cost.items)) assert.ok(html.includes(`: ${amount}`));
  assert.match(html, /прямо в стройку/);
  const button = WorkshopTutorialConstruction({ economy, isOnline: true });
  assert.equal(button.props.disabled, false);
  assert.deepEqual(economy.calls, []);
  button.props.onClick();
  assert.deepEqual(economy.calls, [["start_tutorial_workshop", "workshop"]]);
  assert.deepEqual(economy.snapshot.inventory, {});
  assert.equal(economy.snapshot.wallet.coins, 0);
});

test("offline, uncertain, pending, cooldown and another build cannot dispatch the tutorial construction", () => {
  for (const patch of [{ isOnline: false }, { busy: true }, { uncertain: true }, { retryAt: 2000 },
    { snapshot: { jobs: [{ kind: "construction", targetId: "woodlot" }] } }]) {
    const economy = controller();
    const { isOnline = true, snapshot, ...rest } = patch;
    Object.assign(economy, rest);
    if (snapshot) Object.assign(economy.snapshot, snapshot);
    const button = WorkshopTutorialConstruction({ economy, isOnline });
    assert.equal(button.props.disabled, true);
    button.props.onClick();
    assert.deepEqual(economy.calls, []);
  }
});

test("already used, started or built workshops cannot offer another tutorial kit", () => {
  for (const patch of [{ workshopStarterClaimed: true }, { buildings: { workshop: 1 } },
    { jobs: [{ kind: "construction", targetId: "workshop" }] }]) {
    const economy = controller();
    Object.assign(economy.snapshot, patch);
    assert.equal(WorkshopTutorialConstruction({ economy, isOnline: true }), null);
    assert.deepEqual(economy.calls, []);
  }
});
