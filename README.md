# ZMCF: Zoom‑Max Coverage Format

A compact, exact way to answer: “What is the maximum available zoom at this lat/lon?”

This repo contains:
- A **Node/TypeScript CLI** that packs an inventory of rectangular coverages into a tiny binary file (`.zmc`).
- A **minimal browser/MapLibre helper** to decode and query that file in real time.

Core idea: the world has a base coverage (e.g., z12), with many rectangular patches of higher zoom (e.g., z15 for a country, z18 for a mountain). We store those rectangles, grouped by zoom, compressed with deltas and varints. Querying checks high zooms first and short-circuits on the first hit.

Note: This was created by GPT-5 High. I'm really impressed by it.
I think this might be one of those well-defined, limited algorithmic questions where LLMs beat even competitive programmers.
It definitely beat me, it'd have taken me weeks to come up with something like this.

<details>
<summary>Original input to LLM</summary>

design the following file format for the most space efficient as possible

I have a global planet terrain map.
it's built from dozens, or even hundreds of different sources
the full planet is done in z12 resolution (using maplibre/mapbox-gl-js)
some parts are done in a higher resolution, like a full country is done in z15
some even smaller parts are in even higher resolution, say one mountain has a LIDAR dataset
all of these are lat-lon bounding boxes, so everything is rectangular, there are no angled areas, etc.

design a datastructure and file format, which would let the viewer know exactly for a given lat-lon: what max zoom level is available for that specific point.

basically all I need is a lat-lon -> zoom integer map, super space efficient.

---

translate it to modern typescript

write a node cli script as well, which takes this JSON file and converts it to this format

{"version": "0.0.3", "items": [{"name": "6-34-22.pmtiles",....

---

ok, now write the minimal ts implementation for a decoder, to be used in a maplibre environment

---

ok, now write a README for this repo

explain the whole theory, how does it work, and why was a given decision made
explain the CLI script as well as the browser/maplibre helper

---

Then I edited manually

</details>

---

## Why another format?

- You need a simple, exact **lat-lon → max-zoom** map.
- Full-tile masks, quadtrees, or rasters are wasteful when your truth is “a few hundred rectangles.”
- You want tiny storage, fast queries, and easy browser integration.

ZMCF is:
- **Small**: tens of bytes per rectangle (before HTTP compression), often less with gzip/Brotli.
- **Fast**: queries short-circuit at the first matching higher-zoom level.
- **Simple**: small encoder/decoder; no complex spatial index required.

---

## How it works

- The max zoom at a point is the maximum across:
  - A **base zoom** applied globally.
  - A set of axis-aligned **rectangles** (lat/lon) with integer zooms.
- Rectangles are grouped by **zoom level** and stored level-by-level.
- Each level’s rectangles are sorted and **delta-encoded**; integers are compressed with **LEB128 varints** and **ZigZag** for signed values.
- Coordinates are quantized to **microdegrees** (1e-6 degrees). This is sub-decimeter at latitude (~0.11 m vertically), far below tile pixel sizes even at high zooms.

Query:
- Convert lat/lon → microdegrees.
- Iterate levels from highest zoom down:
  - If the point is inside any rectangle in that level, return that zoom.
- If no rectangle matches, return **base zoom**.

This structure is inherently compact and short-circuits quickly for most queries.

---

## Design decisions

- **Rectangles over tiles**: Your input is rectangles; encoding them directly avoids expanding to millions of tiles or cells. Overlaps are resolved by “max zoom wins.”
- **Microdegree quantization**: Precise enough for cartography (≈0.11 m in latitude) and fits comfortably into 32-bit signed ints.
- **Delta + varint**: Sorted rectangles compress extremely well with delta encoding; varints shrink small deltas to 1–2 bytes.
- **No mandatory index**: Most datasets don’t need a spatial index for point queries. If you ever have tens of thousands of rectangles, a coarse grid index can be added (format leaves room via flags).
- **Browser-first reading**: The decoder uses typed arrays and minimal parsing overhead, ideal for MapLibre.

---

## File format (ZMCF v1)

- Endianness: **little-endian**
- Coordinates: **WGS84 degrees → microdegrees** (int32)
- Integer encoding:
  - Unsigned: **LEB128 varint**
  - Signed: **ZigZag + LEB128**
- Rectangles are inclusive ranges: `min <= point <= max`
- Rectangles crossing the antimeridian must be split by the encoder (the CLI does this).

Layout:

```txt
Header:
- magic: 4 bytes = "ZMC1"
- version: u8 = 1
- coord_encoding: u8 = 0 (WGS84 microdegrees)
- flags: u8 (bit 0: has coarse index; others reserved=0)
- base_zoom: u8
- zmin_overrides: u8 (lowest z that appears as a level; informational)
- zmax_overrides: u8 (highest z that appears; informational)
- reserved: u16 = 0
- levels_count: u32
- rects_total_count: u32
- level_dir_offset: u32 (absolute byte offset to Level Directory)
- data_offset: u32 (absolute byte offset to Rectangles Block)
- index_offset: u32 (absolute byte offset to optional Coarse Index; 0 if none)

Level Directory: levels_count entries, each
- z: u8
- rect_count: u32
- level_data_offset: u32 (relative to data_offset)

Rectangles Block: for each level (in any order; recommend descending z)
- uvarint: rect_count (repeated here for integrity)
- rect_count rectangles, each four signed varints (delta-coded):
  - d_minLatQ, d_minLonQ, d_maxLatQ, d_maxLonQ
  - Reconstruct by cumulative sum per field inside the level, starting from 0.

Notes:
- Sorting per level: by (minLatQ, minLonQ, maxLatQ, maxLonQ) ascending.
- Decoder returns base_zoom if no rectangle matches.
```

---

## Repository layout

- `zmc-pack.ts`: **Node CLI + encoder** and a reference decoder/query function.
- `zmc-decoder.ts`: **Minimal browser decoder** for MapLibre or any web app.

---

## Node CLI

The CLI reads a JSON “inventory” of rectangular coverages and writes a `.zmc` file.

Inventory schema (typical pmtiles-like listing):

```json
{
  "version": "0.0.3",
  "items": [
    {
      "name": "planet.pmtiles",
      "min_lon": -180.0, "min_lat": -85.0511287798066,
      "max_lon": 180.0,  "max_lat": 85.0511287798066,
      "min_zoom": 0, "max_zoom": 12
    },
    {
      "name": "6-34-22.pmtiles",
      "min_lon": 11.25, "min_lat": 45.0890,
      "max_lon": 16.875,"max_lat": 48.9225,
      "min_zoom": 13, "max_zoom": 17
    }
    // ... more rectangles
  ]
}
```

Packing policy:
- **base_zoom** is taken from a “global” item if present (covers the world in lon and the WebMercator latitude band); we use the highest `max_zoom` among such items.
- If no global item exists, you can pass `--base-zoom N`, else we fall back to `min(max_zoom)` across all items.
- Every item whose `max_zoom > base_zoom` becomes one rectangle at zoom = `max_zoom` (overlaps OK).
- Antimeridian crossing rectangles are automatically split during encoding.

### Install and run

With tsx:
```bash
tsx zmc-pack.ts input.json [output.zmc] [--base-zoom N]
```

Options:
- `--base-zoom N` override the derived base zoom.

Example with `example.json`:
```bash
tsx zmc-pack.ts example.json
[zmc] Base zoom: 12, higher-zoom rectangles: 6
[zmc] Wrote 140 bytes -> example.zmc
[zmc] Levels: 3, rects: 6, zmin=13, zmax=17
```

Programmatic usage (Node):
```ts
import fs from "node:fs";
import { encodeZMCF, decodeZMCF, queryMaxZoom } from "./zmc-pack";

const inv = JSON.parse(fs.readFileSync("inventory.json", "utf8"));
const { baseZoom, layers } = (function build() {
  // use buildLayersFromInventory from zmc.ts, or replicate the policy here
  // ... for brevity, call the CLI helpers or reuse the code
  return { baseZoom: 12, layers: new Map<number, any>() };
})();

const blob = encodeZMCF(baseZoom, layers);
fs.writeFileSync("planet.zmc", blob);

const buf = fs.readFileSync("planet.zmc");
console.log("Max zoom @ (47.5, 8.3):", queryMaxZoom(buf, 47.5, 8.3));
```

---

## Browser / MapLibre helper

Use `zmc-decoder.ts` to fetch and query a `.zmc` blob in your web app.

### API

```ts
class ZMCF {
  // Construct from URL (fetch + decode)
  static fromUrl(url: string, init?: RequestInit): Promise<ZMCF>;

  // Construct from ArrayBuffer (e.g., XMLHttpRequest, File input)
  static fromArrayBuffer(ab: ArrayBuffer): ZMCF;

  // Returns the maximum available zoom for a point
  queryMaxZoom(latDeg: number, lonDeg: number): number;

  // Property: base zoom
  readonly baseZoom: number;
}
```

---

## Performance and size notes

- Typical rectangle cost after varint + HTTP Brotli is **< 10–20 bytes/rect**, depending on your geography and overlaps.
- Query is O(number of rectangles in higher levels); because we check **higher zooms first**, most points will exit quickly.
- Microdegrees are int32 and fast to compare; decoding uses **typed arrays**.
- For huge rectangle counts, you can add a **coarse grid index** (not included in the minimal browser decoder). The binary format reserves a flag and offset for this.

---

## Edge cases and correctness

- **Antimeridian**: Rectangles that cross ±180° longitude are split by the encoder. The decoder expects non-crossing rectangles.
- **Latitudes**: For WebMercator display, your data should be within ±85.05113°. The CLI doesn’t crop latitudes; it preserves what you provide.
- **Inclusive bounds**: Rectangles include their edges: a point exactly on the boundary is considered inside.
- **Overlaps**: Exact by construction; the query returns the level of the first match when scanning from highest zoom.

---

## When not to use ZMCF

- If you must encode arbitrary shapes or angled polygons, this rectangle-only approach may be insufficient.
- If your coverage is inherently per-tile and you need per-tile metadata, a tile-based mask could be more direct (though much larger).

---

## Tips for serving

- Serve `.zmc` with **gzip/Brotli**; it compresses very well.
- Suggested extension: `.zmc`
- Suggested media type: `application/vnd.zoom-max-coverage+binary; version=1`

---

## FAQ

- Does the decoder support coarse indexes?
  - Not in the minimal browser build. The format reserves an index pointer though.
- Why WGS84 microdegrees instead of WebMercator x/y?
  - Directly matches MapLibre’s `lat/lon` API, avoids conversions; precision is more than enough; fits in int32.
- Can I store min/max as width/height?
  - Yes, that can compress slightly better if sizes repeat. We kept the layout simple and canonical.

---

## License

MIT. Contributions welcome.
