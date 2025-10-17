<details>

<summary>Original commands to LLM</summary>

```
design the following file format for the most space efficient as possible

I have a global planet terrain map.
it's built from dozens, or even hundreds of different sources
the full planet is done in z12 resolution (using maplibre/mapbox-gl-js)
some parts are done in a higher resolution, like a full country is done in z15
some even smaller parts are in even higher resolution, say one mountain has a LIDAR dataset
all of these are lat-lon bounding boxes, so everything is rectangular, there are no angled areas, etc.

design a datastructure and file format, which would let the viewer know exactly for a given lat-lon: what max zoom level is available for that specific point.

basically all I need is a lat-lon -> zoom integer map, super space efficient.
```

```
translate it to modern typescript

write a node cli script as well, which takes this JSON file and converts it to this format

{"version": "0.0.3", "items": [{"name": "6-34-22.pmtiles",....
```

```
ok, now write the minimal ts implementation for a decoder, to be used in a maplibre environment
```

```
ok, now write a README for this repo

explain the whole theory, how does it work, and why was a given decision made
explain the CLI script as well as the browser/maplibre helper
```

```
can you come up with ways to simplify this? it's ok if the given file is a tiny bit bigger, as long as the code is simpler to read for an everyday person.
```

```
I really like the new format, it's even simpler. it's even smaller compared to before somehow, nice work!

please extend it with the following: I also want to store some kind of ID to refer to the dataset being used. this could be used to display the correct OSM like map contribution in the lower right corner.
So for a given lat-lon, I basically want the upmost (most detailed) dataset's zoom and ID.

I don't expect more than 1024 datasets to be on a map, but maybe a tiny bit more, like 2048. what would be a good format for such an ID?
```

```
please simplify the magic string and version, this is not yet used. that 1 vs 2 looks strange for me.

also add a few helpful comment lines. do not write the docs inside the source code, write the docs/guide/examples into the README. but think of some key lines which could help contributors understand the code.

finally, write the updated README.md in full.

return all those in markdown fenced code blocks
```

```
ok, now we are at 248 bytes.

my questions:
1. did this simplification result in any kind of performance degradation, compared to the original? I only care about decode time, to make sure it's extremely efficient to simply look up a single lat-lon in the maplibre JS client.

2. can you make a version which uses the same datastructure but stores everything in JSON? You don't need an ID lookup table then, you could store the string ids directly.
```

</details>

# ZMSF: Zoom‑Max Simple Format

A tiny, fixed-width binary that answers:

- What is the maximum available zoom at this lat/lon?
- Which dataset provides that most-detailed coverage?

ZMSF is intentionally simple: one fixed-size record per rectangle, plus a string table for dataset IDs. No varints, no delta-encoding, no directories. It’s easy to read and debug, compresses well over HTTP, and short-circuits quickly during queries.

Key properties

- Small: ≈19 bytes per rectangle (before gzip/Brotli), plus a tiny dataset table.
- Fast: scan rectangles in descending zoom; stop on the first match.
- Simple: fixed-width integers; antimeridian rectangles are allowed without splitting.

Typical use

- Your app has a global base map (e.g., z12) and a few hundred rectangles where higher zoom is available (e.g., z15 for a country, z18 for a mountain).
- You want to show the correct attribution for the dataset that provides the most detailed data at the cursor.

---

How it works

- The max zoom at a point is the maximum across:
  - A base zoom (global), associated with a base dataset ID.
  - A set of axis-aligned rectangles, each with its own zoom and dataset ID.
- Rectangles are scanned from highest zoom to lowest; the first hit wins.
- Coordinates are quantized to microdegrees (int32 of deg \* 1e6).
- Antimeridian is supported without splitting: if minLonQ > maxLonQ, the rectangle wraps across ±180°.

Query

- Convert lat/lon to microdegrees (round).
- For each rectangle in descending zoom:
  - If point is inside (with wrap-aware lon check), return {zoom, dataset}.
- If none match, return {base_zoom, base_dataset}.

---

Binary format (ZMSF v1)

- Endianness: little-endian
- Coordinates: WGS84 degrees quantized to microdegrees (int32)
- Antimeridian: if minLonQ > maxLonQ, the rectangle wraps

Header (16 bytes total)

- magic: 4 bytes = "ZMSF"
- version: u8 = 1
- base_zoom: u8
- reserved: u16 = 0
- rect_count: u32
- dataset_count: u16
- base_dataset_id: u16 (0..dataset_count-1), or 0xFFFF if not provided

Dataset table (dataset_count entries)

- For each dataset:
  - name_len: u16
  - name: name_len bytes (UTF‑8)
- Names can be short slugs (e.g., “planet” or “6-35-21”) or any text you want to surface in the UI.

Records (rect_count entries; 19 bytes each)

- z: u8 (zoom for this rectangle)
- dataset_id: u16 (index into dataset table)
- minLatQ: int32
- minLonQ: int32
- maxLatQ: int32
- maxLonQ: int32
- Inclusive bounds. For wrap rectangles (minLonQ > maxLonQ), the longitude check is (lonQ >= minLonQ || lonQ <= maxLonQ).

---

Repository layout

- zms-pack.ts — Node/TypeScript CLI + encoder for .zms files
- zms-decoder.ts — Minimal browser decoder for MapLibre/web apps

---

Install and run (CLI)

- Requires Node 18+ (TextDecoder is built-in)
- With tsx:
  - tsx zms-pack.ts input.json [output.zms] [--base-zoom N]
- With ts-node:
  - npx ts-node zms-pack.ts input.json [output.zms] [--base-zoom N]

Input JSON schema (pmtiles-style):
{
"version": "0.0.3",
"items": [
{
"name": "planet.pmtiles",
"min_lon": -180.0, "min_lat": -85.0511287798066,
"max_lon": 180.0, "max_lat": 85.0511287798066,
"min_zoom": 0, "max_zoom": 12
},
{
"name": "6-34-22.pmtiles",
"min_lon": 11.25, "min_lat": 45.0890,
"max_lon": 16.875,"max_lat": 48.9225,
"min_zoom": 13, "max_zoom": 17
}
]
}

Packing policy

- Base zoom is derived from a global item (covers full lon and WebMercator lat band). If none is found, fallback to min(max_zoom) across items, or use --base-zoom to override.
- Every item with max_zoom > base_zoom becomes one rectangle at z = max_zoom.
- dataset_id per rectangle is the index of the item’s name in the dataset table.
- base_dataset_id refers to the base coverage’s dataset (the chosen global item).

Example
tsx zms-pack.ts example.json
[zms] Base zoom: 12, base dataset: planet.pmtiles, rects: 6, datasets: 7, wrote 1.7 kB -> example.zms

---

Browser / MapLibre helper

Basic API

- ZMSF.fromUrl(url: string): Promise<ZMSF>
- ZMSF.fromArrayBuffer(ab: ArrayBuffer): ZMSF
- zms.query(lat, lon): { zoom: number; datasetIndex: number; datasetId: string | null }
- zms.queryMaxZoom(lat, lon): number
- zms.datasets: string[] (dataset names from the file)
- zms.baseZoom: number

Example (pseudo)
const zms = await ZMSF.fromUrl("/coverage.zms");
map.on("mousemove", (e) => {
const r = zms.query(e.lngLat.lat, e.lngLat.lng);
ui.setAttribution(r.datasetId ?? "Unknown source");
ui.setMaxZoom(r.zoom);
});

---

Notes and tips

- Dataset IDs
  - Store short, stable names in the dataset table (e.g., “planet”, “6-35-21”).
  - Map those to longer attribution text in your app if you prefer.
- Sizes
  - 19 bytes/rect + small dataset table; gzip/Brotli compresses extremely well.
- Edge cases
  - Antimeridian: rectangles may wrap; the decoder handles it.
  - Inclusive bounds: points on the rectangle edges are considered inside.

License

MIT. Contributions welcome.
