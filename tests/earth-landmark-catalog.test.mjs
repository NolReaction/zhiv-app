import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { EARTH_LANDMARKS } = await vite.ssrLoadModule("/features/earth/landmark-catalog.ts");

test("atlas landmarks have unique identities and explicit context/coordinate provenance", () => {
  assert.equal(EARTH_LANDMARKS.length, 9);
  assert.equal(new Set(EARTH_LANDMARKS.map(value => value.id)).size, 9);
  assert.equal(new Set(EARTH_LANDMARKS.map(value => value.kind)).size, 9);
  for (const landmark of EARTH_LANDMARKS) {
    assert.match(landmark.nameRussian, /[А-Яа-яЁё]/);
    for (const field of ["sourceUrl", "coordinateSourceUrl"]) {
      const url = new URL(landmark[field]);
      assert.equal(url.protocol, "https:");
      assert.ok(url.hostname && !url.username && !url.password && !url.search);
    }
    assert.ok(landmark.coordinateNote.length > 40);
    assert.equal(landmark.location.length, 2);
    assert.ok(landmark.location.every(Number.isFinite));
  }
  const cathedral = EARTH_LANDMARKS.find(value => value.kind === "saint-basils");
  assert.equal(new URL(cathedral.sourceUrl).hostname, "shm.ru");
  assert.equal(new URL(cathedral.coordinateSourceUrl).hostname, "www.wikidata.org");
});

test("longitude/latitude anchors stay at their named monuments rather than country or city centres", () => {
  // Independent locality envelopes catch axis swaps, wrong signs and broad city
  // centroids while allowing honest rounding of the published reference points.
  const envelopes = {
    "giza-pyramids": [31.12, 29.96, 31.15, 29.99],
    "eiffel-tower": [2.29, 48.85, 2.30, 48.86],
    colosseum: [12.49, 41.88, 12.50, 41.90],
    "saint-basils": [37.62, 55.75, 37.63, 55.76],
    "taj-mahal": [78.04, 27.17, 78.05, 27.18],
    "great-wall-badaling": [116.01, 40.34, 116.03, 40.37],
    "statue-of-liberty": [-74.05, 40.68, -74.04, 40.70],
    "christ-redeemer": [-43.22, -22.96, -43.20, -22.94],
    "sydney-opera": [151.21, -33.86, 151.22, -33.85],
  };
  for (const { id, location: [longitude, latitude] } of EARTH_LANDMARKS) {
    const [west, south, east, north] = envelopes[id];
    assert.ok(longitude >= west && longitude <= east && latitude >= south && latitude <= north, id);
  }
});
