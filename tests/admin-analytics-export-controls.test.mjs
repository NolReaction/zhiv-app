import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:export-control-hooks", clientId = "virtual:export-control-client";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "export-controls-runtime", enforce: "pre",
    resolveId(id) { if ([hooksId, clientId].includes(id)) return `\0${id}`; },
    load(id) {
      if (id === `\0${hooksId}`) return `
        let slots = [], cursor = 0, effects = [];
        export function reset() { for (const slot of slots) slot?.cleanup?.(); slots = []; cursor = 0; effects = []; }
        export function begin() { cursor = 0; effects = []; }
        export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, next => { slots[i].value = typeof next === "function" ? next(slots[i].value) : next; }]; }
        export function useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; }
        export function useLayoutEffect(callback, deps) { const i = cursor++, previous = slots[i]?.deps; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) effects.push({ i, callback, deps }); }
        export function commit() { const pending = effects; effects = []; for (const { i, callback, deps } of pending) { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } }
      `;
      if (id === `\0${clientId}`) return `
        export const requests = [], downloads = [];
        export function reset() { requests.length = 0; downloads.length = 0; }
        export function isExactAdminPlayerId(value) { return /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/i.test(value.trim()); }
        export function loadAdminAnalyticsExport(actor, filters, format, signal, progress) { return new Promise((resolve, reject) => requests.push({ actor, filters, format, signal, progress, resolve, reject })); }
        export function downloadAdminAnalyticsExport(result) { downloads.push(result); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/admin/admin-analytics-export-controls.tsx")) return source
        .replace('from "react";', `from "${hooksId}";`)
        .replace('from "./admin-analytics-export";', `from "${clientId}";`);
    },
  }],
});
after(() => vite.close());
const { AdminAnalyticsExportControls } = await vite.ssrLoadModule("/features/admin/admin-analytics-export-controls.tsx");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const hooks = await vite.ssrLoadModule(hooksId), client = await vite.ssrLoadModule(clientId);
afterEach(() => { hooks.reset(); client.reset(); });
const actor = "7K3P-2Q9M-W8ZR", player = "7K3P-2Q9M-W8ZS", snapshotAt = "2026-10-25T18:34:02Z";
const filters = () => ({ from: "2026-10-01", to: "2026-10-25", q: player, scope: "players", kind: "sell", resource: "wood", direction: "out", allTime: false });
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function childrenText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenText).join("");
  return node?.props ? childrenText(node.props.children) : "";
}
function setup(extra = {}) {
  hooks.reset(); client.reset(); const accessErrors = [];
  const props = { actorPublicId: actor, filters: filters(), disabled: false, onAccessLost: error => accessErrors.push(error), ...extra };
  function render() {
    hooks.begin(); const tree = AdminAnalyticsExportControls(props); hooks.commit(); const elements = [];
    function walk(node) { if (!isValidElement(node)) return; elements.push(node); Children.forEach(node.props.children, walk); }
    walk(tree);
    return { tree, elements, text: childrenText(tree), button: text => elements.find(node => node.type === "button" && childrenText(node) === text) };
  }
  return { props, render, accessErrors };
}
const result = (filename = "all-operations.csv", count = 2001) => ({ blob: new Blob(["complete"]), filename, count, snapshotAt, filters: filters() });

test("complete export keeps selected filters, shows total progress and downloads once after all pages", async () => {
  const app = setup(), initial = app.render(), original = structuredClone(app.props.filters);
  initial.button("CSV всех операций").props.onClick(); initial.button("CSV всех операций").props.onClick();
  assert.equal(client.requests.length, 1, "a retained double click cannot start another export");
  const request = client.requests[0]; assert.equal(request.actor, actor); assert.equal(request.format, "csv");
  assert.deepEqual(request.filters, original); assert.deepEqual(app.props.filters, original);
  let view = app.render();
  assert.equal(view.button("CSV всех операций").props.disabled, true); assert.equal(view.button("JSON для анализа").props.disabled, true);
  request.progress({ completed: 1000, total: 2001 }); view = app.render();
  assert.match(view.text, /Загружено 1.000 из 2.001 операций/);
  assert.equal(view.elements.find(node => node.type === "progress").props.value, 1000);
  const complete = result(); request.resolve(complete); await tick(); view = app.render();
  assert.deepEqual(client.downloads, [complete]); assert.match(view.text, /Выгружено 2.001 операций/);
  assert.equal(view.button("CSV всех операций").props.disabled, false);
});

test("full player history ignores date and operation filters explicitly and requests every resource", async () => {
  const app = setup({ filters: { ...filters(), q: ` ${player.toLowerCase()} ` } }); let view = app.render();
  view.elements.find(node => node.type === "select").props.onChange({ target: { value: "player" } }); view = app.render();
  assert.match(view.text, /Вся сохранённая история журнала игрока/); assert.match(view.text, /независимо от выбранных дат и остальных фильтров/);
  assert.doesNotMatch(view.text, /0001/);
  view.button("JSON для анализа").props.onClick();
  const request = client.requests[0]; assert.equal(request.format, "json");
  assert.deepEqual(request.filters, { ...filters(), q: player, scope: "all", kind: "", resource: "", direction: "all", allTime: true });
  request.resolve(result("player-history.json", 0)); await tick(); view = app.render();
  assert.equal(client.downloads[0].count, 0, "an empty current period does not prohibit an all-time file");
  assert.match(view.text, /Выгружено 0 операций/);
});

test("name searches explain exact player selection and do not enable all-time history", () => {
  const app = setup({ filters: { ...filters(), q: "Михаил" } }), view = app.render();
  assert.equal(view.elements.find(node => node.type === "option" && node.props.value === "player").props.disabled, true);
  assert.match(view.text, /укажите его точный ID/);
  assert.equal(view.button("CSV всех операций").props.disabled, false);
});

test("cancel aborts immediately and discarded late progress/completion cannot download or override a retry", async () => {
  const app = setup(); app.render().button("CSV всех операций").props.onClick();
  const first = client.requests[0]; app.render().button("Отменить выгрузку").props.onClick();
  assert.equal(first.signal.aborted, true); assert.match(app.render().text, /Выгрузка отменена/);
  first.progress({ completed: 2001, total: 2001 }); assert.match(app.render().text, /Выгрузка отменена/);
  app.render().button("JSON для анализа").props.onClick(); const retry = client.requests[1];
  first.resolve(result("stale.csv")); await tick();
  assert.equal(client.downloads.length, 0); assert.ok(app.render().button("Отменить выгрузку"));
  retry.resolve(result("retry.json")); await tick();
  assert.deepEqual(client.downloads.map(value => value.filename), ["retry.json"]);
});

test("layout unmount invalidates retained handlers and late completion before any download", async () => {
  const app = setup(), initial = app.render(); initial.button("CSV всех операций").props.onClick();
  const request = client.requests[0]; hooks.reset();
  assert.equal(request.signal.aborted, true);
  initial.button("JSON для анализа").props.onClick(); assert.equal(client.requests.length, 1);
  request.resolve(result()); await tick(); assert.equal(client.downloads.length, 0);
});

test("access loss closes the operation without saving a partial file", async () => {
  const app = setup(); app.render().button("CSV всех операций").props.onClick();
  const request = client.requests[0], error = new ApiError("Доступ администратора потерян", 403);
  request.reject(error); await tick(); const view = app.render();
  assert.equal(request.signal.aborted, true); assert.deepEqual(app.accessErrors, [error]);
  assert.equal(client.downloads.length, 0); assert.match(view.text, /Доступ администратора потерян/);
  assert.match(view.text, /Неполный файл не сохраняется/);
});

test("changed history errors are explicit and retry starts a new complete export", async () => {
  const app = setup(); app.render().button("CSV всех операций").props.onClick();
  client.requests[0].reject(new ApiError("История изменилась во время выгрузки", 409)); await tick();
  assert.match(app.render().text, /История изменилась/); assert.equal(client.downloads.length, 0);
  app.render().button("CSV всех операций").props.onClick();
  assert.equal(client.requests.length, 2); client.requests[1].resolve(result()); await tick();
  assert.equal(client.downloads.length, 1);
});

test("blocked unapplied or loading filters cannot start an export even through a retained click", () => {
  const app = setup({ disabled: true }), view = app.render();
  assert.equal(view.button("CSV всех операций").props.disabled, true);
  view.button("CSV всех операций").props.onClick(); assert.equal(client.requests.length, 0);
});
