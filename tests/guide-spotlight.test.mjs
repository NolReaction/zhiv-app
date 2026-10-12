import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { measureGuideSpotlight } = await vite.ssrLoadModule("/features/onboarding/guide-spotlight.ts");
const viewport = { left: 0, top: 0, width: 1000, height: 800 };
const getStyle = element => element.style;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function element(bounds, options = {}) {
  return {
    bounds, parentElement: null, clientLeft: 0, clientTop: 0, clientWidth: bounds.width, clientHeight: bounds.height,
    offsetWidth: bounds.width, offsetHeight: bounds.height,
    style: { overflowX: "visible", overflowY: "visible", borderRadius: "12px", visibility: "visible", ...options.style },
    getBoundingClientRect() { return this.bounds; },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== "style")),
  };
}
const measure = target => measureGuideSpotlight(target, viewport, getStyle);
const bounds = value => value && { left: value.left, top: value.top, width: value.width, height: value.height };

test("coach placement ignores a menu item scrolled out of its panel and tracks it again on return", () => {
  const panel = element(rect(100, 200, 240, 300), { style: { overflowY: "auto" } });
  const target = element(rect(120, 240, 200, 44), { parentElement: panel });
  assert.deepEqual(bounds(measure(target)), { left: 115, top: 235, width: 210, height: 54 });
  target.bounds = rect(120, 150, 200, 44);
  assert.equal(measure(target), null, "inside the screen but above the scrollport is not visible");
  target.bounds = rect(120, 500, 200, 44);
  assert.equal(measure(target), null, "below the scrollport is not visible either");
  target.bounds = rect(120, 240, 200, 44);
  assert.deepEqual(bounds(measure(target)), { left: 115, top: 235, width: 210, height: 54 });
});

test("partly visible target bounds and their coach clearance stay within the panel client area", () => {
  const panel = element(rect(100, 200, 240, 300), { clientLeft: 4, clientTop: 6, clientWidth: 215, clientHeight: 280,
    style: { overflowX: "hidden", overflowY: "scroll" } });
  const target = element(rect(101, 190, 235, 44), { parentElement: panel });
  const partial = measure(target);
  assert.deepEqual(bounds(partial), { left: 104, top: 206, width: 215, height: 33 });
  target.bounds = rect(110, 470, 190, 44);
  assert.deepEqual(bounds(measure(target)), { left: 105, top: 465, width: 200, height: 21 });
  target.bounds = rect(110, 162, 190, 44);
  assert.equal(measure(target), null, "padding cannot leave a ghost when the button ends exactly at the clip edge");
});

test("nested clipping applies each overflow axis independently", () => {
  const outer = element(rect(180, 10, 90, 70), { style: { overflowX: "clip" } });
  const inner = element(rect(50, 250, 700, 100), { parentElement: outer, style: { overflowY: "hidden" } });
  const target = element(rect(150, 270, 180, 50), { parentElement: inner });
  assert.deepEqual(bounds(measure(target)), { left: 180, top: 265, width: 90, height: 60 },
    "outer Y is visible and inner X is visible, so neither may clip that axis");
  inner.bounds = rect(50, 330, 700, 100);
  assert.equal(measure(target), null);
});

test("visible overflow is allowed and non-clipping ancestors do not shrink the highlight", () => {
  const parent = element(rect(1, 1, 10, 10));
  const target = element(rect(100, 150, 80, 44), { parentElement: parent });
  assert.deepEqual(bounds(measure(target)), { left: 95, top: 145, width: 90, height: 54 });
});

test("scaled client borders and scrollbars are converted into viewport coordinates", () => {
  const panel = element(rect(100, 200, 400, 240), { offsetWidth: 200, offsetHeight: 120,
    clientLeft: 3, clientTop: 4, clientWidth: 180, clientHeight: 100, style: { overflowX: "auto", overflowY: "auto" } });
  const target = element(rect(100, 202, 400, 30), { parentElement: panel });
  assert.deepEqual(bounds(measure(target)), { left: 106, top: 208, width: 360, height: 29 });
});

test("visual viewport offsets, absent targets and hidden targets keep their prior behavior", () => {
  const target = element(rect(20, 30, 100, 100));
  const view = { left: 40, top: 50, width: 300, height: 400 };
  assert.deepEqual(bounds(measureGuideSpotlight(target, view, getStyle)), { left: 43, top: 53, width: 82, height: 82 });
  assert.equal(measure(null), null);
  target.style.visibility = "hidden";
  assert.equal(measure(target), null);
  target.style.visibility = "visible";
  target.bounds = rect(20, 30, 0, 44);
  assert.equal(measure(target), null);
});


test("hidden or transparent ancestor removes a spotlight despite a retained layout rectangle", () => {
  const parent = element(rect(0, 0, 300, 300));
  const target = element(rect(50, 100, 120, 44), { parentElement: parent });
  for (const [property, value] of [["opacity", "0"], ["display", "none"], ["visibility", "hidden"]]) {
    parent.style[property] = value;
    assert.equal(measure(target), null, property);
    delete parent.style[property];
  }
  target.closest = () => parent;
  assert.equal(measure(target), null, "inert and aria-hidden modal ancestors suppress the highlight");
});
