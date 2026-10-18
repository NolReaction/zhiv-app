import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { previewSiteVisual, previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { interactiveMapObjects, mapObjectAt } = await vite.ssrLoadModule("/features/world/scene/site-interactions.ts");
const { constructionMapPlace, projectConstructionAnchor } = await vite.ssrLoadModule("/features/world/scene/construction-map-anchor.ts");
const { WorldConstructionStatus } = await vite.ssrLoadModule("/features/world/ui/hud/world-construction-status.tsx");
const { forestLightSources } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-lighting.ts");
const { economySceneConstruction } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const { forestConstructionJob } = await vite.ssrLoadModule("/features/world/state/economy/economy-construction-state.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const world = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-14T12:00:00Z");
const issue = (state, action, targetId, time) => applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "landmark-player", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0,
}, time, () => crypto.randomUUID());

for (const id of ["bridge", "lighthouse"]) {
  test(`${id} restoration selects its existing artwork only after the ordinary completion claim`, async () => {
    const building = economyCatalog.buildings.find(entry => entry.id === id);
    assert.ok(building, `${id} is a real economic building`);
    assert.deepEqual(building.levels.map(entry => entry.level), [1], "restoration does not invent higher artwork levels");
    const next = building.levels[0], beforeWorld = structuredClone(world);
    const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
    state.buildings.home = next.requiredHomeLevel;
    Object.assign(state.buildings, next.requiredBuildings);
    state.wallet.coins = next.cost.coins;
    state.inventory = { ...next.cost.items };
    const selected = () => accountSceneLevels(world, state.buildings.home, undefined, state.buildings);
    const site = world.sites.find(entry => entry.id === id);
    const image = () => previewSiteVisual(site, selected()).image;
    assert.equal(selected()[id], 0);
    assert.match(image(), new RegExp(`${id}-level-0\\.png`));
    issue(state, "start_construction", id, now);
    const job = state.jobs.find(entry => entry.kind === "construction" && entry.targetId === id);
    assert.ok(job); assert.equal(job.targetLevel, 1);
    assert.equal(state.wallet.coins, 0, "the normal command consumes the catalog price exactly once");
    assert.equal(state.buildings[id], 0);
    const deadline = Date.parse(job.finishesAt);
    assert.throws(() => issue(state, "claim_job", job.id, deadline - 1), { code: "ECONOMY_JOB_NOT_READY" });
    const construction = economySceneConstruction({ ...state, ownerPublicId: "landmark-player", revision: 1 }, true);
    assert.equal(forestConstructionJob(construction, deadline).stationId, id,
      "the ready job still belongs to the builder until claimed");
    assert.match(image(), new RegExp(`${id}-level-0\\.png`), "the timer cannot locally restore artwork");
    if (id === "lighthouse") assert.equal(forestLightSources(world, { levels: selected() })
      .some(light => light.id === "lighthouse-lens"), false, "the ruined lighthouse stays dark");
    issue(state, "claim_job", job.id, deadline);
    assert.equal(state.buildings[id], 1);
    assert.equal(selected()[id], 1);
    assert.match(image(), new RegExp(`${id}-level-1\\.png`));
    assert.ok((await stat(new URL(`../public${image().split("?")[0]}`, import.meta.url))).size > 0,
      "the restored image exists as a public asset for both builds");
    assert.equal(forestConstructionJob(economySceneConstruction({ ...state, ownerPublicId: "landmark-player", revision: 2 }, true), deadline), null);
    if (id === "lighthouse") {
      const light = forestLightSources(world, { levels: selected() }).find(light => light.id === "lighthouse-lens");
      assert.ok(light?.glass); assert.ok(light.beamLength > 0, "restoration enables the authored rotating beam");
    } else {
      const effective = previewWorldScene(world, selected());
      assert.equal(effective.terrain.some(entry => entry.id === "bridge-debris"), false);
      assert.equal(effective.navigation.obstacles.some(entry => entry.id === "bridge-debris-obstacle"), false);
      assert.equal(effective.navigation.obstacles.some(entry => entry.id === "bridge-far-railing-obstacle"), true);
    }
    assert.deepEqual(world, beforeWorld, "claim selection never rewrites authored geometry");
  });

  test(`${id} uses its own clickable contour and construction marker before and after restoration`, () => {
    for (const level of [0, 1]) {
      const levels = accountSceneLevels(world, 4, undefined, { [id]: level });
      const effective = previewWorldScene(world, levels), host = interactiveMapObjects(effective).find(entry => entry.id === id);
      const site = effective.sites.find(entry => entry.id === id);
      assert.equal(host.place, id); assert.equal(constructionMapPlace(id), id);
      assert.equal(host.hitArea, site.hitArea); assert.equal(host.anchor, site.anchor);
      assert.equal(mapObjectAt([host], site.hitArea[0]), host,
        "opening a landmark uses its artwork contour and requires no character arrival");
      const anchor = projectConstructionAnchor(host, { ...site.anchor, zoom: 1 }, { width: 600, height: 500 });
      assert.ok(anchor); assert.equal(anchor.objectId, id); assert.equal(anchor.place, id);
      const snapshot = { catalog: economyCatalog, buildings: { home: 4, [id]: level }, jobs: [{
        id: `restore-${id}`, kind: "construction", targetId: id, targetLevel: 1,
        startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 600_000).toISOString(),
      }] };
      const opened = [], economy = { snapshot, now: now + 300_000 };
      const button = WorldConstructionStatus({ economy, anchors: [anchor], onOpen: value => opened.push(value) });
      const markup = renderToStaticMarkup(button);
      assert.match(markup, new RegExp(`data-map-object="${id}"`));
      assert.match(markup, /<strong>5:00<\/strong>/);
      button.props.onClick(); assert.deepEqual(opened, [id]);
      assert.equal(snapshot.jobs.length, 1, "opening the timer does not claim or restart construction");
      economy.now = now + 600_000;
      assert.match(renderToStaticMarkup(WorldConstructionStatus({ economy, anchors: [anchor], onOpen() {} })), /data-ready="true"/);
      assert.equal(WorldConstructionStatus({ economy, anchors: [], onOpen() {} }), null);
    }
  });
}
