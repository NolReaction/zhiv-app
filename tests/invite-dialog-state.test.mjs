import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const dialog = await vite.ssrLoadModule("/lib/invite-dialog-state.ts");

after(async () => {
  await vite.close();
});

test("closing QR preserves its content throughout the exit animation", () => {
  const opened = dialog.inviteDialogReducer(dialog.initialInviteDialogState, {
    type: "open",
    mode: "qr",
  });
  const closing = dialog.inviteDialogReducer(opened, { type: "close" });

  assert.deepEqual(opened, { open: true, mode: "qr" });
  assert.deepEqual(closing, { open: false, mode: "qr" });
});

test("the next invitation changes mode only when it opens", () => {
  const closingQr = { open: false, mode: "qr" };
  const openedLink = dialog.inviteDialogReducer(closingQr, {
    type: "open",
    mode: "link",
  });

  assert.deepEqual(openedLink, { open: true, mode: "link" });
});
