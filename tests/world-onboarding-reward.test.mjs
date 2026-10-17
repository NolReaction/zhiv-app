import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-onboarding-reward-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-onboarding-reward-${process.pid}`, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "world-onboarding-reward-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, changed = false, pending = new Map(), rewards;
      export function reset(factory) {
        for (const slot of slots) slot?.cleanup?.();
        slots = []; cursor = 0; changed = false; pending.clear(); rewards = factory;
      }
      export function begin() { cursor = 0; changed = false; }
      export function dirty() { return changed; }
      export function useRef(initial) { return slots[cursor++] ??= { current: initial }; }
      export function useState(initial) {
        const slot = slots[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial };
        return [slot.value, value => {
          const next = typeof value === 'function' ? value(slot.value) : value;
          if (!Object.is(next, slot.value)) { slot.value = next; changed = true; }
        }];
      }
      export function useEffect(effect, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          slots[index] = { dependencies, cleanup: previous?.cleanup }; pending.set(index, effect);
        }
      }
      export function flush() {
        const effects = [...pending]; pending.clear();
        for (const [index, effect] of effects) { slots[index]?.cleanup?.(); slots[index].cleanup = effect(); }
      }
      export function useGameRewards(...args) { return rewards(...args); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/ui/onboarding/world-onboarding-reward.tsx")) return source
        .replace('from "react";', `from "${hookModule}";`)
        .replace('from "@/features/game/use-game-rewards";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldOnboardingReward } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding-reward.tsx");
const { RewardContents, RewardRecovery } = await vite.ssrLoadModule("/features/game/daily-rewards.tsx");
const { createGameRewardsSession } = await vite.ssrLoadModule("/features/game/game-rewards-session.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const { progressionRewardsCatalog } = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
const owner = "TEST-TEST-TEST", other = "NEXT-NEXT-NEXT";
const finishedAt = Date.parse("2026-10-18T00:00:00Z");
const completed = { version: 2, status: "completed", finishedAt, rewardReady: true };

async function environment({ progress = completed, open = true, isOnline = true, send, claimedAt = null, support = true } = {}) {
  const commands = [], refreshes = [], acknowledgements = [], data = {
    ownerPublicId: owner, serverTime: "2026-10-18T00:00:01.000Z", ...(support ? { onboarding: { claimedAt } } : {}),
  };
  const success = body => {
    const claimedAt = "2026-10-18T00:00:02.000Z";
    data.serverTime = claimedAt;
    if (body.kind === "onboarding") data.onboarding = { claimedAt };
    return { requestId: body.requestId, rewards: structuredClone(data), economy: { ownerPublicId: owner },
      claim: { kind: body.kind, claimedAt, reward: progressionRewardsCatalog.onboarding } };
  };
  const session = createGameRewardsSession(owner, {
    get: async () => structuredClone(data),
    send: async body => { commands.push(body); return send ? send(body, success) : success(body); },
  });
  const deactivate = session.activate();
  await session.refresh();
  let props = { owner, progress, open, isOnline, economy: { snapshot: { ownerPublicId: owner }, refresh: async () => { refreshes.push(owner); } },
    onAcknowledged: () => acknowledgements.push(owner) };
  let confirmed;
  const overrides = {};
  hooks.reset((_, __, ___, onConfirmed) => {
    // useGameRewards keeps the latest committed owner's callback in a ref.
    confirmed = onConfirmed;
    const confirm = async action => { const result = await action(); if (result) confirmed?.(result); return result; };
    return { ...session.getSnapshot(), now: session.now(), ...overrides, refresh: session.refresh,
      claimOnboarding: () => confirm(session.claimOnboarding), retry: () => confirm(session.retry) };
  });
  let tree;
  const render = (patch = {}) => {
    props = { ...props, ...patch };
    for (let i = 0; i < 12; i++) {
      hooks.begin(); tree = WorldOnboardingReward(props); hooks.flush();
      if (!hooks.dirty()) return tree.props;
    }
    assert.fail("reward coach must settle without a local render loop");
  };
  const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); render(); } return tree.props; };
  const child = type => Children.toArray(tree.props.children).find(node => isValidElement(node) && node.type === type)?.props;
  return { commands, refreshes, acknowledgements, session, data, overrides, render, settle, child,
    stop() { hooks.reset(() => ({})); deactivate(); } };
}

test("explicit completed intent claims once, shows the catalog gift, and acknowledges only server success", async () => {
  const env = await environment();
  try {
    let coach = env.render();
    assert.equal(coach.open, true);
    assert.equal(env.commands.length, 1);
    assert.equal(env.commands[0].kind, "onboarding");
    assert.deepEqual(env.child(RewardContents).reward, { coins: 1000, pearls: 200, items: {} });
    assert.deepEqual(env.acknowledgements, []);
    coach = await env.settle();
    assert.equal(coach.primary.label, "Продолжить");
    assert.deepEqual(env.refreshes, [owner]);
    coach.primary.onClick();
    assert.deepEqual(env.acknowledgements, [owner]);
    for (let i = 0; i < 20; i++) env.render();
    assert.equal(env.commands.length, 1, "render and shared snapshot changes cannot issue another claim");
  } finally { env.stop(); }
});

test("old completions, skipped or active courses and unsupported servers never manufacture an intent", async () => {
  for (const progress of [null, { version: 2, status: "completed" }, { version: 2, status: "completed", finishedAt },
    { version: 2, status: "skipped", rewardReady: true }, { version: 2, status: "started", stepId: "help", rewardReady: true }]) {
    const env = await environment({ progress });
    try { assert.equal(env.render().open, false); await env.settle(); assert.equal(env.commands.length, 0); }
    finally { env.stop(); }
  }
  const env = await environment({ support: false });
  try {
    assert.equal(env.render().open, true, "an unsupported or loading reward does not silently dismiss the earned intent");
    await env.settle(); assert.equal(env.commands.length, 0);
  } finally { env.stop(); }
});

test("offline and modal-covered intent stays mounted and claims once on the next available visit", async () => {
  const env = await environment({ isOnline: false });
  try {
    let coach = env.render();
    assert.equal(coach.open, true); assert.match(coach.status, /интернет/);
    assert.equal(coach.primary.disabled, true); assert.equal(env.commands.length, 0);
    env.render({ open: false, isOnline: true });
    await env.settle(); assert.equal(env.commands.length, 0);
    env.render({ open: true });
    await env.settle(); assert.equal(env.commands.length, 1);
  } finally { env.stop(); }
});

test("a fast definitive refusal does not auto-loop; explicit retry and reentry remain available", async () => {
  const env = await environment({ send: async () => { throw new ApiError("Не сейчас", 409, { code: "REWARD_NOT_READY" }); } });
  try {
    env.render(); let coach = await env.settle();
    for (let i = 0; i < 30; i++) env.render();
    assert.equal(env.commands.length, 1);
    assert.equal(coach.open, true); assert.equal(env.child(RewardRecovery).controller.error, "Не сейчас");
    coach.primary.onClick(); await env.settle(); assert.equal(env.commands.length, 2);
    env.render({ open: false }); env.render({ open: true }); await env.settle();
    assert.equal(env.commands.length, 3);
    env.render({ isOnline: false }); env.render({ isOnline: true }); await env.settle();
    assert.equal(env.commands.length, 4);
    assert.equal(new Set(env.commands.map(command => command.requestId)).size, 4, "only explicit/reentry retries of a definitive refusal get new receipts");
  } finally { env.stop(); }
});

test("an uncertain receipt blocks auto claims across offline and reentry, then explicitly reuses its UUID", async () => {
  let fail = true;
  const env = await environment({ send: async (body, success) => { if (fail) throw Error("lost response"); return success(body); } });
  try {
    env.render(); await env.settle();
    const first = env.commands[0].requestId;
    let coach = env.render();
    assert.equal(coach.open, true); assert.equal(coach.primary, undefined);
    assert.equal(env.child(RewardRecovery).controller.uncertain, true);
    env.render({ open: false, isOnline: false }); env.render({ open: true, isOnline: true });
    await env.settle(); assert.equal(env.commands.length, 1);
    fail = false;
    await env.child(RewardRecovery).controller.retry(); coach = await env.settle();
    assert.equal(env.commands.length, 2); assert.equal(env.commands[1].requestId, first);
    assert.equal(coach.primary.label, "Продолжить");
  } finally { env.stop(); }
});

test("dismissing preserves the intent for reentry, and a server-confirmed prior claim never pays again", async () => {
  const env = await environment({ claimedAt: "2026-10-18T00:00:00.000Z" });
  try {
    let coach = env.render();
    coach.onPause(); assert.equal(env.render().open, false);
    env.render({ open: false }); coach = env.render({ open: true });
    assert.equal(coach.open, true); assert.equal(coach.primary.label, "Продолжить");
    assert.deepEqual(env.acknowledgements, []); assert.equal(env.commands.length, 0);
    coach.onSkip(); assert.equal(env.render().open, false);
  } finally { env.stop(); }
});

test("another reward's receipt remains visible and must be explicitly recovered before onboarding can claim", async () => {
  let failDaily = true;
  const env = await environment({ send: async (body, success) => {
    if (body.kind === "daily" && failDaily) throw Error("daily response missing");
    return success(body);
  } });
  try {
    env.data.daily = { claimable: true };
    await env.session.refresh(); await env.session.claimDaily();
    let coach = env.render();
    assert.equal(coach.open, true); assert.match(coach.status, /предыдущей награды/);
    assert.equal(coach.primary, undefined); assert.equal(env.commands.length, 1);
    assert.equal(env.child(RewardRecovery).controller.pending.kind, "daily");
    await env.settle(); assert.equal(env.commands.length, 1);
    failDaily = false;
    await env.child(RewardRecovery).controller.retry(); coach = await env.settle();
    assert.deepEqual(env.commands.map(command => command.kind), ["daily", "daily", "onboarding"]);
    assert.equal(env.commands[0].requestId, env.commands[1].requestId);
    assert.equal(coach.primary.label, "Продолжить");
  } finally { env.stop(); }
});

test("loading and server cooldown keep the intent visible and permit a single attempt only when ready", async () => {
  const env = await environment();
  try {
    env.overrides.loading = true;
    assert.equal(env.render().open, true); assert.equal(env.commands.length, 0);
    env.overrides.loading = false;
    env.overrides.now = finishedAt;
    env.overrides.retryAt = finishedAt + 60_000;
    let coach = env.render();
    assert.equal(coach.primary.disabled, true); assert.match(coach.status, /подождать/);
    assert.equal(env.commands.length, 0);
    env.overrides.now += 60_000;
    env.render(); coach = await env.settle();
    assert.equal(env.commands.length, 1); assert.equal(coach.primary.label, "Продолжить");
  } finally { env.stop(); }
});

test("a covered in-flight receipt still confirms while a changed economy owner cannot be refreshed", async () => {
  let release;
  const env = await environment({ send: (body, success) => new Promise(resolve => { release = () => resolve(success(body)); }) });
  try {
    env.render();
    env.render({ open: false, economy: { snapshot: { ownerPublicId: other }, refresh: () => assert.fail("stale owner refresh") } });
    release(); await env.settle();
    assert.equal(env.commands.length, 1); assert.deepEqual(env.refreshes, []);
    const coach = env.render({ open: true });
    assert.equal(coach.primary.label, "Продолжить");
  } finally { env.stop(); }
});
