import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthAttribution } = await vite.ssrLoadModule("/features/earth/earth-attribution.tsx");
const { earthSatelliteAttribution, EARTH_ATTRIBUTION_LIMIT } = await vite.ssrLoadModule("/features/earth/satellite-attribution.ts");
const satellite = '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

test("map data credits show each required source once with its canonical link", () => {
  const tree = EarthAttribution();
  const links = Children.toArray(tree.props.children).filter(child => child.type === "a");
  assert.deepEqual(links.map(link => [link.props.children, link.props.href]), [
    ["© OpenStreetMap", "https://www.openstreetmap.org/copyright"],
    ["OpenMapTiles", "https://openmaptiles.org/"],
    ["3D-модели", "/earth/models/CREDITS.txt"],
  ]);
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/>© OpenStreetMap</g) || []).length, 1);
  assert.equal((html.match(/>OpenMapTiles</g) || []).length, 1);
  assert.doesNotMatch(html, /<button|<summary|<details|aria-hidden="true"[^>]*>©/);
});

test("source links remain standard keyboard links and isolate their external tabs", () => {
  for (const child of Children.toArray(EarthAttribution().props.children)) {
    if (child.type !== "a") continue;
    assert.equal(child.props.target, "_blank");
    assert.match(child.props.rel, /\bnoopener\b/);
    assert.match(child.props.rel, /\bnoreferrer\b/);
    assert.equal(child.props.tabIndex, undefined);
    assert.equal(child.props["aria-hidden"], undefined);
  }
});

test("active satellite shows linked MapTiler notice and official logo once without duplicating canonical credits", () => {
  const html = renderToStaticMarkup(EarthAttribution({ satelliteAttribution: satellite }));
  assert.equal((html.match(/>© MapTiler<\/a>/g) || []).length, 1);
  assert.equal((html.match(/>© OpenStreetMap<\/a>/g) || []).length, 1);
  assert.match(html, /href="https:\/\/www\.maptiler\.com\/copyright\/"/);
  assert.match(html, /<a[^>]*href="https:\/\/www\.maptiler\.com"[^>]*><img[^>]*src="https:\/\/api\.maptiler\.com\/resources\/logo\.svg"/);
  assert.match(html, /alt="MapTiler logo" width="67" height="20"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /href="https:\/\/openmaptiles\.org\/"/);
  assert.equal((html.match(/>OpenMapTiles<\/a>/g) || []).length, 1);
  assert.doesNotMatch(html, /3D-модели/);
  for (const child of Children.toArray(EarthAttribution({ satelliteAttribution: satellite }).props.children)) {
    if (child.type !== "a") continue;
    assert.equal(child.props.target, "_blank");
    assert.match(child.props.rel, /noopener/); assert.match(child.props.rel, /noreferrer/);
  }
});

test("a hidden, disabled or offline raster does not produce a logo element or provider request hint", () => {
  for (const satelliteAttribution of [undefined, null, "", "  "]) {
    const html = renderToStaticMarkup(EarthAttribution({ satelliteAttribution }));
    assert.doesNotMatch(html, /MapTiler|maptiler\.com|<img|rel="preload"/);
    assert.match(html, /OpenMapTiles/); assert.match(html, /3D-модели/);
  }
});

test("provider metadata keeps additional notices, links and entity text without executing supplied markup", () => {
  const text = satellite + ' · Imagery 2026 &amp; terrain <a href="https://www.usgs.gov/" onclick="attack()">USGS &amp; NASA</a>'
    + ' <img src="https://attacker.invalid/pixel" onerror="attack()"> <b>CC &quot;BY&quot; &#169; &#x1F30D;</b>';
  const html = renderToStaticMarkup(EarthAttribution({ satelliteAttribution: text }));
  assert.match(html, /href="https:\/\/www\.usgs\.gov\/"/);
  assert.match(html, /USGS &amp; NASA/);
  assert.match(html, /Imagery 2026 &amp; terrain/);
  assert.match(html, /CC &quot;BY&quot; © 🌍/);
  assert.doesNotMatch(html, /onclick|onerror|attacker\.invalid|<b>/);
  assert.equal((html.match(/<img/g) || []).length, 1, "only the known official logo can create an image request");
  const note = earthSatelliteAttribution('<a href="https://www.maptiler.com/copyright/">MapTiler · Airbus data</a>');
  const rendered = renderToStaticMarkup(EarthAttribution({ satelliteAttribution: '<a href="https://www.maptiler.com/copyright/">MapTiler · Airbus data</a>' }));
  assert.equal(note[0].text, "MapTiler · Airbus data");
  assert.match(rendered, /Airbus data/, "extra provider text at the canonical URL is retained");
});

test("unsafe, ambiguous or malformed hrefs become escaped credit text, never navigable links", () => {
  for (const href of ['javascript:attack()', 'jav&#x61;script:attack()', 'data:text/html,test', 'http://provider.invalid/',
    '//provider.invalid/', 'https://user:$TEST_PASSWORD@provider.invalid/', 'https://provider.invalid/\ncredit']) {
    assert.deepEqual(earthSatelliteAttribution(`<a href="${href}" target="_blank">Provider &amp; Co</a>`), [{ text: "Provider & Co" }]);
  }
  assert.deepEqual(earthSatelliteAttribution('<a data-href="https://provider.invalid/">Data attribute</a>'), [{ text: "Data attribute" }]);
  assert.deepEqual(earthSatelliteAttribution('<a title="pretend href=\'https://provider.invalid/\'">Quoted</a>'), [{ text: "Quoted" }]);
  assert.deepEqual(earthSatelliteAttribution('<a href="https://first.invalid/" href="https://second.invalid/">Duplicate</a>'), [{ text: "Duplicate" }]);
  assert.deepEqual(earthSatelliteAttribution('<a href="javascript:attack()">Unclosed'), [{ text: "Unclosed" }]);
  const html = renderToStaticMarkup(EarthAttribution({ satelliteAttribution: '&lt;script&gt;attack()&lt;/script&gt;' }));
  assert.match(html, /&lt;script&gt;attack\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
});

test("metadata parsing has bounded work and does not resolve arbitrary entities or source elements", () => {
  assert.deepEqual(earthSatelliteAttribution(undefined), []);
  const parts = earthSatelliteAttribution("x".repeat(EARTH_ATTRIBUTION_LIMIT + 10000));
  assert.equal(parts.map(part => part.text).join("").length, EARTH_ATTRIBUTION_LIMIT);
  assert.deepEqual(earthSatelliteAttribution('&bogus; &#0; &#xD800; &#1114112; &copy; &nbsp; plain'), [{ text: '&bogus; © plain' }]);
});

test("visible walking routes credit their operator and offer the required map correction link in either map mode", () => {
  for (const satelliteAttribution of [null, satellite]) {
    const html = renderToStaticMarkup(EarthAttribution({ satelliteAttribution, walkingRoute: true }));
    assert.equal((html.match(/href="https:\/\/routing.openstreetmap.de\/about.html"/g) || []).length, 1);
    assert.equal((html.match(/href="https:\/\/www.openstreetmap.org\/fixthemap"/g) || []).length, 1);
    assert.match(html, /FOSSGIS \/ OSRM/);
    assert.doesNotMatch(renderToStaticMarkup(EarthAttribution({ satelliteAttribution })), /FOSSGIS|fixthemap/);
  }
});
