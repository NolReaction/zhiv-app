import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { walletTween, walletDeltaLabel } = await vite.ssrLoadModule("/features/world/wallet-animation.ts");
const { WorldWallet } = await vite.ssrLoadModule("/features/world/world-wallet.tsx");

test("wallet presentation never overshoots confirmed gains or spending", () => {
  for (const [from, to] of [[10, 110], [200, 0], [1_999_999_000, 2_000_000_000], [13, 13]]) {
    assert.equal(walletTween(from, to, 0), from);
    assert.equal(walletTween(from, to, 1), to);
    assert.equal(walletTween(from, to, 2), to);
    assert.equal(walletTween(from, to, -1), from);
    let previous = from;
    for (let step = 1; step <= 20; step++) {
      const current = walletTween(from, to, step / 20);
      assert.ok(Number.isInteger(current));
      assert.ok(current >= Math.min(from, to) && current <= Math.max(from, to));
      assert.ok(to >= from ? current >= previous : current <= previous);
      previous = current;
    }
  }
});

test("wallet delta distinguishes confirmed credits and spending", () => {
  assert.equal(walletDeltaLabel(120), "+120");
  assert.equal(walletDeltaLabel(-35), "−35");
});

test("wallet first render shows exact balances without a fabricated payout", () => {
  const html = renderToStaticMarkup(createElement(WorldWallet, { coins: 150, pearls: 7 }));
  assert.match(html, /data-currency="coins" data-balance="150"/);
  assert.match(html, /data-currency="pearls" data-balance="7"/);
  assert.equal((html.match(/hidden="" aria-hidden="true" data-wallet-change="true"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-live="polite" aria-atomic="true"/g) ?? []).length, 2);
});
