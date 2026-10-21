# Overview rivers

`ne-110m-rivers-v5.1.2.geojson` is the unchanged upstream Natural Earth
`ne_110m_rivers_lake_centerlines` GeoJSON pinned at tag `v5.1.2`:

https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_rivers_lake_centerlines.geojson

38,087 bytes; SHA-256:
`55aa4497405afc07cdc931b7fbe062c4d6693ba2a550c0d24899953f5d507c8d`.

Dataset description:
https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-rivers-lake-centerlines/

Natural Earth data is public domain:
https://www.naturalearthdata.com/about/terms-of-use/

`node scripts/prepare-earth-rivers.mjs` verifies the pinned checksum, keeps the
13 upstream river lines and their name/rank, rounds coordinates to four decimals
and writes `features/earth/data/rivers-110m.json`. The `--check` option verifies
reproducibility without writing or downloading. Output: 1,147 vertices, 22,723
bytes. This is generalized small-scale cartography, not precise river banks,
flow, water level or navigation data. It fades before street-level mapping.

`features/earth/data/reefs-illustrated.json` is separate original artwork:
three short authored reef/lagoon accents near the Great Barrier Reef, Belize
and New Caledonia. It is not derived from this hydrology dataset, surveyed reef
boundaries or bathymetry. It uses one tiny local source and fades by zoom 4.
