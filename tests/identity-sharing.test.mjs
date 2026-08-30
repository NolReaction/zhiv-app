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

const sharing = await vite.ssrLoadModule("/lib/identity-sharing.ts");

after(async () => {
  await vite.close();
});

function createLegacyDocument(events, copyResult = true) {
  const field = {
    readOnly: false,
    style: {},
    value: "",
    focus() {
      events.push("field-focus");
    },
    remove() {
      events.push("field-remove");
    },
    select() {
      events.push("field-select");
    },
    setAttribute() {},
    setSelectionRange(start, end) {
      events.push(`field-range:${start}-${end}`);
    },
  };

  return {
    activeElement: {
      focus() {
        events.push("focus-restored");
      },
    },
    body: {
      appendChild() {
        events.push("field-appended");
      },
    },
    createElement(tagName) {
      assert.equal(tagName, "textarea");
      return field;
    },
    execCommand(command) {
      events.push(`exec:${command}`);
      return copyResult;
    },
    getSelection() {
      return {
        addRange() {},
        getRangeAt() {
          throw new Error("No ranges expected");
        },
        rangeCount: 0,
        removeAllRanges() {},
      };
    },
  };
}

test("copies a person's ID without opening share on Safari over LAN HTTP", async () => {
  const events = [];
  const copied = await sharing.copyText("YD4H-0SQF-N72K", {
    document: createLegacyDocument(events),
    navigator: {
      share() {
        events.push("share-start");
        return Promise.resolve();
      },
    },
    secureContext: false,
  });

  assert.equal(copied, true);
  assert.ok(events.includes("field-appended"));
  assert.ok(events.includes("exec:copy"));
  assert.equal(events.includes("share-start"), false);
});

test("falls back to legacy copy when the secure Clipboard API refuses access", async () => {
  const events = [];
  const copied = await sharing.copyText("YD4H-0SQF-N72K", {
    document: createLegacyDocument(events),
    navigator: {
      clipboard: {
        writeText() {
          events.push("clipboard-refused");
          return Promise.reject(new Error("denied"));
        },
      },
    },
    secureContext: true,
  });

  assert.equal(copied, true);
  assert.deepEqual(events.filter((event) => event === "clipboard-refused" || event === "exec:copy"), [
    "clipboard-refused",
    "exec:copy",
  ]);
});

test("mounts the Safari fallback inside an active dialog", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  const dialog = {
    appendChild() {
      events.push("dialog-field-appended");
    },
  };
  documentApi.activeElement.closest = (selector) => {
    events.push(`closest:${selector}`);
    return dialog;
  };

  const copied = await sharing.copyText("https://zhiv.example/#/invite/token", {
    document: documentApi,
    navigator: {},
    secureContext: false,
  });

  assert.equal(copied, true);
  assert.ok(events.includes('closest:[role="dialog"]'));
  assert.ok(events.includes("dialog-field-appended"));
  assert.equal(events.includes("field-appended"), false);
  assert.ok(events.indexOf("dialog-field-appended") < events.indexOf("field-focus"));
  assert.ok(events.indexOf("field-focus") < events.indexOf("exec:copy"));
});

test("finds the open dialog when iOS does not focus the tapped button", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  const dialog = {
    appendChild() {
      events.push("open-dialog-field-appended");
    },
  };
  documentApi.activeElement.closest = () => null;
  documentApi.querySelector = (selector) => {
    events.push(`query:${selector}`);
    return dialog;
  };

  const copied = await sharing.copyText("https://zhiv.example/#/invite/token", {
    document: documentApi,
    navigator: {},
    secureContext: false,
  });

  assert.equal(copied, true);
  assert.ok(events.includes('query:[role="dialog"][data-state="open"]'));
  assert.ok(events.includes("open-dialog-field-appended"));
  assert.equal(events.includes("field-appended"), false);
});

test("copies the ID through the Safari fallback on LAN HTTP", async () => {
  const events = [];
  const result = await sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: createLegacyDocument(events),
    navigator: {
      share() {
        events.push("share-start");
        return Promise.resolve();
      },
    },
    secureContext: false,
  });

  assert.deepEqual(result, { copied: true, shareOutcome: "unavailable" });
  assert.ok(events.includes("exec:copy"));
  assert.equal(events.includes("share-start"), false);
  assert.equal(sharing.getIdentitySharingNotice(result), "ID скопирован");
});

test("turns a synchronous DOM fallback failure into a normal result", async () => {
  const result = await sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: {
      body: {},
      execCommand() {
        return true;
      },
      getSelection() {
        throw new Error("selection unavailable");
      },
    },
    navigator: {},
    secureContext: false,
  });

  assert.deepEqual(result, { copied: false, shareOutcome: "unavailable" });
  assert.equal(
    sharing.getIdentitySharingNotice(result),
    "Не скопировано — зажмите ID",
  );
});

test("starts copying before native share without awaiting either action", async () => {
  const events = [];
  let resolveCopy;
  let resolveShare;

  const pending = sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: {},
    navigator: {
      clipboard: {
        writeText(text) {
          events.push(`copy:${text}`);
          return new Promise((resolve) => {
            resolveCopy = resolve;
          });
        },
      },
      canShare(data) {
        events.push(`can-share:${data.text}`);
        return true;
      },
      share(data) {
        events.push(`share:${data.title}:${data.text}`);
        return new Promise((resolve) => {
          resolveShare = resolve;
        });
      },
    },
    secureContext: true,
  });

  assert.deepEqual(events, [
    "copy:YD4H-0SQF-N72K",
    "can-share:Добавь меня в «Я живой» по ID: YD4H-0SQF-N72K",
    "share:Я живой:Добавь меня в «Я живой» по ID: YD4H-0SQF-N72K",
  ]);

  resolveCopy();
  resolveShare();
  assert.deepEqual(await pending, { copied: true, shareOutcome: "shared" });
});

test("treats closing the share sheet as a normal copied result", async () => {
  const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const result = await sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: {},
    navigator: {
      clipboard: { writeText: () => Promise.resolve() },
      share: () => Promise.reject(abortError),
    },
    secureContext: true,
  });

  assert.deepEqual(result, { copied: true, shareOutcome: "cancelled" });
  assert.equal(sharing.getIdentitySharingNotice(result), "ID скопирован");
});

test("reports copy failure honestly even when native share succeeds", async () => {
  const result = await sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: {},
    navigator: {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
      share: () => Promise.resolve(),
    },
    secureContext: true,
  });

  assert.deepEqual(result, { copied: false, shareOutcome: "shared" });
  assert.equal(
    sharing.getIdentitySharingNotice(result),
    "Поделиться удалось, но ID не скопирован",
  );
});

test("offers a manual fallback when both browser actions fail", async () => {
  const result = await sharing.shareIdentity("YD4H-0SQF-N72K", {
    document: {},
    navigator: {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
      share: () => Promise.reject(new Error("blocked")),
    },
    secureContext: true,
  });

  assert.deepEqual(result, { copied: false, shareOutcome: "failed" });
  assert.equal(
    sharing.getIdentitySharingNotice(result),
    "Не скопировано — зажмите ID",
  );
});
