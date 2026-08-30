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
      appendChild(element) {
        events.push(`field-appended:${element.value}`);
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

test("copies the complete invite URL synchronously on iPhone LAN HTTP", async () => {
  const events = [];
  const inviteUrl = "http://192.168.1.232:3000/#/invite/K_Px9NhbG9Y6vnUg3BDnv-o4m5GkSb9uLrv0ptuGSvU";
  const pendingCopy = sharing.copyText(inviteUrl, {
    document: createLegacyDocument(events),
    navigator: {
      share() {
        events.push("share-start");
        return Promise.resolve();
      },
    },
    secureContext: false,
  });

  assert.ok(events.includes(`field-appended:${inviteUrl}`));
  assert.ok(events.includes(`field-range:0-${inviteUrl.length}`));
  assert.ok(events.includes("exec:copy"));
  assert.equal(events.includes("share-start"), false);
  assert.equal(await pendingCopy, true);
});

test("copies a LAN invite from the visible selected field", async () => {
  const events = [];
  const inviteUrl = "http://192.168.1.232:3000/#/invite/K_Px9NhbG9Y6vnUg3BDnv-o4m5GkSb9uLrv0ptuGSvU";
  const field = {
    value: inviteUrl,
    focus(options) {
      events.push(`focus:${options?.preventScroll === true}`);
    },
    select() {
      events.push("select");
    },
    setSelectionRange(start, end) {
      events.push(`range:${start}-${end}`);
    },
  };
  const pendingCopy = sharing.copyTextFromVisibleField(inviteUrl, field, {
    document: {
      execCommand(command) {
        events.push(`exec:${command}`);
        return true;
      },
    },
    navigator: {},
    secureContext: false,
  });

  assert.deepEqual(events, [
    "focus:true",
    "select",
    `range:0-${inviteUrl.length}`,
    "exec:copy",
  ]);
  assert.equal(await pendingCopy, "legacy");
});

test("confirms a visible-field copy when the secure Clipboard API resolves", async () => {
  const events = [];
  const field = {
    value: "https://example.test/#/invite/token",
    focus() {
      events.push("focus");
    },
    select() {
      events.push("select");
    },
    setSelectionRange() {
      events.push("range");
    },
  };
  const outcome = await sharing.copyTextFromVisibleField(field.value, field, {
    document: {
      execCommand(command) {
        events.push(`exec:${command}`);
        return true;
      },
    },
    navigator: {
      clipboard: {
        writeText(text) {
          events.push(`clipboard:${text}`);
          return Promise.resolve();
        },
      },
    },
    secureContext: true,
  });

  assert.equal(outcome, "confirmed");
  assert.equal(events[0], `clipboard:${field.value}`);
  assert.ok(events.includes("exec:copy"));
});

test("copy-only action never opens the native share sheet", async () => {
  const events = [];
  const copied = await sharing.copyText("https://example.test/#/invite/token", {
    document: {},
    navigator: {
      clipboard: {
        writeText(text) {
          events.push(`copy:${text}`);
          return Promise.resolve();
        },
      },
      share() {
        events.push("share-start");
        return Promise.resolve();
      },
    },
    secureContext: true,
  });

  assert.equal(copied, true);
  assert.deepEqual(events, ["copy:https://example.test/#/invite/token"]);
});

test("share-only action never competes with clipboard access", async () => {
  const events = [];
  const data = {
    title: "Приглашение в «Я живой»",
    text: "Добавь меня в личные связи в «Я живой».",
    url: "https://example.test/#/invite/token",
  };
  const outcome = await sharing.shareContent(data, {
    document: {},
    navigator: {
      clipboard: {
        writeText() {
          events.push("copy-start");
          return Promise.resolve();
        },
      },
      canShare(shareData) {
        events.push(`can-share:${shareData.url}`);
        return true;
      },
      share(shareData) {
        events.push(`share:${shareData.url}`);
        return Promise.resolve();
      },
    },
    secureContext: true,
  });

  assert.equal(outcome, "shared");
  assert.deepEqual(events, [
    "can-share:https://example.test/#/invite/token",
    "share:https://example.test/#/invite/token",
  ]);
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
