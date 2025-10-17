# ZMJ: Zoom-Max JSON

A tiny, human-readable JSON format that answers:

- **What is the maximum available zoom at this lat/lon?**
- **Which dataset provides that most-detailed coverage?**

It compresses well over HTTP and is trivial to decode in the browser.

## Key Properties

- **Simple**: Plain JSON; one object per rectangle
- **Fast**: Scan rectangles in descending zoom and return on the first hit

## Why Another Format?

- You have a base map (e.g., z12) and some regions with higher zoom (z15 country, z18 mountain)
- You want a precise, exact answer for "max zoom at point," plus attribution for the dataset providing it

## How It Works

The max zoom at a point is the maximum across:

- A **base zoom** (global), plus a **base dataset** string
- A set of **axis-aligned rectangles**, each with its own zoom and dataset string

**Query algorithm:**

1. Rectangles are scanned from highest zoom to lowest
2. The first hit wins and returns `{zoom, dataset}`
3. If no rectangle matches, return `{base_zoom, base_dataset}`

**Coordinates:**

- Stored as degrees (numbers)
- Antimeridian is supported without splitting: if `min_lon > max_lon`, the rectangle wraps across ±180°

## File Format

### Root Fields

| Field          | Type             | Description                |
| -------------- | ---------------- | -------------------------- |
| `base_zoom`    | integer (0..255) | Global fallback zoom level |
| `base_dataset` | string or null   | Global dataset name/ID     |
| `rects`        | array            | List of rectangle entries  |

### Rectangle Entry

| Field     | Type             | Description                          |
| --------- | ---------------- | ------------------------------------ |
| `z`       | integer (0..255) | Zoom level for this rectangle        |
| `dataset` | string           | Dataset ID/name/slug for attribution |
| `min_lat` | number           | Minimum latitude in degrees          |
| `min_lon` | number           | Minimum longitude in degrees         |
| `max_lat` | number           | Maximum latitude in degrees          |
| `max_lon` | number           | Maximum longitude in degrees         |

**Note:** Bounds are inclusive. Antimeridian wrap is allowed if `min_lon > max_lon`.

### Example

```json
{
  "base_zoom": 12,
  "base_dataset": "planet",
  "rects": [
    {
      "z": 17,
      "dataset": "abc",
      "min_lat": 45.089,
      "min_lon": 11.25,
      "max_lat": 48.922,
      "max_lon": 16.875
    },
    {
      "z": 17,
      "dataset": "def",
      "min_lat": 45.089,
      "min_lon": 5.625,
      "max_lat": 48.922,
      "max_lon": 11.25
    }
}
```

## Design Decisions

- **JSON over binary**: Human-friendly; gzip/Brotli makes it small enough for hundreds to thousands of rectangles
- **String dataset IDs inline**: No separate lookup table; simpler attribution handling
- **No index**: Linear scan is extremely fast at these sizes and easy to reason about
- **Antimeridian without splitting**: Keep `min_lon > max_lon` for wrapped rectangles; decoder handles it

## Installation & Usage

### Node CLI: `zmj-pack.ts`

Converts a PMTiles-style inventory into a ZMJ file.

#### Input Format

```json
{
  "version": "0.0.3",
  "items": [
    {
      "name": "planet.pmtiles",
      "min_lon": -180.0,
      "min_lat": -85.0511287798066,
      "max_lon": 180.0,
      "max_lat": 85.0511287798066,
      "min_zoom": 0,
      "max_zoom": 12
    },
    {
      "name": "6-34-22.pmtiles",
      "min_lon": 11.25,
      "min_lat": 45.089,
      "max_lon": 16.875,
      "max_lat": 48.9225,
      "min_zoom": 13,
      "max_zoom": 17
    }
  ]
}
```

#### Packing Policy

- **Base zoom** is derived from a global item (covers full lon and WebMercator lat band)
- If none is found, fallback to `min(max_zoom)` across items, or use `--base-zoom` to override
- Every item with `max_zoom > base_zoom` becomes one rectangle at `z = max_zoom`
- `dataset` per rectangle is the item's `name`
- `base_dataset` is the chosen global item's `name` (if any)

#### Run

```bash
# With tsx
tsx zmj-pack.ts inventory.json [output.zmj.json] [--base-zoom N]

# With ts-node
npx ts-node zmj-pack.ts inventory.json [output.zmj.json] [--base-zoom N]

# With Node.js (if transpiled)
node zmj-pack.js inventory.json output.zmj.json --base-zoom 10
```

### Browser / MapLibre: `zmj-decoder.ts`

Minimal decoder for web apps.

#### API

**Class: `ZMJ`**

```typescript
// Load from URL
static async fromUrl(url: string, init?: RequestInit): Promise<ZMJ>

// Load from object
static fromObject(obj: ZMJJson): ZMJ

// Query for zoom + dataset
query(latDeg: number, lonDeg: number): { zoom: number; dataset: string | null }

// Query for zoom only (helper)
queryMaxZoom(latDeg: number, lonDeg: number): number

// Properties
readonly baseZoom: number
readonly baseDataset: string | null
```

#### Example Usage

```typescript
import { ZMJ } from './zmj-decoder'

// Load from network
const zmj = await ZMJ.fromUrl('/coverage.zmj.json')

// Query a point
const result = zmj.query(47.5, 8.3)
console.log(`Zoom: ${result.zoom}, Dataset: ${result.dataset}`)

// Or just get the zoom
const maxZoom = zmj.queryMaxZoom(47.5, 8.3)
```

## Performance & Size Notes

- **Query performance**: O(N) with early-out; N in the hundreds/thousands is effectively instant in modern browsers
- **File size**: JSON is larger than binary raw, but gzip/Brotli shrinks it well due to repetitive structure
- **Scaling**: If you ever have tens of thousands of rectangles, consider adding a coarse grid index (out of scope here)

## Edge Cases & Correctness

### Antimeridian Handling

If `min_lon > max_lon`, the rectangle wraps across ±180°:

```typescript
// Decoder checks: (lon >= min_lon || lon <= max_lon)
```

### Bounds

- **Inclusive**: Points on edges are considered inside
- **Latitude normalization**: Encoder ensures `min_lat <= max_lat`
- **Longitude order**: Preserved to maintain wrap behavior

## When NOT to Use ZMJ

- ❌ Compact binary required for extremely constrained bandwidth and millions of rectangles
- ❌ You need polygons or angled shapes (rectangles-only may be insufficient)
- ❌ Sub-millisecond query time is critical with tens of thousands of rectangles

## Tips for Serving

- ✅ Serve with **gzip/Brotli compression**
- ✅ Use a **stable dataset string** that your UI can map to full attribution text
- ✅ Set appropriate **cache headers** for static files

## FAQ

### Why JSON not binary?

For **simplicity and maintainability**. For the target sizes (hundreds to thousands of rectangles), decode speed is excellent and compressed sizes remain small.

### Why store dataset strings per rectangle?

Easiest way to display attribution without indirection. For many datasets with repeated names, HTTP compression eliminates redundancy.

### Can I use this with Leaflet/OpenLayers?

Yes! The decoder is framework-agnostic. Just call `zmj.queryMaxZoom(lat, lon)` to get the max zoom for any point.

### How do I handle attribution?

The `dataset` string returned by `query()` can be used as a key to look up full attribution text in your app.

## Repository Layout

```
zmj-pack.ts       - Node/TypeScript CLI + encoder for .zmj.json files
zmj-decoder.ts    - Minimal browser decoder for MapLibre/web apps
README.md         - This file
```

## License

MIT. Contributions welcome.

## Contributing

- Keep it simple
- Maintain backward compatibility
- Add tests for edge cases (especially antimeridian)
- Update README for any API changes
