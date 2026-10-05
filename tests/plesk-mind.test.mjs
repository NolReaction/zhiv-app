import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createPleskMind, advancePleskMind, pleskMindFrame, noticePleskMind, PLESK_MIND_LIMITS } = await vite.ssrLoadModule("/features/world/plesk-mind.ts");
const { pleskLocalPlaces, PLESK } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { createWorldNavigation, isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD: world } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { FISHING_PACK_RELEASE, fishingCatchFrame } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
const day = { rain: 0, dusk: 0, playerNear: false };
const advance = (mind, seconds, env = day, step = .1, scene = world) => {
  for (let time = 0; time < seconds - 1e-8; time += step) advancePleskMind(mind, scene, Math.min(step, seconds - time), env);
};
function until(mind, predicate, seconds = 180, env = day) {
  for (let time = 0; time < seconds; time += .1) {
    if (predicate(mind)) return;
    advancePleskMind(mind, world, .1, env);
  }
  assert.fail(`condition not reached: ${JSON.stringify(mind.observation)}`);
}

test("the live resident chooses occupations from needs, stock and weather rather than replaying a timed tour", () => {
  const ready = createPleskMind(world, 9), tired = createPleskMind(world, 9), rain = createPleskMind(world, 9);
  tired.needs.energy = .08;
  advance(ready, 1); advance(tired, 1); advance(rain, 1, { rain: 1, dusk: 0 });
  assert.equal(ready.intent, "fish"); assert.equal(tired.intent, "rest"); assert.equal(rain.intent, "rest");
  assert.match(rain.reason, /Дождь/);
  const seller = createPleskMind(world, 9); seller.catchCount = PLESK_MIND_LIMITS.basket;
  advance(seller, 1);
  assert.equal(seller.intent, "trade"); assert.equal(seller.stage.target.id, "plesk-trade");
  const night = createPleskMind(world, 9); night.needs.energy = .55;
  const morning = createPleskMind(world, 9); morning.needs.energy = .55;
  advance(night, 1, { rain: 0, dusk: 1 }); advance(morning, 1);
  assert.equal(night.intent, "rest"); assert.notEqual(morning.intent, "rest");
  const frustrated = createPleskMind(world, 9); frustrated.needs.patience = 0;
  advance(frustrated, 1);
  assert.ok(["look", "tackle"].includes(frustrated.intent), "low patience changes the next occupation");
});

test("long autonomous life stays on personal routes, reacts to fatigue and returns to fishing after rest", () => {
  const mind = createPleskMind(world), nav = createWorldNavigation(world), base = pleskLocalPlaces(world).base;
  const intents = new Set(), actions = new Set(); let previous = pleskMindFrame(mind, world, false), rested = false, fishedAfterRest = false;
  for (let t = 0; t < 1600; t += .25) {
    advancePleskMind(mind, world, .25, day);
    const frame = pleskMindFrame(mind, world, false);
    assert.ok(frame); assert.ok(isWalkable(nav, frame)); assert.ok(canTraverse(nav, previous, frame));
    assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= PLESK.speed * .25 + 1e-6);
    assert.ok(Math.hypot(frame.x - base.position.x, frame.y - base.position.y) < 90);
    assert.ok(frame.destinationId.startsWith("plesk-"));
    if (["cast", "fish", "bite", "reel", "catch"].includes(frame.action)) {
      assert.equal(frame.direction, "front", "live AI keeps her face visible at the personal pier");
      assert.ok(Math.hypot(frame.waterTarget.x - pleskLocalPlaces(world).waterTarget.x, frame.waterTarget.y - pleskLocalPlaces(world).waterTarget.y) <= 8);
    }
    assert.ok(mind.catchCount >= 0 && mind.catchCount <= PLESK_MIND_LIMITS.basket && Number.isInteger(mind.catchCount));
    assert.ok(Object.values(mind.needs).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(mind.recent.length <= PLESK_MIND_LIMITS.recent);
    if (frame.action === "rest") rested = true;
    if (rested && frame.action === "fish") fishedAfterRest = true;
    intents.add(mind.intent); actions.add(frame.action); previous = frame;
  }
  for (const intent of ["fish", "trade", "rest"]) assert.ok(intents.has(intent), intent);
  for (const action of ["walk", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest"]) assert.ok(actions.has(action), action);
  assert.ok(fishedAfterRest); assert.ok(mind.decisions > 20);
});

test("seeds vary fishing outcomes while identical needs and seeds remain reproducible", () => {
  const first = createPleskMind(world, 44), second = createPleskMind(world, 44);
  advance(first, 240, day, .25); advance(second, 240, day, .1);
  assert.equal(first.decisions, second.decisions); assert.equal(first.catchCount, second.catchCount);
  assert.equal(first.stage.action, second.stage.action); assert.equal(first.intent, second.intent);
  assert.ok(Math.abs(first.elapsed - second.elapsed) < 1e-6);
  for (const key of Object.keys(first.needs)) assert.ok(Math.abs(first.needs[key] - second.needs[key]) < 1e-6);
  const outcomes = new Set(), waits = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const mind = createPleskMind(world, seed); advance(mind, 1);
    const fishing = mind.queue.find(stage => stage.action === "fish");
    outcomes.add(fishing.outcome); waits.add(fishing.duration);
  }
  assert.ok(outcomes.size >= 2); assert.ok(waits.size > 10);
});

test("rain interrupts a waiting cast by reeling in before choosing rest without producing a catch", () => {
  const mind = createPleskMind(world, 9);
  until(mind, item => item.stage.action === "fish" && item.age > 2);
  assert.equal(mind.catchCount, 0);
  advance(mind, .1, { rain: 1, dusk: 0 });
  assert.equal(mind.stage.action, "reel"); assert.equal(mind.stage.outcome, "miss"); assert.match(mind.reason, /дождь/);
  advance(mind, 4, { rain: 1, dusk: 0 });
  assert.equal(mind.intent, "rest"); assert.equal(mind.catchCount, 0);
});

test("a visitor gets a safe greeting, including stowing a cast, with a cooldown against repeated interruptions", () => {
  const mind = createPleskMind(world, 9);
  until(mind, item => item.stage.action === "fish" && item.age > 2);
  const feet = { ...mind.position };
  noticePleskMind(mind); advance(mind, .1);
  assert.equal(mind.stage.action, "reel");
  until(mind, item => item.stage.action === "greet", 10);
  assert.deepEqual(mind.position, feet); assert.equal(mind.catchCount, 0);
  const deadline = mind.greetAfter;
  for (let count = 0; count < 20; count++) { noticePleskMind(mind); advance(mind, .1); }
  assert.equal(mind.greetAfter, deadline, "repeated taps do not restart the greeting or extend its timer");
});

test("first and later catches have distinct held and packed states, and a missed cast creates no stock", () => {
  let success, miss;
  for (let seed = 1; seed < 50 && (!success || !miss); seed++) {
    const mind = createPleskMind(world, seed); advance(mind, 1);
    const outcome = mind.queue.find(stage => stage.action === "fish").outcome;
    if (outcome === "miss") miss ??= mind; else success ??= mind;
  }
  until(success, mind => mind.stage.action === "catch");
  let frame = pleskMindFrame(success, world, false);
  assert.equal(frame.carryingFish, true); assert.equal(frame.basketFilled, false); assert.equal(success.catchCount, 0);
  const caughtSpecies = frame.species;
  assert.ok(["fish", "fish_silverfin", "fish_reedperch", "fish_mooncarp"].includes(caughtSpecies));
  assert.equal(frame.basketSpecies, undefined);
  until(success, mind => mind.stage.action === "pack" && mind.stage.deposit && mind.age / mind.stage.duration > .75);
  frame = pleskMindFrame(success, world, false);
  assert.equal(frame.basketFilled, true);
  assert.equal(frame.basketSpecies, caughtSpecies);
  assert.equal(frame.carryingFish, false, "a released catch is no longer held during the end of pack");
  const still = pleskMindFrame(success, world, true);
  assert.equal(still.phase, frame.phase); assert.equal(still.basketFilled, true);
  assert.equal(still.basketSpecies, caughtSpecies); assert.equal(still.carryingFish, false);
  assert.equal(fishingCatchFrame(still, true).visible, false, "reduced motion cannot lift the deposited catch back out");
  until(success, mind => mind.catchCount === 1);
  assert.equal(pleskMindFrame(success, world, false).basketFilled, true);
  assert.equal(pleskMindFrame(success, world, false).basketSpecies, caughtSpecies);
  until(success, mind => mind.stage.action === "catch" && mind.catchCount > 0);
  assert.equal(pleskMindFrame(success, world, false).basketFilled, true, "earlier fish remain stored while showing a later catch");
  const decisions = miss.decisions;
  until(miss, mind => mind.decisions > decisions);
  assert.equal(miss.catchCount, 0);
});

test("every live packing stage belongs to one new catch and never repeats from stored stock or camera sampling", () => {
  const mind = createPleskMind(world, 9);
  let previousStage = mind.stage, previousCount = 0, held = false, completedCatches = 0, completedDeposits = 0, lastDeposit = -Infinity;
  const snapshot = () => JSON.stringify({ elapsed: mind.elapsed, age: mind.age, position: mind.position,
    needs: mind.needs, catchCount: mind.catchCount, basketSpecies: mind.basketSpecies, seed: mind.seed,
    stage: mind.stage, queue: mind.queue, decisions: mind.decisions, observation: mind.observation });
  for (let t = 0; t < 1800; t += .1) {
    advancePleskMind(mind, world, .1, day);
    const frame = pleskMindFrame(mind, world, false);
    if (mind.stage !== previousStage) {
      if (previousStage.action === "catch") { held = true; completedCatches++; }
      if (previousStage.deposit) {
        assert(held, "one completed catch authorizes exactly one completed deposit");
        held = false; completedDeposits++; lastDeposit = t;
        assert.equal(frame.action, "idle", "the resident pauses after placing the fish");
      }
      previousStage = mind.stage;
    }
    if (frame.action === "cast") assert(t - lastDeposit >= 4 - .11, "a completed transfer is followed by a quiet pause");
    if (frame.action === "pack") {
      assert.equal(mind.stage.deposit, true, "preparation and tackle checks never pack an old basket fish");
      assert.equal(mind.stage.caught, true);
      assert.equal(frame.carryingFish, frame.phase < FISHING_PACK_RELEASE);
    }
    if (mind.catchCount > previousCount) {
      assert.equal(mind.catchCount, previousCount + 1);
      assert.equal(completedDeposits, completedCatches);
    }
    previousCount = mind.catchCount;
    const before = snapshot();
    for (let camera = 0; camera < 3; camera++) {
      const still = pleskMindFrame(mind, world, true);
      assert.equal(still.phase, frame.phase); assert.equal(still.basketFilled, frame.basketFilled);
      assert.equal(still.carryingFish, frame.carryingFish);
    }
    assert.equal(snapshot(), before, "sampling either camera cannot change catch, seed, queue or progress");
  }
  assert(completedDeposits > 10, "the invariant covers many complete catches rather than a single pose");
  assert(completedCatches - completedDeposits >= 0 && completedCatches - completedDeposits <= 1,
    "only the current held catch may await its one deposit");
});

test("stowing an interrupted cast never repacks fish already stored in the basket", () => {
  for (const interruption of ["rain", "visitor"]) {
    const mind = createPleskMind(world, 9);
    mind.catchCount = 1; mind.basketSpecies = "fish_silverfin";
    until(mind, item => item.stage.action === "fish" && item.age > 2);
    if (interruption === "visitor") noticePleskMind(mind);
    const environment = interruption === "rain" ? { rain: 1, dusk: 0 } : day;
    for (let time = 0; time < 5; time += .1) {
      advancePleskMind(mind, world, .1, environment);
      const frame = pleskMindFrame(mind, world, false);
      assert.notEqual(frame.action, "pack");
      assert.equal(fishingCatchFrame(frame, false).visible, false);
      assert.equal(mind.catchCount, 1); assert.equal(frame.basketSpecies, "fish_silverfin");
    }
  }
});

test("read-only camera sampling, reduced motion and paused steps preserve the actual current feet and live needs", () => {
  const mind = createPleskMind(world, 9); mind.catchCount = 3;
  advance(mind, 2);
  assert.equal(mind.stage.action, "walk");
  const snapshot = { elapsed: mind.elapsed, position: { ...mind.position }, needs: { ...mind.needs }, decisions: mind.decisions, age: mind.age };
  const first = pleskMindFrame(mind, world, false), still = pleskMindFrame(mind, world, true);
  assert.deepEqual({ x: still.x, y: still.y }, { x: first.x, y: first.y }); assert.equal(still.frame, 0);
  assert.notDeepEqual(mind.position, pleskLocalPlaces(world).base.position);
  for (let i = 0; i < 100; i++) assert.deepEqual(pleskMindFrame(mind, world, false), first);
  for (const dt of [0, -1, NaN, Infinity]) advancePleskMind(mind, world, dt, day);
  assert.deepEqual({ elapsed: mind.elapsed, position: mind.position, needs: mind.needs, decisions: mind.decisions, age: mind.age }, snapshot);
  advancePleskMind(mind, world, 24 * 3600, day);
  assert.equal(mind.elapsed, snapshot.elapsed + PLESK_MIND_LIMITS.maxDelta, "a hidden-tab time gap cannot simulate an offline day");
});

test("personal markers, missing water and unreachable local shops fail safely without shared hero fallbacks or repeated path searches", () => {
  const missing = { ...world, destinations: world.destinations.filter(marker => marker.id !== "plesk-fishing") };
  assert.equal(createPleskMind(missing), null);
  const dry = { ...world, water: undefined }, mind = createPleskMind(dry);
  const nav = createWorldNavigation(dry), search = nav.stats.lastSearch;
  for (let i = 0; i < 120; i++) {
    advancePleskMind(mind, dry, 1, day);
    assert.ok(!["cast", "fish", "bite", "reel", "catch"].includes(pleskMindFrame(mind, dry, false).action));
  }
  assert.strictEqual(nav.stats.lastSearch, search); assert.equal(mind.catchCount, 0);
  const noShop = { ...world, destinations: world.destinations.filter(marker => marker.id !== "plesk-trade") };
  const local = createPleskMind(noShop); local.catchCount = 3;
  for (let i = 0; i < 120; i++) { advancePleskMind(local, noShop, 1, day); assert.notEqual(local.intent, "trade"); }
  const hidden = createPleskMind(world); advancePleskMind(hidden, missing, .1, day);
  assert.equal(pleskMindFrame(hidden, missing, false), null);
  advancePleskMind(hidden, world, .1, day);
  assert.ok(pleskMindFrame(hidden, world, false), "restoring the original safe marker resumes the resident without a reset");
});
