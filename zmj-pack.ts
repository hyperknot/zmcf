/**
 * ZMJ (Zoom-Max JSON) encoder + CLI (TypeScript, Node 18+)
 *
 * - Reads a pmtiles-style inventory and emits a compact ZMJ JSON.
 * - Each rectangle: { z, dataset, min_lat, min_lon, max_lat, max_lon }.
 * - Antimeridian wrap supported by allowing min_lon > max_lon.
 *
 * Notes for contributors:
 * - Keep it simple; only rectangles with z > base_zoom are emitted.
 * - Preserve lon order to keep possible wrap (min_lon may be > max_lon).
 * - Sort by descending z so clients can early-out during queries.
 */

import fs from "node:fs";

/* ------------------------
 * Types
 * ------------------------ */

export type JsonInventory = { version: string; items: JsonItem[] };
export type JsonItem = {
  name?: string;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  min_zoom: number;
  max_zoom: number;
};

export type ZMJRect = {
  z: number;
  dataset: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

export type ZMJJson = {
  base_zoom: number;
  base_dataset: string | null;
  rects: ZMJRect[];
};

/* ------------------------
 * Helpers
 * ------------------------ */

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function isGlobalItem(it: JsonItem): boolean {
  const lonOK = approx(it.min_lon, -180) && approx(it.max_lon, 180);
  const minLat = -85.0511287798066,
    maxLat = 85.0511287798066;
  const latOK = it.min_lat <= minLat + 1e-6 && it.max_lat >= maxLat - 1e-6;
  return lonOK && latOK;
}

/**
 * Choose base zoom (and dataset name if a global item exists).
 * If override is provided, prefer it, but still try to pick a base dataset name from a global item.
 */
function chooseBase(
  inv: JsonInventory,
  override?: number
): { baseZoom: number; baseDataset?: string } {
  const items = inv.items || [];
  if (typeof override === "number") {
    const globals = items.filter(isGlobalItem);
    const baseDataset = globals.sort(
      (a, b) => (b.max_zoom | 0) - (a.max_zoom | 0)
    )[0]?.name;
    return { baseZoom: override | 0, baseDataset };
  }
  const globals = items.filter(isGlobalItem);
  if (globals.length) {
    const top = globals.sort(
      (a, b) => (b.max_zoom | 0) - (a.max_zoom | 0)
    )[0];
    return { baseZoom: top.max_zoom | 0, baseDataset: top.name };
  }
  if (items.length) {
    const baseZoom = Math.min(...items.map((i) => i.max_zoom | 0));
    return { baseZoom };
  }
  return { baseZoom: 0 };
}

/**
 * Build the ZMJ JSON object.
 * - Only include rectangles with z > baseZoom.
 * - Normalize lat so min_lat <= max_lat; preserve lon order for wrap.
 */
export function buildZMJFromInventory(
  inv: JsonInventory,
  baseZoom: number,
  baseDataset?: string
): ZMJJson {
  const rects: ZMJRect[] = [];
  for (const it of inv.items || []) {
    const z = it.max_zoom | 0;
    if (z <= baseZoom) continue;
    const dataset = it.name ?? "dataset";
    const min_lat = round3(Math.min(it.min_lat, it.max_lat));
    const max_lat = round3(Math.max(it.min_lat, it.max_lat));
    rects.push({
      z,
      dataset,
      min_lat,
      min_lon: round3(it.min_lon),
      max_lat,
      max_lon: round3(it.max_lon),
    });
  }
  rects.sort((a, b) => b.z - a.z);
  return {
    base_zoom: baseZoom,
    base_dataset: baseDataset ?? null,
    rects,
  };
}

/* ------------------------
 * CLI
 * ------------------------ */

function usage(): never {
  console.log("Usage: zmj-pack input.json [output.zmj.json] [--base-zoom N]");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();

  let input = "",
    output = "",
    baseOverride: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-zoom") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("Invalid --base-zoom");
        process.exit(1);
      }
      baseOverride = v | 0;
    } else {
      rest.push(a);
    }
  }
  input = rest[0];
  output = rest[1] || input.replace(/\.[^.]+$/, "") + ".zmj.json";
  if (!output.endsWith(".json")) output += ".json";

  const inv: JsonInventory = JSON.parse(fs.readFileSync(input, "utf8"));
  const { baseZoom, baseDataset } = chooseBase(inv, baseOverride);
  const zmj = buildZMJFromInventory(inv, baseZoom, baseDataset);

  // Minified JSON for size; change to 2 spaces if you prefer pretty output.
  const data = JSON.stringify(zmj);
  fs.writeFileSync(output, data);
  console.log(
    `[zmj] Base zoom: ${zmj.base_zoom}, base dataset: ${
      zmj.base_dataset ?? "none"
    }, rects: ${zmj.rects.length}, wrote ${Buffer.byteLength(
      data
    )} bytes -> ${output}`
  );
}

if (require.main === module) main();
