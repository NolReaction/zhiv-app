import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthSatelliteVisuals } = await vite.ssrLoadModule("/features/earth/satellite-visuals.ts");
const RASTER = "earth-satellite-imagery";
const building = (values = {}) => ({ id: "earth-buildings", paint: { "fill-color": "tan", ...values }, layout: {} });
const extrusion = (values = {}, visibility = "visible") => ({ id: "earth-buildings-3d",
  paint: { "fill-extrusion-color": "tan", "fill-extrusion-opacity": 1, ...values }, layout: { visibility } });
const night = () => ({ id: "earth-evening-shade", layout: {} });
const instant = { duration: 0, delay: 0 };
function harness() {
  const layers = new Map([building(), extrusion(), night(), { id: "earth-roads", paint: { "line-opacity": 1 } },
    { id: "earth-city-names", paint: { "text-opacity": 1 } }, { id: "earth-accuracy-fill", paint: { "fill-opacity": 0.16 } },
    { id: "earth-meet-line", paint: { "line-opacity": 0.8 } }].map(layer => [layer.id, layer]));
  const listeners = new Map(), calls = [];
  const emit = () => { for (const callback of [...listeners.get("styledata") ?? []]) callback(); };
  const map = {
    getLayer: id => layers.get(id),
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    off(type, callback) { listeners.get(type)?.delete(callback); },
    getPaintProperty: (id, name) => layers.get(id).paint[name],
    setPaintProperty(id, name, value) { calls.push(["paint", id, name, value]);
      if (value === undefined || value === null) delete layers.get(id).paint[name]; else layers.get(id).paint[name] = value; emit(); },
    getLayoutProperty: (id, name) => layers.get(id).layout[name],
    setLayoutProperty(id, name, value) { calls.push(["layout", id, name, value]);
      if (value === undefined || value === null) delete layers.get(id).layout[name]; else layers.get(id).layout[name] = value; emit(); },
  };
  const controller = createEarthSatelliteVisuals(map, RASTER);
  return { controller, map, layers, calls, listeners, emit,
    raster() { layers.set(RASTER, { id: RASTER }); },
    paint: (id, name) => map.getPaintProperty(id, name),
    layout: (id, name) => map.getLayoutProperty(id, name),
  };
}

test("visual suppression requires an installed raster and leaves roads, labels and game geometry intact", () => {
  const h = harness(), original = structuredClone([...h.layers]);
  h.controller.setActive(true); assert.deepEqual([...h.layers], original); assert.equal(h.calls.length, 0);
  h.raster(); h.emit();
  assert.equal(h.paint("earth-buildings", "fill-opacity"), 0);
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 0);
  assert.equal(h.layout("earth-evening-shade", "visibility"), "none");
  assert.deepEqual(h.paint("earth-buildings", "fill-opacity-transition"), instant);
  assert.deepEqual(h.paint("earth-buildings-3d", "fill-extrusion-opacity-transition"), instant);
  assert.ok(h.calls.every(([, id]) => ["earth-buildings", "earth-buildings-3d", "earth-evening-shade"].includes(id)));
  const count = h.calls.length; h.emit(); h.controller.setActive(true); assert.equal(h.calls.length, count, "no update loop or redundant paint writes");
  h.controller.setActive(false); h.layers.delete(RASTER);
  assert.deepEqual([...h.layers], original, "implicit defaults return without explicit opacity/visibility overrides"); h.controller.dispose();
});

test("opacity expressions and transition settings restore exactly without changing the user's 3D visibility", () => {
  const h = harness();
  const expression = ["interpolate", ["linear"], ["zoom"], 14, 0.4, 17, 0.85];
  const transition = { duration: 600, delay: 30 };
  h.layers.set("earth-buildings", building({ "fill-opacity": expression, "fill-opacity-transition": transition }));
  h.layers.set("earth-buildings-3d", extrusion({ "fill-extrusion-opacity": 0.7 }, "none"));
  const original = structuredClone([...h.layers]);
  h.raster(); h.controller.setActive(true);
  assert.equal(h.layout("earth-buildings-3d", "visibility"), "none");
  h.map.setLayoutProperty("earth-buildings-3d", "visibility", "visible");
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 0, "a pointer toggle cannot reveal buildings above imagery");
  h.map.setLayoutProperty("earth-buildings-3d", "visibility", "none");
  h.controller.setActive(false); h.layers.delete(RASTER);
  assert.deepEqual([...h.layers], original); h.controller.dispose();
});

test("updates while imagery is active preserve current paint and model-mask settings on restoration", () => {
  const h = harness(); h.raster(); h.controller.setActive(true);
  const updated = ["interpolate", ["linear"], ["zoom"], 14, 0.3, 18, 0.9];
  h.map.setPaintProperty("earth-buildings", "fill-opacity", updated);
  assert.equal(h.paint("earth-buildings", "fill-opacity"), 0);
  h.map.setPaintProperty("earth-buildings", "fill-opacity-transition", { duration: 800, delay: 40 });
  assert.deepEqual(h.paint("earth-buildings", "fill-opacity-transition"), instant);
  h.map.setPaintProperty("earth-buildings", "fill-color", "seasonal-color");
  h.layers.get("earth-buildings-3d").filter = ["all", ["==", ["get", "class"], "building"]];
  h.controller.setActive(false);
  assert.deepEqual(h.paint("earth-buildings", "fill-opacity"), updated);
  assert.deepEqual(h.paint("earth-buildings", "fill-opacity-transition"), { duration: 800, delay: 40 });
  assert.equal(h.paint("earth-buildings", "fill-color"), "seasonal-color");
  assert.deepEqual(h.layers.get("earth-buildings-3d").filter, ["all", ["==", ["get", "class"], "building"]]); h.controller.dispose();
});

test("replaced and newly added layers get their own snapshots, never an obsolete style's paint", () => {
  const h = harness(); h.raster(); h.controller.setActive(true);
  h.layers.set("earth-buildings", building({ "fill-opacity": 0.45 }));
  h.layers.delete("earth-buildings-3d"); h.layers.delete("earth-evening-shade"); h.emit();
  assert.equal(h.paint("earth-buildings", "fill-opacity"), 0);
  h.layers.set("earth-buildings-3d", extrusion({ "fill-extrusion-opacity": 0.6 }));
  h.layers.set("earth-evening-shade", { id: "earth-evening-shade", layout: { visibility: "visible" } }); h.emit();
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 0);
  assert.equal(h.layout("earth-evening-shade", "visibility"), "none");
  h.controller.setActive(false);
  assert.equal(h.paint("earth-buildings", "fill-opacity"), 0.45);
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 0.6);
  assert.equal(h.layout("earth-evening-shade", "visibility"), "visible"); h.controller.dispose();
});

test("missing imagery, style replacement and disposal restore only still-owned overrides", () => {
  const h = harness(); h.raster(); h.controller.setActive(true);
  h.layers.delete(RASTER); h.emit();
  assert.equal(h.paint("earth-buildings", "fill-opacity"), undefined);
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 1);
  h.raster(); h.controller.setActive(true);
  h.layers.set("earth-buildings", building({ "fill-opacity": 0.22 }));
  h.controller.dispose();
  assert.equal(h.paint("earth-buildings", "fill-opacity"), 0.22, "cleanup cannot overwrite a replacement layer");
  assert.equal(h.paint("earth-buildings-3d", "fill-extrusion-opacity"), 1);
  assert.equal(h.layout("earth-evening-shade", "visibility"), undefined);
  assert.equal(h.listeners.get("styledata").size, 0);
  const count = h.calls.length; h.controller.setActive(true); h.emit(); assert.equal(h.calls.length, count);
});
