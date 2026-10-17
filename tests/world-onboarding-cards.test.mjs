import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { NeighborIntroduction, WorkshopConstructionContents, WorkshopTutorialConstruction, tutorialWorkshopAction } =
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

test("the optional detailed introduction shows only met residents and requires their actual arrival state", () => {
  const economy = controller();
  const html = renderToStaticMarkup(NeighborIntroduction({ economy }));
  for (const character of WORLD_CHARACTERS.filter(character => ["builder", "plesk", "lopukh"].includes(character.id))) {
    assert.ok(html.includes(`data-guide-neighbor="${character.id}"`));
    assert.ok(html.includes(character.name));
  }
  assert.doesNotMatch(html, /Камнешмыг|Листохвост|data-guide-neighbor="kamneshmyg"|data-guide-neighbor="leaftail"|лодк|3-го/);
  assert.doesNotMatch(html, /<button/);
  economy.snapshot.buildings = { home: 3, quarry: 1, workshop: 0 };
  const beforeArrival = renderToStaticMarkup(NeighborIntroduction({ economy }));
  assert.doesNotMatch(beforeArrival, /Камнешмыг|Листохвост/, "a house level alone does not reveal a resident who has not arrived");
  const quarry = renderToStaticMarkup(NeighborIntroduction({ economy, quarryBuilt: true }));
  assert.match(quarry, /Камнешмыг.*шахтёр, работает в каменоломне/);
  assert.doesNotMatch(quarry, /Листохвост/);
  const later = renderToStaticMarkup(NeighborIntroduction({ economy, quarryBuilt: true, leaftailAvailable: true }));
  for (const character of WORLD_CHARACTERS) {
    assert.ok(later.includes(`data-guide-neighbor="${character.id}"`));
    assert.ok(later.includes(character.name));
  }
  assert.equal(NeighborIntroduction({ economy: { ...economy, snapshot: null } }), null);
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
  const action = tutorialWorkshopAction(economy, true);
  assert.equal(action.label, "Построить с учебным набором");
  assert.equal(action.disabled, button.props.disabled, "the footer and retained standalone button share their actual dispatch guard");
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
    const action = tutorialWorkshopAction(economy, isOnline);
    assert.equal(button.props.disabled, true);
    assert.equal(action.disabled, true);
    button.props.onClick();
    action.onClick();
    assert.deepEqual(economy.calls, []);
  }
});

test("already used, started or built workshops cannot offer another tutorial kit", () => {
  for (const patch of [{ workshopStarterClaimed: true }, { buildings: { workshop: 1 } },
    { jobs: [{ kind: "construction", targetId: "workshop" }] }]) {
    const economy = controller();
    Object.assign(economy.snapshot, patch);
    assert.equal(WorkshopTutorialConstruction({ economy, isOnline: true }), null);
    assert.equal(tutorialWorkshopAction(economy, true), undefined);
    assert.deepEqual(economy.calls, []);
  }
});

test("accepted construction and a completed workshop remove the teaching cost quote", () => {
  for (const patch of [{ buildings: { workshop: 1 } }, { jobs: [{ id: "paid-workshop", kind: "construction", targetId: "workshop" }] }]) {
    const economy = controller();
    Object.assign(economy.snapshot, patch);
    const before = structuredClone(economy.snapshot);
    assert.equal(WorkshopConstructionContents({ economy }), null);
    assert.deepEqual(economy.snapshot, before);
    assert.deepEqual(economy.calls, []);
  }
  assert.equal(WorkshopConstructionContents({ economy: { ...controller(), snapshot: null } }), null);
  const spent = controller(); spent.snapshot.workshopStarterClaimed = true;
  assert.match(renderToStaticMarkup(WorkshopConstructionContents({ economy: spent })), /Стоимость первой мастерской/,
    "a cancelled or old kit keeps the honest ordinary cost until real work starts");
});
