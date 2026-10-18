import assert from "node:assert/strict";
import test from "node:test";
import { browser, fixture, modules, options, quietClearing } from "./helpers/new-map-scene.mjs";

const foot = { x: 630, y: 660 };
const parked = { x: 615, y: 640 };
const motion = (point = foot, direction = "front") => ({ ...point, pose: "idle", frame: 0, direction, opacity: 1 });
function life(phase, elapsed = 2) {
  return { mushrooms: [], campfires: [], routine: null,
    garden: { elapsed: 0, bushes: [], routine: phase ? { kind: "harvest-berries", bushId: "", phase,
      elapsed, totalElapsed: elapsed, carryingBasket: ["collect", "return-basket", "deposit"].includes(phase) } : null,
    basket: { position: { ...parked }, approach: { x: 596, y: 640 }, homePosition: { ...parked },
      homeApproach: { x: 596, y: 640 }, size: 14, berries: 3, capacity: 12 }, basketCorridors: [] } };
}
function residents(y) {
  return [
    { id: "plesk", x: 620, y: y + 8, size: 36, action: "idle", direction: "front", frame: 0, phase: 0,
      destinationId: "depth-front", carryingFish: false },
    { id: "builder", x: 610, y: y - 8, size: 40, action: "idle", direction: "front", frame: 0, phase: 0 },
  ];
}
const imageAt = (calls, x, size) => calls.map((call, index) => call.method === "drawImage"
  && call.args.length === 5 && call.args[0]?.width === 48 && call.args[0]?.height === 48
  && Math.abs(call.args[1] - (x - size / 2)) < 1e-7 && Math.abs(call.args[3] - size) < 1e-7 ? index : -1).filter(index => index >= 0);
const translations = (calls, point) => calls.map((call, index) => call.method === "translate"
  && Math.abs(call.args[0] - point.x) < 1e-7 && Math.abs(call.args[1] - point.y) < 1e-7 ? index : -1).filter(index => index >= 0);
const gardenBodies = calls => calls.filter(call => call.method === "fillRect" && JSON.stringify(call.args) === "[-7,-8,14,7]");
const supplyRims = calls => calls.filter(call => call.method === "fillRect" && JSON.stringify(call.args) === "[-9,-11,18,2]");

async function harness(run) {
  const loaded = await modules({ occluders: [], effectAnchors: [], treeInteractions: [] }), env = browser();
  try {
    const paint = ({ hero = foot, still = false, view = "circle", direction = "front", state = {}, ...preview }) => {
      const surface = env.surface();
      loaded.paintNewMap(surface.context, new Map(), { ...options, view, reducedMotion: still }, 20, false, 0, 0, {
        scene: fixture, state: { ...loaded.worldDevStore.getSnapshot(), ...quietClearing,
          reducedMotion: still ? "on" : "off", direction, ...state }, clearing: motion(hero, direction), ...preview,
      });
      return surface.calls;
    };
    await run(loaded, paint);
  } finally { loaded.worldDevStore.reset(); env.restore(); }
}

function depthOrder(calls, support, hero, actorSize, label) {
  const builder = imageAt(calls, 610, 40), plesk = imageAt(calls, 620, 36), body = imageAt(calls, hero.x, actorSize);
  const basket = translations(calls, support);
  assert.equal(builder.length, 1, `${label}: rear resident paints once`);
  assert.equal(plesk.length, 1, `${label}: front resident paints once`);
  assert.equal(body.length, 1, `${label}: owner paints once`);
  assert.equal(basket.length, 1, `${label}: one basket at its actual support`);
  assert.ok(builder[0] < basket[0] && basket[0] < plesk[0], `${label}: rear resident → basket → front resident`);
  if (support.y < hero.y) assert.ok(plesk[0] < body[0], `${label}: rear prop/residents remain behind the owner`);
  else assert.ok(body[0] < builder[0], `${label}: front prop/residents remain in front of the owner`);
}

test("paintNewMap interleaves a parked basket with real residents on either side of the hero split", async () => harness(async (loaded, paint) => {
  const state = life(), before = JSON.stringify(state);
  for (const heroY of [620, 660]) for (const still of [false, true]) for (const view of ["circle", "world"]) {
    const hero = { x: 630, y: heroY }, label = `${view}/${still}/${heroY}`;
    const calls = paint({ hero, still, view, life: state, residents: residents(parked.y) });
    assert.equal(gardenBodies(calls).length, 1, `${label}: parked basket is neither omitted nor doubled`);
    depthOrder(calls, parked, hero, loaded.NEW_MAP_PET_SIZE, label);
    assert.equal(JSON.stringify(state), before, "rendering retains the session's parked point and contents");
  }
}));

test("active take, collect and deposit baskets use their actual ground support exactly once", async () => harness(async (loaded, paint) => {
  const size = loaded.NEW_MAP_PET_SIZE;
  for (const [phase, elapsed, support] of [["take-basket", .1, parked],
    ["collect", 2, { x: foot.x - size * .31, y: foot.y + size * .035 }], ["deposit", 1.3, parked]]) {
    const state = life(phase, elapsed), before = JSON.stringify(state);
    // A collect basket is just in front of its owner; put both residents on
    // that same front layer so their feet still straddle the real support.
    const frames = phase === "collect" ? residents(support.y).map(frame => ({ ...frame,
      y: frame.id === "builder" ? support.y - .5 : support.y + .5 })) : residents(support.y);
    for (const still of [false, true]) {
      const calls = paint({ still, life: state, residents: frames });
      assert.equal(gardenBodies(calls).length, 1, `${phase}/${still}: deferred ground has exactly one paint`);
      const behind = imageAt(calls, 610, 40)[0], front = imageAt(calls, 620, 36)[0], basket = translations(calls, support);
      assert.equal(basket.length, 1, `${phase}: draw uses the actual visual support`);
      assert.ok(behind < basket[0] && basket[0] < front, `${phase}: active prop obeys each resident's feet`);
      if (phase === "collect") assert.equal(translations(calls, parked).length, 0, "the old home marker never paints a duplicate basket");
    }
    assert.equal(JSON.stringify(state), before, "reduced-motion and repeated camera paints never advance a gesture");
  }
}));

test("carried berry baskets stay in their owner's hand pass without duplicate ground entries", async () => harness(async (loaded, paint) => {
  for (const direction of ["front", "back"]) for (const still of [false, true]) {
    const state = life("return-basket"), calls = paint({ still, direction, life: state, residents: residents(parked.y) });
    assert.equal(gardenBodies(calls).length, 1);
    assert.equal(translations(calls, parked).length, 0, "the stale parked marker is absent during carry");
    const basket = translations(calls, { x: foot.x, y: foot.y - loaded.NEW_MAP_PET_SIZE * .15 });
    assert.equal(basket.length, 1);
    const owner = imageAt(calls, foot.x, loaded.NEW_MAP_PET_SIZE)[0];
    assert.equal(basket[0] < owner, direction === "back", "the carried basket follows its owner's facing");
  }
}));

function gathering(held = false) {
  return { ...foot, size: 36, action: "look", progress: 0, crouch: 0, lean: 0, direction: "front", hand: { x: .2, y: -.3 },
    item: "twig", itemVisible: false, pose: "idle", frame: 0, held, filled: true,
    basket: { x: 645, y: foot.y, size: 16 } };
}

test("supply baskets share feet depth and held supply baskets remain a single owner prop", async () => harness(async (loaded, paint) => {
  for (const [held, heroY] of [[false, 640], [false, 680], [true, 640]]) {
    const supply = gathering(held); supply.y = heroY; supply.basket.y = held ? heroY - 8 : 660;
    const hero = { x: supply.x, y: supply.y }, calls = paint({ hero, gathering: supply, residents: residents(supply.basket.y) });
    assert.equal(supplyRims(calls).length, 1, "supply basket paints once across actor/ground passes");
    if (!held) depthOrder(calls, supply.basket, hero, loaded.NEW_MAP_PET_SIZE, `supply/${heroY}`);
    else {
      const basket = translations(calls, supply.basket)[0], owner = imageAt(calls, hero.x, loaded.NEW_MAP_PET_SIZE)[0];
      assert.ok(basket > owner, "a forward held supply basket stays with the owner's paws");
    }
  }
}));

test("DEV heroScale scales the supply owner, basket size and relative offsets together without mutating the frame", async () => harness(async (loaded, paint) => {
  assert.equal(loaded.NEW_MAP_PET_SIZE, 36, "the integration fixture starts with a 36-unit hero");
  for (const held of [false, true]) {
    const supply = gathering(held); supply.basket.y = held ? 652 : 672;
    const before = JSON.stringify(supply), support = { x: 652.5, y: held ? 648 : 678 };
    const calls = paint({ gathering: supply, residents: residents(support.y), state: { heroScale: 1.5 } });
    const owner = imageAt(calls, foot.x, 54), basket = translations(calls, support);
    assert.equal(owner.length, 1, "the actual owner body is 54 units wide");
    assert.equal(supplyRims(calls).length, 1, "scaled supply basket remains a single prop");
    assert.equal(basket.length, 1, "relative basket offsets are scaled by 1.5");
    assert.deepEqual(calls[basket[0] + 1], { method: "scale", args: [24 / 20, 24 / 20] },
      "the actual basket painter receives a 24-unit basket");
    assert.equal(translations(calls, supply.basket).length, 0, "the unscaled prop is never painted again");
    if (!held) depthOrder(calls, support, foot, 54, "scaled supply ground");
    else assert.ok(owner[0] < basket[0], "a held scaled basket stays in the forward hand pass");
    assert.equal(JSON.stringify(supply), before, "render scaling leaves the source frame untouched");
  }
}));
