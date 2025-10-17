# README.md

# ZMJ: Zoom‑Max JSON

A tiny, human-readable JSON that answers:
- What is the maximum available zoom at this lat/lon?
- Which dataset provides that most-detailed coverage?

ZMJ aims to be radically simple for everyday developers. It stores a base zoom/dataset and a few hundred rectangular overrides, each with a zoom and dataset ID string. No varints, no deltas, no directories. It compresses well over HTTP and is trivial to decode in the browser.

Key properties
- Simple: plain JSON; one object per rectangle.
- Fast: scan rectangles in descending zoom and return on the first hit.
- Practical: antimeridian rectangles are supported without splitting.

---

Why another format?

- You have a base map (e.g., z12) and some regions with higher zoom (z15 country, z18 mountain).
- You want a precise, exact answer for “max zoom at point,” plus attribution for the dataset providing it.
- You prefer code that’s easy to read and maintain over micro-optimizations.

---

How it works

- The max zoom at a point is the maximum across:
  - A base zoom (global), plus a base dataset string.
  - A set of axis-aligned rectangles, each with its own zoom and dataset string.
- Rectangles are scanned from highest zoom to lowest; the first hit wins.
- Coordinates are stored as degrees (numbers). The decoder compares in degrees.
- Antimeridian is supported without splitting: if min_lon > max_lon, the rectangle wraps across ±180°.

Query
- For each rectangle (sorted by z desc):
  - If the latitude is inside and the longitude is inside (with wrap-aware check), return {zoom, dataset}.
- If none matches, return {base_zoom, base_dataset}.

---

File format (ZMJ JSON v1)

- Root fields:
  - format: "zmj-json-v1"
  - base_zoom: integer (0..255)
  - base_dataset: string or null
  - rects: array of rectangle entries
- Rectangle entry:
  - z: integer zoom (0..255)
  - dataset: string (ID/name/slug you want to display or map to attribution)
  - min_lat, min_lon, max_lat, max_lon: numbers in degrees
  - Inclusive bounds; antimeridian wrap allowed if min_lon > max_lon

Example:
{
  "format": "zmj-json-v1",
  "base_zoom": 12,
  "base_dataset": "planet.pmtiles",
  "rects": [
    { "z": 17, "dataset": "6-34-22.pmtiles", "min_lat": 45.0890356, "min_lon": 11.25, "max_lat": 48.9224993, "max_lon": 16.875 },
    { "z": 14, "dataset": "6-35-22.pmtiles", "min_lat": 45.0890356, "min_lon": 16.875, "max_lat": 48.9224993, "max_lon": 22.5 }
  ]
}

---

Design decisions

- JSON over binary: human-friendly; gzip/Brotli makes it small enough for “hundreds to a couple thousand” rectangles.
- String dataset IDs inline: no separate lookup table; simpler attribution handling.
- No index: linear scan is extremely fast at these sizes and easy to reason about.
- Antimeridian without splitting: keep min_lon > max_lon for wrapped rectangles; decoder handles it.

---

Repository layout

- zmj-pack.ts — Node/TypeScript CLI + encoder for .zmj.json files.
- zmj-decoder.ts — Minimal browser decoder for MapLibre/web apps.

---

Node CLI

Input JSON (pmtiles-style inventory):
{
  "version": "0.0.3",
  "items": [
    {
      "name": "planet.pmtiles",
      "min_lon": -180.0, "min_lat": -85.0511287798066,
      "max_lon":  180.0, "max_lat":  85.0511287798066,
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
- dataset per rectangle is the item’s name.
- base_dataset is the chosen global item’s name (if any).

Install and run
- With tsx:
  - tsx zmj-pack.ts inventory.json [output.zmj.json] [--base-zoom N]
- With ts-node:
  - npx ts-node zmj-pack.ts inventory.json [output.zmj.json] [--base-zoom N]

---

Browser / MapLibre helper

API
- class ZMJ
  - static fromUrl(url: string, init?: RequestInit): Promise<ZMJ>
  - static fromObject(obj: ZMJJson): ZMJ
  - query(latDeg: number, lonDeg: number): { zoom: number; dataset: string | null }
  - queryMaxZoom(latDeg: number, lonDeg: number): number
  - fields: baseZoom: number; baseDataset: string | null

Usage (pseudo)
const zmj = await ZMJ.fromUrl("/coverage.zmj.json");
const r = zmj.query(47.5, 8.3); // { zoom, dataset }

---

Performance and size notes

- Query is O(N) with early-out; N in the hundreds/thousands is effectively instant in modern browsers.
- JSON size is larger than binary raw, but gzip/Brotli shrinks it well; structure is repetitive.
- If you ever have tens of thousands of rectangles, consider adding a coarse grid index (out of scope here).

---

Edge cases and correctness

- Antimeridian: if min_lon > max_lon, the rectangle wraps; decoder checks (lon >= min_lon || lon <= max_lon).
- Inclusive bounds: points on edges are considered inside.
- Latitude normalization: encoder ensures min_lat <= max_lat; longitudes are kept as provided to preserve wrap behavior.

---

When not to use ZMJ

- If you need compact binary for extremely constrained bandwidth and millions of rectangles, use a binary variant.
- If you need polygons or angled shapes, rectangles-only may be insufficient.

---

Tips for serving

- Serve with gzip/Brotli compression.
- Use a stable dataset string that your UI can map to full attribution text if needed.

---

FAQ

- Why JSON not binary?
  - For simplicity and maintainability. For the target sizes, decode speed is excellent and compressed sizes remain small.
- Why store dataset strings per rectangle?
  - Easiest way to display attribution without indirection. For many datasets with repeated names, HTTP compression eliminates redundancy.

---

License

MIT. Contributions welcome.