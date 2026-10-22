import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:mailbox-hooks", sonnerId = "virtual:mailbox-toasts";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-mailbox-life-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "mailbox-hooks", enforce: "pre",
    resolveId(id) { if ([hooksId, sonnerId].includes(id)) return `\0${id}`; },
    load(id) {
      if (id === `\0${sonnerId}`) return `export const shown=[],dismissed=[];export const toast={custom(render,options){shown.push({render,options});return options.id;},dismiss(id){dismissed.push(id);}};`;
      if (id === `\0${hooksId}`) return `
        let slots=[],cursor=0,layout=[],passive=[];
        export function reset(){for(const slot of slots)slot?.cleanup?.();slots=[];cursor=0;layout=[];passive=[];}
        export function begin(){cursor=0;layout=[];passive=[];}
        export function useRef(value){const i=cursor++;if(!slots[i])slots[i]={value:{current:value}};return slots[i].value;}
        export function useMemo(fn,deps){const i=cursor++,p=slots[i];if(!p||deps.some((x,n)=>!Object.is(x,p.deps[n])))slots[i]={value:fn(),deps};return slots[i].value;}
        function effect(fn,deps,queue){const i=cursor++,p=slots[i];if(!p||deps.some((x,n)=>!Object.is(x,p.deps[n])))queue.push({i,fn,deps});}
        export function useEffect(fn,deps){effect(fn,deps,passive);}
        export function useLayoutEffect(fn,deps){effect(fn,deps,layout);}
        function commit(queue){const pending=queue.splice(0);for(const {i,fn,deps}of pending){slots[i]?.cleanup?.();slots[i]={deps,fn,cleanup:fn()};}}
        export function commitLayout(){commit(layout);}
        export function commitPassive(){commit(passive);}
        export function replay(){for(const slot of slots)if(slot?.fn){slot.cleanup?.();slot.cleanup=slot.fn();}}
        export function useSyncExternalStore(_subscribe,get){return get();}
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/mailbox/use-mailbox.ts") || id.endsWith("/features/mailbox/mailbox-notifications.tsx") || id.endsWith("/features/mailbox/mailbox-dialog.tsx"))
        return source.replace('from "react";', `from "${hooksId}";`).replace('from "sonner";', `from "${sonnerId}";`);
    },
  }] });
after(() => vite.close());
const { useMailbox } = await vite.ssrLoadModule("/features/mailbox/use-mailbox.ts");
const { MailboxNotifications } = await vite.ssrLoadModule("/features/mailbox/mailbox-notifications.tsx");
const { MailboxPanel, MailboxDialog } = await vite.ssrLoadModule("/features/mailbox/mailbox-dialog.tsx");
const { createMailboxSession } = await vite.ssrLoadModule("/features/mailbox/session.ts");
const hooks = await vite.ssrLoadModule(hooksId), toasts = await vite.ssrLoadModule(sonnerId);
const owner = "7K3P-2Q9M-W8ZR", other = "7K3P-2Q9M-W8ZS", id = "00000000-0000-4000-8000-000000000001", time = "2026-10-18T12:00:00Z";
const mailPage = (publicId = owner) => ({ ownerPublicId: publicId, unreadCount: 1, nextCursor: null, serverTime: time,
  messages: [{ id, type: "admin_notice", title: "Настоящее письмо", body: "private plaintext", createdAt: time, readAt: null, notify: true, attachments: null }],
  latestUnreadNotification: { id, createdAt: time } });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
let restore = () => {};
afterEach(async () => { hooks.reset(); await flush(); restore(); toasts.shown.length = toasts.dismissed.length = 0; });
function environment() {
  hooks.reset(); const descriptors = new Map(), events = new Map(), requests = [], intervals = new Map(), cache = new Map(); let focus = true, counter = 0;
  const install = (key, value) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); };
  const add = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, remove = (name, fn) => events.get(name)?.delete(fn);
  install("document", { hidden: false, hasFocus: () => focus, addEventListener: add, removeEventListener: remove });
  install("navigator", { onLine: true });
  install("window", { addEventListener: add, removeEventListener: remove, setInterval: fn => { intervals.set(++counter, fn); return counter; },
    clearInterval: key => intervals.delete(key), localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) } });
  install("fetch", (url, options) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError")); options.signal.addEventListener("abort", abort, { once: true });
    requests.push({ url, options, resolve: (value = mailPage(), status = 200) => { options.signal.removeEventListener("abort", abort); resolve(Response.json(value, { status })); } });
  }));
  restore = () => { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  const MailboxHook = props => { hooks.begin(); return useMailbox(props); };
  const commit = () => { hooks.commitLayout(); hooks.commitPassive(); };
  return { requests, intervals, cache, render: MailboxHook, commit, setFocus(value) { focus = value; }, fire(name) { for (const fn of events.get(name) ?? []) fn(); }, events };
}

test("the single hook aborts hidden, unfocused and offline work, then resumes one account polling lifecycle", async () => {
  const env = environment(), props = { ownerPublicId: owner, isOnline: true, enabled: true };
  env.render(props); env.commit(); await flush(); assert.equal(env.requests.length, 1); assert.equal(env.intervals.size, 1);
  document.hidden = true; env.fire("visibilitychange"); assert.equal(env.requests[0].options.signal.aborted, true);
  document.hidden = false; env.setFocus(false); env.fire("visibilitychange"); await flush(); assert.equal(env.requests.length, 1);
  env.setFocus(true); env.fire("focus"); await flush(); assert.equal(env.requests.length, 2);
  navigator.onLine = false; env.fire("offline"); assert.equal(env.requests[1].options.signal.aborted, true);
  navigator.onLine = true; env.fire("online"); await flush(); assert.equal(env.requests.length, 3);
  env.requests[2].resolve(); await flush(); assert.equal(env.render(props).unreadCount, 1);
  hooks.reset(); await flush(); assert.equal(env.intervals.size, 0);
  assert.equal([...env.events.values()].some(listeners => listeners.size), false);
});

test("an old account response in the layout-to-passive gap cannot log out or refresh the new account", async () => {
  const env = environment(); let lost = 0, received = 0;
  const props = { ownerPublicId: owner, isOnline: true, enabled: true, onSessionLost: () => lost++, onReceived: () => received++ };
  const old = env.render(props); env.commit(); await flush(); assert.equal(env.requests.length, 1);
  props.ownerPublicId = other;
  const next = env.render(props); hooks.commitLayout();
  old.open(); assert.equal(old.isActive(), false); assert.equal(old.isAvailable(), false); assert.equal(old.claimNotification(id), false);
  env.requests[0].resolve({ code: "UNAUTHORIZED", message: "Expired former account" }, 401); await flush();
  assert.equal(lost, 0); assert.equal(received, 0); assert.deepEqual(next.messages, []);
  hooks.commitPassive(); await flush(); assert.equal(env.requests.length, 2);
  env.requests[1].resolve(mailPage(other)); await flush(); assert.equal(env.render(props).ownerPublicId, other);
  assert.equal(env.render(props).messages[0].body, "private plaintext");
});

test("Strict Mode provisional effects do not consume a toast that never reached the interface", async () => {
  const env = environment(), storage = window.localStorage;
  const session = createMailboxSession(owner, { list: async () => mailPage(), read: async () => assert.fail() }, undefined, storage);
  const stop = session.activate(); await session.refresh();
  const mailbox = { ...session.getSnapshot(), ...session }, render = () => { hooks.begin(); MailboxNotifications({ mailbox }); hooks.commitPassive(); };
  try {
    render(); hooks.replay(); await flush();
    assert.equal(toasts.shown.length, 1); assert.equal(toasts.dismissed.length, 0);
    const tree = toasts.shown[0].render(), buttons = [];
    const visit = node => { if (!isValidElement(node)) return; if (node.type === "button") buttons.push(node); Children.forEach(node.props.children, visit); }; visit(tree);
    assert.equal(session.getSnapshot().opened, false); buttons.find(button => button.props.children === "Открыть почту").props.onClick();
    assert.equal(session.getSnapshot().opened, true); assert.equal(toasts.dismissed.length, 1);
    hooks.reset(); render(); await flush(); assert.equal(toasts.shown.length, 1, "remount and repeat GET cannot show the same alert again");
    assert.equal([...env.cache.values()].some(value => value.includes("private plaintext")), false);
  } finally { stop(); }
});

test("the mail notice opens during a polling availability transition, but never after owner disposal", async () => {
  environment();
  const session = createMailboxSession(owner, { list: async () => mailPage(), read: async () => assert.fail() }, undefined, window.localStorage);
  const stop = session.activate();
  try {
    await session.refresh();
    hooks.begin(); MailboxNotifications({ mailbox: { ...session.getSnapshot(), ...session } }); hooks.commitPassive(); await flush();
    const buttons = [];
    const visit = node => { if (!isValidElement(node)) return; if (node.type === "button") buttons.push(node); Children.forEach(node.props.children, visit); };
    visit(toasts.shown[0].render());
    const open = buttons.find(button => button.props.children === "Открыть почту").props.onClick;
    session.setAvailable(false); open();
    assert.equal(session.getSnapshot().opened, true, "a brief unavailable connection must not eat navigation");
    assert.equal(toasts.dismissed.length, 1);
    session.close(); stop(); open();
    assert.equal(session.getSnapshot().opened, false, "an old account's action remains inert");
    assert.equal(toasts.dismissed.length, 1);
  } finally { stop(); }
});

test("the rendered detail effect marks only the letter that is actually open, while inbox rows remain unread", async () => {
  environment(); const reads = [], session = createMailboxSession(owner, { list: async () => mailPage(), read: async messageId => {
    reads.push(messageId); return { ownerPublicId: owner, id: messageId, readAt: time, unreadCount: 0, serverTime: time };
  } }); const stop = session.activate();
  try {
    await session.refresh(); session.open(); await session.refresh();
    hooks.begin(); MailboxPanel({ mailbox: { ...session.getSnapshot(), ...session } }); hooks.commitPassive();
    assert.equal(reads.length, 0); session.select(id);
    hooks.begin(); const detail = MailboxPanel({ mailbox: { ...session.getSnapshot(), ...session } });
    assert.equal(detail.type.name, "MailLetter"); assert.equal(detail.props.message.id, id); assert.equal(reads.length, 0);
    hooks.commitPassive(); await flush(); assert.deepEqual(reads, [id]);
  } finally { stop(); }
});

test("Escape returns from an actual letter to its list row and account disposal prevents foreign focus restoration", async () => {
  environment(); const session = createMailboxSession(owner, { list: async () => mailPage(), read: async () => assert.fail() });
  const stop = session.activate(), focused = [], frames = [];
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"), previousFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  class Element { constructor(name) { this.name = name; this.isConnected = true; } focus() { focused.push(this.name); } }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Element });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: fn => frames.push(fn) });
  const trigger = new Element("original-trigger"), heading = new Element("mail-heading"), letter = new Element("letter-title"), row = new Element("restored-row");
  document.activeElement = trigger; document.getElementById = () => letter; document.querySelector = () => row;
  try {
    await session.refresh(); session.open(); await session.refresh(); session.select(id);
    hooks.begin(); const tree = MailboxDialog({ mailbox: { ...session.getSnapshot(), ...session } });
    const nodes = []; const walk = node => { if (!isValidElement(node)) return; nodes.push(node); Children.forEach(node.props.children, walk); }; walk(tree);
    nodes.find(node => node.props.tabIndex === -1).props.ref.current = heading;
    const content = nodes.find(node => node.props["data-slot"] === "dialog-content");
    content.props.onOpenAutoFocus({ preventDefault() {} }); hooks.commitPassive();
    assert.deepEqual(focused, ["mail-heading", "letter-title"]);
    let prevented = false;
    content.props.onEscapeKeyDown({ preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true); assert.equal(session.getSnapshot().selected, null); assert.equal(session.getSnapshot().opened, true);
    frames.splice(0).forEach(fn => fn()); assert.equal(focused.at(-1), "restored-row");
    stop(); const before = focused.length; content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(focused.length, before, "cleanup cannot focus an element after its owning account has left");
  } finally {
    stop(); if (previousElement) Object.defineProperty(globalThis, "HTMLElement", previousElement); else delete globalThis.HTMLElement;
    if (previousFrame) Object.defineProperty(globalThis, "requestAnimationFrame", previousFrame); else delete globalThis.requestAnimationFrame;
  }
});
