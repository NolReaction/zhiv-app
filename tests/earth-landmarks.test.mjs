import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthLandmarks } = await vite.ssrLoadModule("/features/earth/globe-landmarks.ts");
const { EARTH_LANDMARKS } = await vite.ssrLoadModule("/features/earth/landmark-catalog.ts");

function scene({ zoom = 1.8, projectionScale = 8, width = 2_880, height = 1_440, failAttachmentAt = -1,
  modelEnvironment = null, withGpu = false, geographicBounds = null, pitch = 0 } = {}) {
  const markers = [];
  const elements = [];
  const listeners = new Map();
  const projected = [];
  const layers = new Map();
  const points = new Map();
  let groundOffset = 0;
  let writes = 0;
  const emit = type => { for (const callback of listeners.get(type) ?? []) callback(); };
  const ownerDocument = {
    // No MutationObserver in this unit harness: SDK idle is the coverage fallback.
    createElement(tag) {
      const handlers = new Map();
      const classes = new Set();
      const element = {
        tag, attributes: {}, dataset: {}, children: [], handlers,
        style: new Proxy({ setProperty(name, value) { this[name] = value; } }, {
          set(target, key, value) { writes++; target[key] = value; return true; },
        }),
        classList: { contains: name => classes.has(name), add: name => classes.add(name), delete: name => classes.delete(name) },
        setAttribute(name, value) { writes++; this.attributes[name] = value; },
        append(...children) { this.children.push(...children); },
        addEventListener(type, callback) {
          if (!handlers.has(type)) handlers.set(type, new Set());
          handlers.get(type).add(callback);
        },
        removeEventListener(type, callback) {
          handlers.get(type)?.delete(callback);
          if (handlers.get(type)?.size === 0) handlers.delete(type);
        },
        dispatch(type, extra = {}) {
          const event = { ...extra, stopped: false, defaultPrevented: false,
            stopPropagation() { this.stopped = true; },
            preventDefault() { this.defaultPrevented = true; },
          };
          for (const callback of handlers.get(type) ?? []) callback(event);
          if (type === "click" && !event.stopped) emit("click");
          return event;
        },
      };
      elements.push(element);
      return element;
    },
    createElementNS(namespace, tag) {
      assert.equal(namespace, "http://www.w3.org/2000/svg");
      return this.createElement(tag);
    },
  };
  const container = { ownerDocument, clientWidth: width, clientHeight: height, dataset: {} };
  // Native MapLibre initializes its custom layer before it can request assets.
  const buffers = new Map(), boundBuffers = new Map();
  const gl = {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, BUFFER_SIZE: 3,
    createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray() {},
    bindBuffer(target, value) { boundBuffers.set(target, value); },
    bufferData(target, value) { buffers.set(boundBuffers.get(target), value.byteLength); },
    getBufferParameter(target) { return buffers.get(boundBuffers.get(target)) ?? 0; },
    createProgram: () => ({}), createShader: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    getUniformLocation: () => ({}), shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {}, deleteShader() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {}, useProgram() {}, disable() {}, enable() {}, depthMask() {}, blendFunc() {},
    uniform1f() {}, uniform2fv() {}, uniform4fv() {}, uniformMatrix4fv() {}, drawElements() {}, drawArrays() {},
    deleteBuffer() {}, deleteVertexArray() {}, deleteProgram() {},
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const projection = { mainMatrix: identity, fallbackMatrix: identity, tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 1, 0], projectionTransition: 1 };
  const map = {
    getContainer: () => container,
    getZoom: () => zoom,
    getBounds: geographicBounds ? () => ({ getWest: () => geographicBounds.west, getEast: () => geographicBounds.east,
      getSouth: () => geographicBounds.south, getNorth: () => geographicBounds.north }) : undefined,
    getPitch: () => pitch,
    getVerticalFieldOfView: () => 36.86989764584402,
    getPadding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    getLayer: id => layers.get(id),
    addLayer(layer, before) { layers.set(layer.id, { ...layer, before }); if (withGpu) layer.onAdd(map, gl); },
    removeLayer(id) { if (withGpu) layers.get(id)?.onRemove(map, gl); layers.delete(id); },
    triggerRepaint() {},
    project(location) {
      projected.push([...location]);
      const [longitude, latitude] = location;
      return points.get(location.join(",")) ?? {
        x: (longitude + 180) * projectionScale,
        y: (90 - latitude) * projectionScale,
      };
    },
    unproject([x, y]) {
      for (const [location, point] of points) {
        if (point.x === x && point.y === y) {
          const [lng, lat] = location.split(",").map(Number); return { lng: lng + groundOffset, lat };
        }
      }
      return { lng: x / projectionScale - 180 + groundOffset, lat: 90 - y / projectionScale };
    },
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    off(type, callback) {
      listeners.get(type)?.delete(callback);
      if (listeners.get(type)?.size === 0) listeners.delete(type);
    },
  };
  class Marker {
    constructor(options) {
      this.options = options;
      this.positions = [];
      this.removed = 0;
      // Both fields belong to the SDK, including its globe occlusion updates.
      options.element.style.opacity = "0.73";
      options.element.style.transform = "translate(-50%, -100%) translate(100px, 200px)";
      markers.push(this);
    }
    setLngLat(location) {
      const catalog = EARTH_LANDMARKS.find(landmark => landmark.id === this.options.element.dataset.earthLandmark);
      assert.notEqual(location, catalog.location);
      this.positions.push([...location]);
      return this;
    }
    addTo(target) {
      assert.equal(target, map);
      if (markers.length - 1 === failAttachmentAt) throw new Error("attachment failed");
      return this;
    }
    remove() { this.removed++; }
  }
  return {
    create: () => createEarthLandmarks(map, Marker, { modelEnvironment }),
    markers, elements, listeners, projected, container, emit, layers,
    render() {
      for (const layer of layers.values()) layer.render(gl, { shaderData: { variantName: "globe", define: "#define GLOBE", vertexShaderPrelude: "" },
        defaultProjectionData: projection, getProjectionData: () => projection });
    },
    element(id) { return markers.find(marker => marker.options.element.dataset.earthLandmark === id).options.element; },
    setZoom(value) { zoom = value; emit("move"); },
    setGroundOffset(value) { groundOffset = value; emit("move"); },
    setPoint(id, point) {
      points.set(EARTH_LANDMARKS.find(landmark => landmark.id === id).location.join(","), point);
    },
    cover(id, covered) {
      const element = this.element(id);
      if (covered) element.classList.add("maplibregl-marker-covered");
      else element.classList.delete("maplibregl-marker-covered");
      element.style.opacity = covered ? "0" : "0.73";
      emit("idle");
    },
    get writes() { return writes; },
  };
}

function label(element) { return element.children[1]; }
function visual(element) { return element.children[0]; }
function openLabels(state) {
  return state.markers.map(marker => marker.options.element).filter(element => !label(element).hidden)
    .map(element => element.dataset.earthLandmark);
}
function assertHidden(element) {
  assert.equal(element.style.display, "none");
  assert.equal(element.disabled, true);
  assert.equal(element.tabIndex, -1);
  assert.equal(element.attributes["aria-hidden"], "true");
  assert.equal(element.attributes["aria-expanded"], "false");
  assert.equal(label(element).hidden, true);
}

test("nine fixed catalog anchors are installed once and remain inaccessible until the scene is ready", () => {
  const state = scene();
  const landmarks = state.create();
  const catalogLocations = EARTH_LANDMARKS.map(landmark => [...landmark.location]);
  assert.equal(state.markers.length, 9);
  for (const [index, marker] of state.markers.entries()) {
    const element = marker.options.element;
    assert.deepEqual(marker.positions, [catalogLocations[index]]);
    assert.equal(element.tag, "button");
    assert.equal(element.type, "button");
    assert.equal(element.dataset.earthLandmark, EARTH_LANDMARKS[index].id);
    assert.equal(element.attributes["aria-label"], EARTH_LANDMARKS[index].nameRussian);
    assertHidden(element);
  }
  landmarks.setVisible(true);
  assert.equal(state.markers.filter(marker => !marker.options.element.disabled).length, 6);
  for (const event of ["move", "resize", "idle"]) state.emit(event);
  landmarks.setVisible(false);
  landmarks.setVisible(true);
  assert.deepEqual(state.markers.map(marker => marker.positions), catalogLocations.map(location => [location]));
  assert.deepEqual(EARTH_LANDMARKS.map(landmark => landmark.location), catalogLocations);
  assert.ok(state.projected.every(location => catalogLocations.some(anchor => anchor[0] === location[0] && anchor[1] === location[1])));
  landmarks.dispose();
});

test("landmarks render native 3D geometry and retain only clear accessible DOM hit targets", () => {
  const state = scene();
  const landmarks = state.create();
  const layer = state.layers.get("earth-landmark-models");
  assert.equal(layer.type, "custom");
  assert.equal(layer.renderingMode, "3d");
  for (const { options: { element } } of state.markers) {
    assert.equal(visual(element).children.length, 0, "no camera-facing SVG artwork");
    assert.equal(visual(element).attributes["aria-hidden"], "true");
  }
  landmarks.dispose();
  assert.equal(state.layers.size, 0, "scene disposal removes its GPU layer");
});

test("native globe coverage removes a landmark from interaction without overwriting SDK transforms or opacity", () => {
  const state = scene();
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  for (const { options } of state.markers) {
    assert.equal(options.anchor, "center");
    assert.equal(options.pitchAlignment, "viewport");
    assert.equal(options.rotationAlignment, "viewport");
    assert.equal(options.subpixelPositioning, true);
    assert.equal(options.opacityWhenCovered, 0);
  }
  tower.dispatch("click");
  state.cover("eiffel-tower", true);
  assertHidden(tower);
  assert.equal(tower.style.opacity, "0");
  state.cover("eiffel-tower", false);
  assert.equal(tower.disabled, false);
  assert.equal(tower.style.opacity, "0.73");
  assert.equal(label(tower).hidden, true, "returning from the far hemisphere does not reopen a stale label");
  state.setZoom(4.5);
  assert.ok(Math.abs(Number(visual(tower).style.opacity) - 0.5) < 0.00001);
  for (const { options: { element } } of state.markers) {
    assert.equal(element.style.opacity, "0.73");
    assert.equal(element.style.transform, "translate(-50%, -100%) translate(100px, 200px)");
  }
  landmarks.dispose();
});

test("hidden scenes, tiny globes and street zoom close labels and remove every marker from keyboard navigation", () => {
  const state = scene();
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  tower.dispatch("click");
  landmarks.setVisible(false);
  for (const marker of state.markers) assertHidden(marker.options.element);
  tower.dispatch("focus");
  tower.dispatch("click");
  assert.deepEqual(openLabels(state), []);
  landmarks.setVisible(true);
  assert.deepEqual(openLabels(state), []);
  tower.dispatch("click");
  state.setZoom(5.2);
  for (const marker of state.markers) assertHidden(marker.options.element);
  state.setZoom(18);
  for (const marker of state.markers) assertHidden(marker.options.element);
  for (const zoom of [-1.5, -1, -0.5, -0.2]) {
    state.setZoom(zoom);
    for (const marker of state.markers) assertHidden(marker.options.element);
  }
  state.setZoom(1.8);
  assert.equal(tower.disabled, false);
  assert.equal(tower.tabIndex, 0);
  assert.equal(tower.attributes["aria-hidden"], "false");
  assert.deepEqual(openLabels(state), []);
  assert.equal(state.markers.length, 9, "zooming never rebuilds the marker population");
  landmarks.dispose();
});

test("pointer activation toggles the correct Russian name and does not start map gestures or a map click", () => {
  const state = scene();
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  for (const event of ["pointerdown", "mousedown", "touchstart"]) {
    assert.equal(tower.dispatch(event).stopped, true);
  }
  assert.equal(tower.dispatch("click").stopped, true);
  assert.deepEqual(openLabels(state), ["eiffel-tower"]);
  assert.equal(label(tower).textContent, "Эйфелева башня");
  assert.equal(tower.attributes["aria-controls"], label(tower).id);
  assert.equal(tower.attributes["aria-expanded"], "true");
  tower.dispatch("click");
  assert.deepEqual(openLabels(state), []);
  tower.dispatch("click");
  state.element("colosseum").dispatch("click");
  assert.deepEqual(openLabels(state), ["colosseum"]);
  state.emit("click");
  assert.deepEqual(openLabels(state), []);
  tower.dispatch("click");
  state.emit("movestart");
  assert.deepEqual(openLabels(state), []);
  landmarks.dispose();
});

test("keyboard focus shows one current label; Escape closes it and native button activation remains available", () => {
  const state = scene();
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  const arena = state.element("colosseum");
  tower.dispatch("focus");
  assert.deepEqual(openLabels(state), ["eiffel-tower"]);
  tower.dispatch("blur");
  assert.deepEqual(openLabels(state), []);
  tower.dispatch("click");
  arena.dispatch("focus");
  assert.deepEqual(openLabels(state), ["colosseum"], "focusing another marker supersedes the previously clicked label");
  for (const key of ["Enter", " "]) {
    const event = arena.dispatch("keydown", { key });
    assert.equal(event.stopped, true);
    assert.equal(event.defaultPrevented, false, "the browser still activates this real button");
  }
  assert.equal(arena.dispatch("keydown", { key: "Escape" }).stopped, true);
  assert.deepEqual(openLabels(state), []);
  assert.equal(arena.dispatch("keydown", { key: "Tab" }).stopped, false);
  landmarks.dispose();
});

test("decluttering uses projected geographic anchors and releases space when the higher priority monument is covered", () => {
  const state = scene({ projectionScale: 3.5, width: 1_260, height: 630 });
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  const arena = state.element("colosseum");
  assert.equal(tower.disabled, false);
  assertHidden(arena);
  state.cover("eiffel-tower", true);
  assert.equal(arena.disabled, false);
  state.cover("eiffel-tower", false);
  assertHidden(arena);
  state.setPoint("colosseum", { x: 800, y: 400 });
  state.emit("resize");
  assert.equal(tower.disabled, false);
  assert.equal(arena.disabled, false);
  assert.ok(state.markers.every(marker => marker.positions.length === 1), "decluttering changes visibility, never real locations");
  landmarks.dispose();
});

test("edge labels stay inside a narrow viewport and open below landmarks near the top", () => {
  const state = scene({ width: 320, height: 568 });
  for (const landmark of EARTH_LANDMARKS) state.setPoint(landmark.id, { x: -1_000, y: 200 });
  state.setPoint("eiffel-tower", { x: 10, y: 40 });
  const landmarks = state.create();
  landmarks.setVisible(true);
  const tower = state.element("eiffel-tower");
  tower.dispatch("click");
  const name = label(tower);
  assert.equal(name.dataset.placement, "below");
  const assertWithinViewport = x => {
    const halfWidth = Number.parseFloat(name.style.maxWidth) / 2;
    const center = x + Number.parseFloat(name.style["--landmark-label-shift"]);
    assert.ok(center - halfWidth >= 8);
    assert.ok(center + halfWidth <= state.container.clientWidth - 8);
  };
  assertWithinViewport(10);
  state.setPoint("eiffel-tower", { x: 310, y: 300 });
  state.emit("move");
  assert.equal(name.dataset.placement, "above");
  assertWithinViewport(310);
  state.container.clientWidth = 160;
  state.setPoint("eiffel-tower", { x: 10, y: 300 });
  state.emit("resize");
  assertWithinViewport(10);
  assert.equal(name.style.maxWidth, "144px");
  landmarks.dispose();
});

test("idempotent disposal removes every map/DOM listener and marker, with no late writes", () => {
  const state = scene();
  const landmarks = state.create();
  landmarks.setVisible(true);
  state.element("eiffel-tower").dispatch("click");
  assert.ok(state.listeners.size > 0);
  landmarks.dispose();
  landmarks.dispose();
  assert.equal(state.listeners.size, 0);
  assert.ok(state.elements.every(element => element.handlers.size === 0));
  assert.ok(state.markers.every(marker => marker.removed === 1));
  const writes = state.writes;
  landmarks.setVisible(false);
  landmarks.setVisible(true);
  for (const type of ["move", "resize", "idle", "movestart", "click"]) state.emit(type);
  state.element("eiffel-tower").dispatch("focus");
  state.element("eiffel-tower").dispatch("click");
  assert.equal(state.writes, writes);
});

test("a failed partial attachment cleans up every created marker and DOM listener", () => {
  const state = scene({ failAttachmentAt: 3 });
  assert.throws(state.create, /attachment failed/);
  assert.equal(state.markers.length, 4);
  assert.ok(state.markers.every(marker => marker.removed === 1));
  assert.equal(state.listeners.size, 0);
  assert.ok(state.elements.every(element => element.handlers.size === 0));
});

function preparedEnvironment() {
  const requests = [], signals = [];
  return { requests, signals, environment: {
    async fetch(input, init) {
      const path = String(input).split("?")[0];
      assert.match(path, /^\/earth\/models\/eiffel-tower\/(overview|detail)\.elm$/);
      requests.push(path);
      signals.push(init.signal);
      return new Response(readFileSync(new URL(`../public${path}`, import.meta.url)));
    },
    sha256: null,
    schedule: () => 0,
    cancel() {},
  } };
}
async function settleModel() {
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
}

test("street Eiffel loads only when nearby and becomes an accessible target after the prepared model is ready", async () => {
  const asset = preparedEnvironment();
  const state = scene({ zoom: 16, width: 390, height: 844, modelEnvironment: asset.environment, withGpu: true });
  state.setPoint("eiffel-tower", { x: 195, y: 600 });
  const landmarks = state.create();
  assert.deepEqual(asset.requests, []);
  const tower = state.element("eiffel-tower");
  landmarks.setVisible(true);
  assertHidden(tower);
  await settleModel();
  assert.deepEqual(asset.requests, ["/earth/models/eiffel-tower/detail.elm"]);
  assertHidden(tower);
  state.render();
  assert.equal(tower.disabled, false);
  assert.equal(tower.tabIndex, 0);
  for (const marker of state.markers) {
    if (marker.options.element !== tower) assertHidden(marker.options.element);
  }
  tower.dispatch("click");
  assert.deepEqual(openLabels(state), ["eiffel-tower"]);
  state.setZoom(8);
  assertHidden(tower);
  state.setZoom(16);
  assert.equal(tower.disabled, false);
  assert.equal(asset.requests.length, 1, "returning reuses the one decoded model");
  landmarks.setVisible(false);
  assertHidden(tower);
  landmarks.dispose();
});

test("street culling rejects a distant or far-side ground anchor before fetching the model", async () => {
  const asset = preparedEnvironment();
  const state = scene({ zoom: 16, width: 390, height: 844, modelEnvironment: asset.environment, withGpu: true });
  state.setPoint("eiffel-tower", { x: 100_000, y: 600 });
  const landmarks = state.create();
  landmarks.setVisible(true);
  await settleModel();
  assert.deepEqual(asset.requests, []);
  state.setGroundOffset(180);
  state.setPoint("eiffel-tower", { x: 195, y: 600 });
  state.emit("move");
  await settleModel();
  assert.deepEqual(asset.requests, [], "a front-side round trip is required independently of SDK marker classes");
  state.setGroundOffset(-720);
  await settleModel();
  assert.equal(asset.requests.length, 1, "equivalent wrapped longitudes still refer to the same monument");
  state.render();
  assert.equal(state.element("eiffel-tower").disabled, false);
  landmarks.dispose();
});

test("the buildings toggle cancels street loading and interaction while atlas miniatures remain available", async () => {
  const asset = preparedEnvironment();
  const state = scene({ zoom: 16, width: 390, height: 844, modelEnvironment: asset.environment, withGpu: true });
  state.setPoint("eiffel-tower", { x: 195, y: 600 });
  const landmarks = state.create(), tower = state.element("eiffel-tower");
  landmarks.setBuildingsEnabled(false); landmarks.setVisible(true);
  await settleModel(); assert.deepEqual(asset.requests, []); assertHidden(tower);
  landmarks.setBuildingsEnabled(true); assert.equal(asset.requests.length, 1);
  landmarks.setBuildingsEnabled(false);
  assert.equal(asset.signals[0].aborted, true, "disabling buildings immediately aborts the street request");
  await settleModel(); state.render(); assertHidden(tower);
  landmarks.setBuildingsEnabled(true); await settleModel(); state.render();
  assert.equal(asset.requests.length, 2); assert.equal(tower.disabled, false);
  tower.dispatch("click"); landmarks.setBuildingsEnabled(false); assertHidden(tower);
  state.setZoom(2.5); assert.equal(tower.disabled, false, "the independent globe miniature remains interactive");
  landmarks.dispose();
});

test("high-pitch street culling retains a visible roof when its geographic base is far below the viewport", async () => {
  const asset = preparedEnvironment();
  const tower = EARTH_LANDMARKS.find(item => item.id === "eiffel-tower");
  // At pitch60, 330m height and mobile390x844/zoom16, the ground can project
  // to y1437 while the upper300m projects to y773 inside the viewport. A
  // 330m screen radius rejected it; ground bounds padded in metres retain it.
  const geographicBounds = { west: tower.location[0] - .004, east: tower.location[0] + .004,
    south: tower.location[1] + .003, north: tower.location[1] + .02 };
  const state = scene({ zoom: 16, width: 390, height: 844, pitch: 60, geographicBounds,
    modelEnvironment: asset.environment, withGpu: true });
  state.setPoint("eiffel-tower", { x: 195, y: 1437.42 });
  const landmarks = state.create(); landmarks.setVisible(true); await settleModel(); state.render();
  assert.equal(asset.requests.length, 1, "a potentially visible roof gets its bounded detail model");
  assert.equal(state.container.dataset.earthEiffelModelDraw, "uploaded");
  assertHidden(state.element("eiffel-tower"), "the offscreen ground has no keyboard target");
  geographicBounds.west += 1; geographicBounds.east += 1; state.emit("move"); state.render();
  assert.equal(state.container.dataset.earthEiffelModelDraw, "none", "a distant geographic viewport culls the retained model");
  landmarks.dispose();
});
