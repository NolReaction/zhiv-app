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

test("does not disturb selection while the secure Clipboard write is pending", async () => {
  const events = [];
  let rejectModernCopy;
  const modernCopy = new Promise((_, reject) => {
    rejectModernCopy = reject;
  });
  const pendingCopy = sharing.copyText("invite-url", {
    document: createLegacyDocument(events),
    navigator: {
      clipboard: {
        writeText() {
          events.push("clipboard-start");
          return modernCopy;
        },
      },
    },
    secureContext: true,
  });

  assert.deepEqual(
    events.filter((event) => event === "clipboard-start" || event === "exec:copy"),
    ["clipboard-start"],
  );
  rejectModernCopy(new Error("denied after the tap"));
  assert.equal(await pendingCopy, true);
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

test("mounts the synchronous iPhone copy field inside the active dialog", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  const dialog = {
    appendChild(element) {
      events.push(`dialog-field-appended:${element.value}`);
    },
  };
  documentApi.activeElement.closest = (selector) => {
    events.push(`closest:${selector}`);
    return dialog;
  };

  const inviteUrl = "http://192.168.1.232:3000/#/invite/K_Px9NhbG9Y6vnUg3BDnv-o4m5GkSb9uLrv0ptuGSvU";
  const pendingCopy = sharing.copyText(inviteUrl, {
    document: documentApi,
    navigator: {},
    secureContext: false,
  });

  assert.deepEqual(events.slice(0, 6), [
    'closest:[role="dialog"]',
    `dialog-field-appended:${inviteUrl}`,
    "field-focus",
    "field-select",
    `field-range:0-${inviteUrl.length}`,
    "exec:copy",
  ]);
  assert.equal(events.some((event) => event.startsWith("field-appended:")), false);
  assert.equal(await pendingCopy, true);
});

test("finds the open dialog when the tapped element is outside its focus scope", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  const dialog = {
    appendChild(element) {
      events.push(`open-dialog-field-appended:${element.value}`);
    },
  };
  documentApi.activeElement.closest = () => null;
  documentApi.querySelector = (selector) => {
    events.push(`query:${selector}`);
    return dialog;
  };

  const pendingCopy = sharing.copyText("invite-url", {
    document: documentApi,
    navigator: {},
    secureContext: false,
  });

  assert.equal(events[0], 'query:[role="dialog"][data-state="open"]');
  assert.equal(events[1], "open-dialog-field-appended:invite-url");
  assert.ok(events.indexOf("field-focus") < events.indexOf("exec:copy"));
  assert.equal(await pendingCopy, true);
});

test("uses iOS-safe fixed hidden-field styling for legacy copy", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  let appendedField;
  documentApi.body.appendChild = (field) => {
    appendedField = field;
  };

  assert.equal(await sharing.copyText("invite-url", {
    document: documentApi,
    navigator: {},
    secureContext: false,
  }), true);

  assert.equal(appendedField.readOnly, true);
  assert.deepEqual(appendedField.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    margin: "0",
    opacity: "0",
    fontSize: "16px",
    pointerEvents: "none",
  });
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


test("copies only the complete public ID or recovery code without selecting text", async () => {
  for (const value of ["A7FN-1FVG-3KM1", "ZHIV-R1-test-recovery-secret"]) {
    const events = [];
    const copied = await sharing.copyText(value, {
      document: createLegacyDocument(events),
      navigator: { clipboard: { writeText: async text => { events.push(text); } } },
      secureContext: true,
    });
    assert.equal(copied, true);
    assert.deepEqual(events, [value]);
  }
});

test("restores the original selection and focus after legacy copy", async () => {
  const events = [];
  const documentApi = createLegacyDocument(events);
  const savedRange = {};
  documentApi.getSelection = () => ({
    rangeCount: 1,
    getRangeAt: () => ({ cloneRange: () => savedRange }),
    removeAllRanges: () => events.push("clear-selection"),
    addRange: range => { assert.equal(range, savedRange); events.push("restore-selection"); },
  });
  assert.equal(await sharing.copyText("ID", { document: documentApi, navigator: {}, secureContext: false }), true);
  assert.deepEqual(events.slice(-4), ["field-remove", "focus-restored", "clear-selection", "restore-selection"]);
});

test("copy failures and unavailable browser APIs return false, never a false success", async () => {
  assert.equal(await sharing.copyText("ID", null), false);
  assert.equal(await sharing.copyText("ID", { document: {}, navigator: {}, secureContext: false }), false);
  assert.equal(await sharing.copyText("ID", {
    document: createLegacyDocument([], false),
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    secureContext: true,
  }), false);
  assert.equal(await sharing.copyText("ID", {
    document: { body: {}, execCommand: () => true, getSelection: () => { throw new Error("DOM unavailable"); } },
    navigator: {}, secureContext: false,
  }), false);
});

test("synchronously denied Clipboard access still tries the legacy command in the tap", async () => {
  const events = [];
  const pending = sharing.copyText("ID", {
    document: createLegacyDocument(events),
    navigator: { clipboard: { writeText: () => { throw new Error("blocked"); } } },
    secureContext: true,
  });
  assert.ok(events.includes("exec:copy"));
  assert.equal(await pending, true);
});

test("native share cancellation and failure remain distinct from clipboard actions", async () => {
  for (const [name, expected] of [["AbortError", "cancelled"], ["Error", "failed"]]) {
    assert.equal(await sharing.shareContent({ text: "invite" }, {
      document: {}, secureContext: true,
      navigator: { share: async () => { throw Object.assign(new Error("share ended"), { name }); } },
    }), expected);
  }
  assert.equal(await sharing.shareContent({ text: "invite" }, {
    document: {}, secureContext: true,
    navigator: { canShare: () => false, share: () => { throw new Error("must not start"); } },
  }), "unavailable");
});

test("reports failure when a deferred rejection outlives Safari user activation", async () => {
  let rejectWrite;
  let activation = true;
  const documentApi = createLegacyDocument([]);
  documentApi.execCommand = () => activation;
  const pending = sharing.copyText("ID", {
    document: documentApi, secureContext: true,
    navigator: { clipboard: { writeText: () => new Promise((_, reject) => { rejectWrite = reject; }) } },
  });
  activation = false;
  rejectWrite(new Error("denied after user activation expired"));
  assert.equal(await pending, false);
});
