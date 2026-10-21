# Illustrated tree groups

`clusters.json` is the composition guide for 49 ornamental groups: conifers in
taiga, rounded rainforest canopies and spreading savanna trees. These are
exaggerated atlas illustrations, not surveyed trees or forest density data.

`scripts/prepare-earth-vegetation.mjs` constructs three silhouettes per group,
unions their overlapping shadows/crowns and clips every tone to its existing
biome core, land, lake and ice masks. It imports `polygon-clipping` only during
preparation. The generated GeoJSON is the only geometry loaded by the browser.

After changing the biome guide, prepare biomes before vegetation:

```sh
node scripts/prepare-earth-biomes.mjs
node scripts/prepare-earth-vegetation.mjs
node scripts/prepare-earth-vegetation.mjs --check
node --test tests/earth-vegetation.test.mjs
```

Budgets: 64 groups, 256 features, 8,000 vertices, 220 KB JSON and 55 KB gzip.
The single fill layer sorts shadows, trunks, crowns and lit facets, sits below
mountain relief and fades out at zoom 5.5 before street detail. There are no
markers, animation timers, remote assets or geometry construction in the client.
