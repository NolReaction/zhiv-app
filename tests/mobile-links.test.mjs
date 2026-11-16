import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { nativeLinkAction } = await vite.ssrLoadModule("/apps/mobile/src/native-links.ts");
after(() => vite.close());

for (const documentUrl of ["capacitor://localhost/index.html", "https://localhost/index.html"]) {
  test(`native link policy preserves internal navigation at ${documentUrl}`, () => {
    assert.equal(nativeLinkAction("/#notification=mail", "", documentUrl), null);
    assert.equal(nativeLinkAction("#details", "", documentUrl), null);
    assert.deepEqual(nativeLinkAction("/earth/models/CREDITS.txt", "_blank", documentUrl), { kind: "website", path: "/earth/models/CREDITS.txt" });
    assert.deepEqual(nativeLinkAction("/vendor/maplibre-gl-6.15.0/LICENSE.txt", "_blank", documentUrl), { kind: "website", path: "/vendor/maplibre-gl-6.15.0/LICENSE.txt" });
    assert.deepEqual(nativeLinkAction("/api/v1/auth/account", "_blank", documentUrl), { kind: "blocked" });
    assert.deepEqual(nativeLinkAction("/earth/models/CREDITS.txt?token=secret", "_blank", documentUrl), { kind: "blocked" });
  });
  test(`native external HTTPS opens browser while unsafe schemes are rejected at ${documentUrl}`, () => {
    assert.deepEqual(nativeLinkAction("https://www.openstreetmap.org/copyright", "", documentUrl), { kind: "browser", url: "https://www.openstreetmap.org/copyright" });
    for (const href of ["javascript:alert(1)", "data:text/html,test", "intent://evil", "http://example.com/", "https://user:pass@example.com/", "capacitor://evil/index.html"]) {
      assert.deepEqual(nativeLinkAction(href, "_blank", documentUrl), { kind: "blocked" });
    }
    assert.equal(nativeLinkAction("mailto:support@example.com", "", documentUrl), null);
    assert.equal(nativeLinkAction("tel:+70000000000", "", documentUrl), null);
  });
}
