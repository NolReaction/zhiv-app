import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthPositionMarker, updateEarthPositionMarkerLabel } = await vite.ssrLoadModule("/features/earth/position-marker.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let canvasAvailable = true;
globalThis.document = {
  createElement(tag) {
    const element = { tag, attributes: {}, children: [], parent: null,
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) {
        for (const child of children) {
          assert.equal(child.parent, null, "a cached sprite must never be removed from another owner");
          child.parent = this;
          this.children.push(child);
        }
      },
    };
    if (tag === "canvas") {
      const context = { fillRect() {}, drawImage(source, x, y) { element.drawn = { source, x, y }; } };
      element.getContext = () => canvasAvailable ? context : null;
    }
    return element;
  },
};
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  await vite.close();
});

test("reopening the map paints independent marker canvases from the same cached Mochlik", () => {
  const first = createEarthPositionMarker();
  const second = createEarthPositionMarker();
  const firstCanvas = first.children[0].children[0];
  const secondCanvas = second.children[0].children[0];
  assert.notEqual(firstCanvas, secondCanvas);
  assert.equal(firstCanvas.drawn.source, secondCanvas.drawn.source);
  assert.equal(firstCanvas.drawn.source.parent, null);
  assert.equal(firstCanvas.width, 48);
  assert.equal(firstCanvas.height, 48);
  assert.equal(first.tag, "button");
  assert.equal(first.type, "button");
  assert.deepEqual(first.attributes, { "aria-label": "Вы здесь. Поздороваться с Мохликом" });
  assert.equal(first.children[0].attributes["aria-hidden"], "true");
});

test("precision updates remain accessible without repainting the marker or exposing coordinates", () => {
  const marker = createEarthPositionMarker();
  const original = marker.children[0].children[0];
  updateEarthPositionMarkerLabel(marker, 25.7);
  assert.equal(marker.attributes["aria-label"], "Вы здесь · точность ±26 м. Поздороваться с Мохликом");
  assert.match(marker.title, /Вы здесь · точность ±26 м/);
  updateEarthPositionMarkerLabel(marker, 12_500);
  assert.match(marker.attributes["aria-label"], /12,5 км/);
  assert.equal(marker.children[0].children[0], original);
  for (const invalid of [undefined, NaN, Infinity, -1]) {
    updateEarthPositionMarkerLabel(marker, invalid);
    assert.equal(marker.attributes["aria-label"], "Вы здесь. Поздороваться с Мохликом");
  }
});

test("a device without Canvas2D still gets a labelled location pin", () => {
  canvasAvailable = false;
  try {
    const marker = createEarthPositionMarker();
    assert.equal(marker.attributes["aria-label"], "Вы здесь. Поздороваться с Мохликом");
    assert.equal(marker.children[0].children[0].tag, "span");
    assert.equal(marker.children[0].children[0].textContent, "🌱");
  } finally {
    canvasAvailable = true;
  }
});


test("ghost presentation outlines only the own marker and preserves the actual capture time", () => {
  const marker = createEarthPositionMarker();
  const timestamp = Date.UTC(2026, 9, 22, 10, 15);
  updateEarthPositionMarkerLabel(marker, 12, { ghost: true, timestamp, active: false });
  assert.equal(marker.attributes["data-ghost"], "true");
  assert.match(marker.attributes["aria-label"], /Ваша последняя точка · Призрак · точность ±12 м · обновлено/);
  const capture = new Date(timestamp).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  assert.ok(marker.title.includes(capture));
  assert.equal(marker.children[1].textContent, "👻");
  assert.equal(marker.children[1].attributes["aria-hidden"], "true");
  updateEarthPositionMarkerLabel(marker, 10, { ghost: false, timestamp: timestamp + 60_000, active: true });
  assert.equal(marker.attributes["data-ghost"], "false");
  assert.match(marker.attributes["aria-label"], /^Вы здесь · точность ±10 м/);
  assert.doesNotMatch(marker.title, /Призрак/);
});
