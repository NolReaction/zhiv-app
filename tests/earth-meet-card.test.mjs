import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooks = "virtual:earth-meet-card-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  plugins: [{ name: "earth-meet-card-scoped-hooks", enforce: "pre",
    resolveId(id) { if (id === hooks) return "\0" + hooks; },
    load(id) { if (id === "\0" + hooks) return "export const useRef=value=>({current:value});export const useEffect=()=>{};export const useState=value=>[value,()=>{}];"; },
    transform(source, id) { if (id.endsWith("/features/earth/earth-meet-card.tsx")) return source.replace('from "react";', `from "${hooks}";`); },
  }], server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthMeetCard, EarthWalkingRouteOptions, formatMeetDistance, formatMeetLocationUpdate } = await vite.ssrLoadModule("/features/earth/earth-meet-card.tsx");
const wall = Date.parse("2026-10-20T12:00:00Z"), mono = 10_000;
const from = { latitude: 55.751234, longitude: 37.621234, accuracy: 15, timestamp: wall };
const friend = (extra = {}) => ({ circleId: "shared-friend", user: { publicId: "PRIVATE-FRIEND-ID", displayName: "Друг" },
  latitude: 55.761234, longitude: 37.631234, accuracyMeters: 20, precision: "PRECISE",
  updatedAt: new Date(wall).toISOString(), expiresAt: new Date(wall + 3_600_000).toISOString(),
  expiresAtMonotonic: mono + 3_600_000, ...extra });
function elements(tree) {
  const result = [];
  const walk = node => { if (!isValidElement(node)) return; if (node.type === EarthWalkingRouteOptions) { walk(EarthWalkingRouteOptions(node.props)); return; } result.push(node); Children.forEach(node.props.children, walk); };
  walk(tree); return result;
}
function render(extra = {}) {
  const calls = [];
  const tree = EarthMeetCard({ person: friend(), name: "Лена", position: from, now: wall, monotonicNow: mono, locating: false,
    onLocate: () => calls.push("locate"), onShowBoth: () => calls.push("both"), onClose: () => calls.push("close"), ...extra });
  return { tree, calls, nodes: elements(tree), html: renderToStaticMarkup(tree) };
}
const control = (view, label) => view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes(label));

test("atlas meeting notes require an explicit click and revalidate freshness after a sleeping tab", t => {
  let now = wall, clock = mono, recorded = 0;
  t.mock.method(Date, "now", () => now); t.mock.method(performance, "now", () => clock);
  const to = friend({ latitude: from.latitude, longitude: from.longitude });
  const view = render({ person: to, onRecordMeeting: () => { recorded++; } });
  assert.equal(recorded, 0);
  const button = control(view, "Отметить встречу в атласе"); assert.ok(button);
  button.props.onClick(); assert.equal(recorded, 1);
  now += 60_001; clock += 60_001;
  button.props.onClick(); assert.equal(recorded, 1, "an old rendered control cannot record stale proximity");
  const hidden = render({ person: to, onRecordMeeting: () => {}, locationAllowed: false });
  assert.equal(control(hidden, "Отметить встречу в атласе"), undefined);
  const done = render({ person: to, onRecordMeeting: () => {}, meetingRecorded: true });
  assert.equal(control(done, "Встреча отмечена в атласе").props.disabled, true);
});

test("fresh meeting card describes straight-line distance and offers a closed map chooser before external navigation", () => {
  const view = render({ name: "<script>Лена</script>" });
  assert.match(view.html, /по прямой/); assert.match(view.html, /Только что/);
  assert.match(view.html, /Выбери карты/); assert.match(view.html, /&lt;script&gt;Лена&lt;\/script&gt;/);
  assert.doesNotMatch(view.html, /<script>|PRIVATE-FRIEND-ID|55\.751234|37\.621234|origin=/);
  assert.equal(view.nodes.some(node => node.type === "details"), false);
  assert.match(view.html, /aria-haspopup="dialog"/); assert.match(view.html, /aria-expanded="false"/);
  assert.doesNotMatch(view.html, /www.google.com|maps.apple.com|yandex.ru/);
  const anchors = view.nodes.filter(node => node.type === "a");
  assert.deepEqual(anchors.map(node => node.props.children[0]), ["Яндекс Карты", "2ГИС", "Google Карты", "Apple Карты"]);
  const anchor = anchors.find(node => node.props.children[0] === "Google Карты"); assert.ok(anchor);
  const url = new URL(anchor.props.href);
  assert.equal(url.origin, "https://www.google.com"); assert.equal(url.searchParams.get("destination"), "55.761234,37.631234");
  assert.equal(url.searchParams.get("travelmode"), "walking"); assert.equal(url.searchParams.has("origin"), false);
  assert.equal(anchor.props.target, "_blank"); assert.equal(anchor.props.rel, "noopener noreferrer");
  assert.equal(anchor.props.referrerPolicy, "no-referrer");
  assert.doesNotMatch(view.html.replace(/<a\b[^>]*>/g, "<a>"), /55\.761234|37\.631234|latitude|longitude/);
  assert.deepEqual(view.calls, [], "Rendering never opens routes, acquires GPS or changes sharing");
  control(view, "Мы на карте").props.onClick(); assert.deepEqual(view.calls, ["both"]);
});

test("approximate or old friend points retain honest distance without a fabricated walking route or ETA", () => {
  for (const person of [friend({ precision: "APPROXIMATE", accuracyMeters: 1500 }),
    friend({ updatedAt: new Date(wall - 15 * 60_000).toISOString() })]) {
    const view = render({ person });
    assert.match(view.html, /по прямой/);
    assert.equal(view.nodes.some(node => node.type === "a"), false);
    assert.doesNotMatch(view.html, /google\.com|55\.761234|37\.631234|(?:идти|ходьбы|пешком)\s*\d|\d+\s*мин\.?\s*(?:пешком|ходьбы|в пути)/);
    assert.match(view.html, /примерным районом|Точка друга старше 5 минут/);
    assert.equal(control(view, "Внешние карты").props.disabled, true);
  }
});

test("expired and revoked friend points never keep meeting controls or an external destination", () => {
  for (const person of [null, friend({ expiresAtMonotonic: mono }), friend({ expiresAt: new Date(wall).toISOString() })]) {
    const view = render({ person });
    assert.match(view.html, /Геопозиция больше недоступна/);
    assert.equal(view.nodes.some(node => node.type === "a"), false);
    assert.equal(control(view, "Найти меня"), undefined); assert.equal(control(view, "Мы на карте"), undefined);
    assert.doesNotMatch(view.html, /55\.761234|37\.631234|≈|по прямой/);
  }
});

test("missing or stale own GPS requests a private lookup while valid friend routing never embeds an origin", () => {
  for (const position of [null, { ...from, timestamp: wall - 60_001 }]) {
    const view = render({ position });
    assert.match(view.html, position ? /Нужна свежая геопозиция/ : /Расстояние — после поиска тебя/); assert.doesNotMatch(view.html, /по прямой/);
    assert.ok(control(view, "Найти меня")); assert.deepEqual(view.calls, []);
    control(view, "Найти меня").props.onClick(); assert.deepEqual(view.calls, ["locate"]);
    assert.equal(new URL(view.nodes.find(node => node.type === "a" && node.props.children[0] === "Google Карты").props.href).searchParams.has("origin"), false);
  }
  const requesting = render({ position: null, locating: true });
  assert.match(requesting.html, /Ищем тебя/); assert.equal(control(requesting, "Найти меня").props.disabled, true);
});

test("sleeping-tab route clicks revalidate wall and monotonic deadlines before exporting a destination", t => {
  const view = render();
  const anchors = view.nodes.filter(node => node.type === "a"); assert.equal(anchors.length, 4);
  let now = wall, clock = mono;
  t.mock.method(Date, "now", () => now); t.mock.method(performance, "now", () => clock);
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  for (const anchor of anchors) { const fresh = event(); anchor.props.onClick(fresh); assert.equal(fresh.prevented, false); }
  now = wall + 300_001;
  for (const anchor of anchors) { const stale = event(); anchor.props.onClick(stale); assert.equal(stale.prevented, true); }
  now = wall; clock = mono + 3_600_000;
  for (const anchor of anchors) { const expired = event(); anchor.props.onClick(expired); assert.equal(expired.prevented, true); }
  assert.deepEqual(view.calls, [], "Opening the external provider never starts our GPS or publication");
});

test("close and Escape are explicit, and uncertain or degenerate bearings never claim a reliable heading", () => {
  const view = render({ person: friend({ latitude: from.latitude, longitude: from.longitude, accuracyMeters: 1500, precision: "APPROXIMATE" }) });
  assert.match(view.html, /в пределах точности GPS/);
  control(view, "Закрыть встречу").props.onClick();
  const escape = { key: "Escape", stopped: false, stopPropagation() { this.stopped = true; } };
  view.tree.props.onKeyDown(escape); assert.equal(escape.stopped, true); assert.deepEqual(view.calls, ["close", "close"]);
  const antipodal = render({ position: { latitude: 0, longitude: 0, accuracy: 10, timestamp: wall }, person: friend({ latitude: 0, longitude: 180 }) });
  assert.doesNotMatch(antipodal.html, /в пределах точности GPS/);
  assert.match(antipodal.html, /направление не определено/i);
});

test("distance formatting uses coarse meters or kilometers without inventing travel time", () => {
  assert.equal(formatMeetDistance(127), "130 м"); assert.equal(formatMeetDistance(2350), "2,4 км");
  assert.equal(formatMeetDistance(12_300), "12 км");
});


test("global location disable blocks private lookup while leaving explicitly selected destination-only routes available", () => {
  const view = render({ locationAllowed: false, position: null });
  assert.match(view.html, /Геопозиция отключена/);
  assert.equal(control(view, "Найти меня").props.disabled, true);
  control(view, "Найти меня").props.onClick();
  assert.deepEqual(view.calls, []);
  assert.equal(view.nodes.filter(node => node.type === "a").length, 4);
});


test("the separate chooser handles Escape without forwarding it to the meeting card", () => {
  const view = render();
  const chooser = view.nodes.find(node => typeof node.props.onEscapeKeyDown === "function");
  assert.ok(chooser); assert.equal(chooser.props.side, "top"); assert.equal(chooser.props.collisionPadding, 12);
  let stopped = false; chooser.props.onEscapeKeyDown({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.deepEqual(view.calls, []);
  view.tree.props.onKeyDown({ key: "Escape", stopPropagation() {} }); assert.deepEqual(view.calls, ["close"]);
});

test("a walking route has a direct explicit action and uses the returned distance and duration", () => {
  let built = 0, cleared = 0;
  const props = { onBuildWalkingRoute: () => { built++; }, onClearWalkingRoute: () => { cleared++; } };
  const idle = render({ ...props, walkingRoute: { status: "idle", route: null, error: null, canRequest: true } });
  assert.equal(built, 0); assert.match(idle.html, /по прямой/);
  const build = control(idle, "Пешком на этой карте"); assert.ok(build); assert.equal(build.props.disabled, false);
  const popup = idle.nodes.find(node => typeof node.props.onEscapeKeyDown === "function");
  assert.equal(elements(popup).includes(build), false, "the action is visible without opening the external-map chooser");
  build.props.onClick(); assert.equal(built, 1);
  const route = { distanceMeters: 2_350, durationSeconds: 1060 };
  const ready = render({ ...props, walkingRoute: { status: "ready", route, error: null, canRequest: true } });
  assert.match(ready.html, /2,4 км/); assert.match(ready.html, /Пешком · ≈18 мин/); assert.doesNotMatch(ready.html, /по прямой/);
  assert.ok(control(ready, "Обновить на карте"));
  ready.nodes.find(node => node.type === "button" && node.props["aria-label"] === "Убрать пеший маршрут с карты").props.onClick();
  assert.equal(cleared, 1); assert.equal(built, 1);
});

test("walking-route loading, no self fix and failures stay secondary while external destination maps remain available", () => {
  let built = 0;
  for (const status of ["idle", "loading", "error"]) {
    const result = render({ position: status === "idle" ? null : from, onBuildWalkingRoute: () => { built++; },
      walkingRoute: { status, route: null, canRequest: false, error: status === "error" ? "Сервис маршрутов недоступен" : null } });
    const build = control(result, status === "loading" ? "Строим пеший маршрут…" : "Пешком на этой карте");
    assert.equal(build.props.disabled, true); build.props.onClick();
    assert.equal(result.nodes.filter(node => node.type === "a").length, 4);
    assert.match(result.html, /две точки отправятся OSRM\/FOSSGIS/);
    if (status === "idle") assert.match(result.html, /Сначала дождись своей геопозиции/);
    if (status === "loading") assert.match(result.html, /Строим пеший маршрут/);
    if (status === "error") assert.match(result.html, /Сервис маршрутов недоступен/);
  }
  assert.equal(built, 0);
});

test("actual capture time, age and GPS accuracy explain a retained friend's point", () => {
  const capturedAt = wall - 17 * 60_000;
  const view = render({ person: friend({ updatedAt: new Date(capturedAt).toISOString(), accuracyMeters: 625 }) });
  const expectedTime = new Date(capturedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  assert.match(view.html, /Последняя точка друга/);
  assert.ok(view.html.includes(`<time dateTime="${new Date(capturedAt).toISOString()}">${expectedTime}</time>`));
  assert.match(view.html, /17 мин\. назад/); assert.match(view.html, /±625 м/);
  assert.match(view.html, /по прямой до последней точки/);
  assert.equal(formatMeetLocationUpdate(Number.NaN, wall), null);
  assert.equal(formatMeetLocationUpdate(1e20, wall), null);
});

test("paused and failed GPS markers are labelled last-known until an active fresh fix arrives", () => {
  const walkingRoute = { status: "idle", route: null, error: null, canRequest: true };
  for (const locationStatus of ["paused", "timeout", "unavailable"]) {
    const view = render({ locationStatus, walkingRoute, onBuildWalkingRoute() {} });
    assert.match(view.html, /Твоя последняя точка/); assert.match(view.html, /Нужна свежая геопозиция/);
    assert.doesNotMatch(view.html, /по прямой/);
    assert.equal(control(view, "Пешком на этой карте").props.disabled, true);
    assert.equal(control(view, "Внешние карты").props.disabled, false, "destination-only routes do not require our GPS");
  }
  const resumed = render({ locationStatus: "active", walkingRoute, onBuildWalkingRoute() {} });
  assert.match(resumed.html, /по прямой/); assert.doesNotMatch(resumed.html, /Твоя последняя точка/);
  assert.equal(control(resumed, "Пешком на этой карте").props.disabled, false);
});

test("coarse, stale and newly fresh GPS updates change route readiness without replacing the selected friend", () => {
  let built = 0;
  const base = { walkingRoute: { status: "idle", route: null, error: null, canRequest: true }, onBuildWalkingRoute() { built++; } };
  for (const [patch, reason] of [[{ accuracyMeters: 700 }, /GPS друга пока неточен/],
    [{ updatedAt: new Date(wall - 301_000).toISOString() }, /Точка друга старше 5 минут/],
    [{ precision: "APPROXIMATE" }, /примерным районом/]]) {
    const blocked = render({ ...base, person: friend(patch) });
    assert.match(blocked.html, reason); assert.equal(control(blocked, "Пешком на этой карте").props.disabled, true);
    control(blocked, "Пешком на этой карте").props.onClick();
  }
  const ready = render({ ...base, person: friend() });
  assert.equal(control(ready, "Пешком на этой карте").props.disabled, false);
  assert.equal(control(ready, "Внешние карты").props.disabled, false);
  assert.equal(built, 0, "point updates do not request routes");
  control(ready, "Пешком на этой карте").props.onClick(); assert.equal(built, 1);
});

test("Kazan to Petersburg explains the local walking distance limit while offering external maps directly", () => {
  const view = render({ position: { ...from, latitude: 55.796, longitude: 49.106 },
    person: friend({ latitude: 59.939, longitude: 30.315 }),
    walkingRoute: { status: "idle", route: null, error: null, canRequest: false }, onBuildWalkingRoute() {} });
  assert.match(view.html, /по прямой/); assert.match(view.html, /до 20 км по прямой/);
  assert.equal(control(view, "Пешком на этой карте").props.disabled, true);
  assert.equal(control(view, "Внешние карты").props.disabled, false);
  assert.equal(view.nodes.filter(node => node.type === "a").length, 4);
  assert.doesNotMatch(view.html, /Пешком ·|нужны сеть и свежие/i);
});

test("offline route status names the missing connection and never starts a provider request", () => {
  let built = 0;
  const view = render({ online: false, walkingRoute: { status: "idle", route: null, error: null, canRequest: false }, onBuildWalkingRoute() { built++; } });
  assert.match(view.html, /Нет сети/); assert.equal(control(view, "Пешком на этой карте").props.disabled, true);
  control(view, "Пешком на этой карте").props.onClick(); assert.equal(built, 0);
});
