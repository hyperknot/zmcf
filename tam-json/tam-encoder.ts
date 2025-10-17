// tam-encoder.ts
//
// Encoder for TAM-JSON v1 (Tile Availability Map in JSON).
// - From rectangular inventory -> compact per-row tile runs per zoom.
// - JSON structure is small, readable, and fast to parse.
// - Overlaps at the same zoom resolve as "last item wins".
//
// Exported API:
// - encodeTamJson(inv, { baseZoom?, zmax? }): TamJson
// - Types: Inventory, InventoryItem, TamJson, TamJsonLevel

export type Inventory = {
  version?: string;
  items: InventoryItem[];
};

export type InventoryItem = {
  name?: string; // dataset id/name
  min_lon: number; min_lat: number;
  max_lon: number; max_lat: number;
  min_zoom: number; max_zoom: number;
};

export type TamJsonLevel = {
  z: number;
  // Rows are stored as flat numeric arrays for compactness:
  // First row uses absolute y; subsequent rows use delta from previous non-empty y.
  // Layout: [yToken, nRanges, dx0, len, ds, dx0, len, ds, ...]
  rows: number[][];
};

export type TamJson = {
  format: "tam-json-v1";
  zbase: number;
  zmax: number;
  datasets: (string | Record<string, unknown>)[];
  base_dataset: number; // -1 if none
  levels: TamJsonLevel[]; // typically zbase+1..zmax
};

/* ---------------------------------------------
 * Geometry and helpers
 * --------------------------------------------- */

type Range = { x0: number; x1: number; ds: number }; // inclusive
type RowsMap = Map<number, Range[]>; // y -> sorted, disjoint ranges

const WEBMERC_MAX_LAT = 85.0511287798066;
const WEBMERC_MIN_LAT = -WEBMERC_MAX_LAT;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/** A "global" item covers full lon and WebMercator latitude band. */
function isGlobalItem(it: InventoryItem): boolean {
  const lonOK = approx(it.min_lon, -180) && approx(it.max_lon, 180);
  const latOK = it.min_lat <= WEBMERC_MIN_LAT + 1e-6 && it.max_lat >= WEBMERC_MAX_LAT - 1e-6;
  return lonOK && latOK;
}

/** WebMercator: lon/lat -> [0..1) world coords, then multiply by n=2^z */
function lonToXf(lon: number, n: number): number {
  if (lon < -180 || lon > 180) lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return ((lon + 180) / 360) * n;
}
function latToYf(lat: number, n: number): number {
  const φ = clamp(lat, WEBMERC_MIN_LAT, WEBMERC_MAX_LAT) * Math.PI / 180;
  const s = Math.sin(φ);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return clamp(y * n, 0, n); // [0..n]
}

/** Inclusive tile x-ranges for lon bounds at zoom z (split at antimeridian if needed). */
function xRangesAtZoom(minLon: number, maxLon: number, z: number): [Range[], number] {
  const n = 1 << z;
  const xf0 = lonToXf(minLon, n);
  const xf1 = lonToXf(maxLon, n);
  if (minLon <= maxLon) {
    const x0 = clamp(Math.floor(xf0), 0, n - 1);
    const x1 = clamp(Math.ceil(xf1) - 1, 0, n - 1);
    return [[{ x0, x1, ds: 0 }], n];
  } else {
    const x0a = clamp(Math.floor(xf0), 0, n - 1);
    const x1a = n - 1;
    const x0b = 0;
    const x1b = clamp(Math.ceil(xf1) - 1, 0, n - 1);
    return [[{ x0: x0a, x1: x1a, ds: 0 }, { x0: x0b, x1: x1b, ds: 0 }], n];
  }
}

/** Inclusive y range for lat bounds at zoom z. */
function yRangeAtZoom(minLat: number, maxLat: number, z: number): [number, number, number] {
  const n = 1 << z;
  const yTop = latToYf(maxLat, n);  // smaller y (north)
  const yBot = latToYf(minLat, n);  // larger y (south)
  const y0 = clamp(Math.floor(yTop), 0, n - 1);
  const y1 = clamp(Math.ceil(yBot) - 1, 0, n - 1);
  return [y0, y1, n];
}

/** Merge adjacent runs with same dataset. Input must be sorted by x0 and disjoint. */
function mergeNeighbors(runs: Range[]): Range[] {
  if (runs.length <= 1) return runs;
  const out: Range[] = [];
  let curr = runs[0];
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i];
    if (r.ds === curr.ds && r.x0 === curr.x1 + 1) {
      curr.x1 = r.x1;
    } else {
      out.push(curr);
      curr = r;
    }
  }
  out.push(curr);
  return out;
}

/** Overlay [x0..x1] with dataset ds (last-wins). 'runs' must be sorted and disjoint. */
function overlayRange(runs: Range[], x0: number, x1: number, ds: number): Range[] {
  if (x0 > x1) return runs;
  const out: Range[] = [];
  let i = 0;

  // Copy runs strictly before the overlay
  while (i < runs.length && runs[i].x1 < x0) out.push(runs[i++]);

  // If a run overlaps x0, keep its left portion
  if (i < runs.length && runs[i].x0 < x0 && runs[i].x1 >= x0) {
    const left = { x0: runs[i].x0, x1: x0 - 1, ds: runs[i].ds };
    if (left.x0 <= left.x1) out.push(left);
    if (runs[i].x1 > x1) {
      // Run spans beyond overlay window
      if (x0 <= x1) out.push({ x0, x1, ds });
      out.push({ x0: x1 + 1, x1: runs[i].x1, ds: runs[i].ds });
      i++;
      while (i < runs.length) out.push(runs[i++]);
      return mergeNeighbors(out);
    }
    i++; // consumed the run up to x0..x1; continue through overlaps
  }

  let prevPos = x0;

  // Process runs that overlap [x0..x1]
  while (i < runs.length && runs[i].x0 <= x1) {
    const r = runs[i];
    if (prevPos <= r.x0 - 1) out.push({ x0: prevPos, x1: r.x0 - 1, ds });
    if (r.x1 > x1) {
      // Fill remaining overlay up to x1
      if (r.x0 <= x1 && prevPos <= x1) out.push({ x0: Math.max(prevPos, r.x0), x1, ds });
      // Right tail of the run survives
      out.push({ x0: x1 + 1, x1: r.x1, ds: r.ds });
      i++;
      while (i < runs.length) out.push(runs[i++]);
      return mergeNeighbors(out);
    }
    prevPos = Math.max(prevPos, r.x1 + 1);
    i++;
  }

  // No more overlaps; fill remainder and append trailing runs
  if (prevPos <= x1) out.push({ x0: prevPos, x1, ds });
  while (i < runs.length) out.push(runs[i++]);
  return mergeNeighbors(out);
}

function getOrInitRows(perZoomRows: Map<number, RowsMap>, z: number): RowsMap {
  let m = perZoomRows.get(z);
  if (!m) { m = new Map<number, Range[]>(); perZoomRows.set(z, m); }
  return m;
}

function insertRectCoverage(
  perZoomRows: Map<number, RowsMap>,
  item: InventoryItem,
  ds: number,
  zbase: number,
  zmax: number
) {
  const zTop = clamp(Math.floor(item.max_zoom), zbase + 1, zmax);
  for (let z = zbase + 1; z <= zTop; z++) {
    const [y0, y1, n] = yRangeAtZoom(item.min_lat, item.max_lat, z);
    const [rangesList] = xRangesAtZoom(item.min_lon, item.max_lon, z);
    const rows = getOrInitRows(perZoomRows, z);
    for (let y = y0; y <= y1; y++) {
      let runArr = rows.get(y) || [];
      for (const r of rangesList) {
        if (r.x0 < 0 || r.x1 >= n || r.x0 > r.x1) continue;
        runArr = overlayRange(runArr, r.x0, r.x1, ds);
      }
      rows.set(y, runArr);
    }
  }
}

/* ---------------------------------------------
 * Base zoom and dataset selection
 * --------------------------------------------- */

function chooseBase(inv: Inventory, override?: number): { baseZoom: number; baseDataset?: string; zmax: number } {
  const items = inv.items || [];
  let zmax = 0;
  for (const it of items) zmax = Math.max(zmax, it.max_zoom | 0);

  if (typeof override === "number") {
    const globals = items.filter(isGlobalItem).sort((a,b)=> (b.max_zoom|0)-(a.max_zoom|0));
    return { baseZoom: override|0, baseDataset: globals[0]?.name, zmax };
  }
  const globals = items.filter(isGlobalItem);
  if (globals.length) {
    const top = globals.sort((a,b)=> (b.max_zoom|0)-(a.max_zoom|0))[0];
    return { baseZoom: top.max_zoom|0, baseDataset: top.name, zmax };
  }
  if (items.length) {
    const baseZoom = Math.min(...items.map(i => i.max_zoom|0));
    return { baseZoom, zmax };
  }
  return { baseZoom: 0, zmax: 0 };
}

/* ---------------------------------------------
 * Public encoder
 * --------------------------------------------- */

export function encodeTamJson(inv: Inventory, opts?: { baseZoom?: number; zmax?: number }): TamJson {
  const { baseZoom, baseDataset, zmax: inferredZmax } = chooseBase(inv, opts?.baseZoom);
  const zmax = typeof opts?.zmax === "number" ? Math.min(opts!.zmax!, inferredZmax) : inferredZmax;

  // Build dataset table from item names
  const dsIndex = new Map<string, number>();
  const datasets: (string | Record<string, unknown>)[] = [];
  const ensureDs = (name: string) => {
    if (!dsIndex.has(name)) { dsIndex.set(name, datasets.length); datasets.push(name); }
    return dsIndex.get(name)!;
  };
  const baseDatasetId = baseDataset ? ensureDs(baseDataset) : -1;

  // per-zoom rows (y => ranges)
  const perZoomRows = new Map<number, RowsMap>();

  for (const it of inv.items || []) {
    const zTop = it.max_zoom | 0;
    if (zTop <= baseZoom) continue; // only higher-zoom overrides
    const name = it.name ?? `dataset-${datasets.length}`;
    const ds = ensureDs(name);
    insertRectCoverage(perZoomRows, it, ds, baseZoom, zmax);
  }

  // Build levels with delta-coded rows
  const levels: TamJsonLevel[] = [];
  for (let z = baseZoom + 1; z <= zmax; z++) {
    const rows = perZoomRows.get(z);
    if (!rows || rows.size === 0) { levels.push({ z, rows: [] }); continue; }

    const yKeys = Array.from(rows.keys()).sort((a,b)=> a-b);
    const rowArr: number[][] = [];
    let prevY = -1;

    for (const y of yKeys) {
      const runs = rows.get(y)!;
      if (runs.length === 0) continue;
      const line: number[] = [];
      const yToken = (prevY < 0 ? y : (y - prevY));
      line.push(yToken, runs.length);
      let prevEndPlus1 = 0;
      for (const r of runs) {
        const dx0 = r.x0 - prevEndPlus1;
        const len = r.x1 - r.x0 + 1;
        line.push(dx0, len, r.ds);
        prevEndPlus1 = r.x1 + 1;
      }
      rowArr.push(line);
      prevY = y;
    }

    levels.push({ z, rows: rowArr });
  }

  return {
    format: "tam-json-v1",
    zbase: baseZoom,
    zmax,
    datasets,
    base_dataset: baseDatasetId,
    levels
  };
}