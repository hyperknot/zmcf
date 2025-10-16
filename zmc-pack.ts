#!/usr/bin/env node
/**
 * ZMCF v1 in modern TypeScript + Node CLI
 *
 * - Encodes a compact "lat-lon -> max-zoom" coverage file (.zmc)
 * - Uses microdegrees quantization, LEB128 varints, and ZigZag deltas
 * - CLI packs from a JSON inventory like the example in the prompt
 *
 * Build/run:
 *   - With ts-node:    npx ts-node zmc.ts input.json output.zmc
 *   - Compile then run:
 *       tsc zmc.ts --target ES2020 --module commonjs --outDir dist
 *       node dist/zmc.js input.json output.zmc
 *
 * JSON input format expected:
 * {
 *   "version": "0.0.x",
 *   "items": [
 *     {
 *       "name": "planet.pmtiles",
 *       "min_lon": -180, "min_lat": -85.0511, "max_lon": 180, "max_lat": 85.0511,
 *       "min_zoom": 0, "max_zoom": 12
 *     },
 *     {
 *       "name": "...",
 *       "min_lon": x, "min_lat": y, "max_lon": u, "max_lat": v,
 *       "min_zoom": 13, "max_zoom": 17
 *     }
 *   ]
 * }
 *
 * Packing policy:
 * - base_zoom = max(max_zoom) among items that cover the whole world;
 *   if none exist, you can override with --base-zoom N, or we fallback to the min of all max_zoom.
 * - For each item with max_zoom > base_zoom, we add one rectangle at zoom := max_zoom.
 * - Overlaps are fine; querying returns the highest zoom first (short-circuit).
 */

import fs from "node:fs";
import path from "node:path";

/* ---------------------------------------------
 * Constants and types
 * --------------------------------------------- */

const MAGIC = "ZMC1";
const VERSION = 1;
const COORD_ENCODING_WGS84_MICRODEG = 0;

interface Rect {
  minLat: number; // degrees
  minLon: number; // degrees
  maxLat: number; // degrees
  maxLon: number; // degrees
}

interface RectQ {
  minLatQ: number; // microdegrees
  minLonQ: number;
  maxLatQ: number;
  maxLonQ: number;
}

interface LevelEntry {
  z: number;
  rectCount: number;
  relOffset: number; // offset within the Rectangles Block
}

interface JsonInventory {
  version: string;
  items: JsonItem[];
}

interface JsonItem {
  name?: string;
  url?: string;
  md5sum?: string;
  size?: number;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  min_zoom: number;
  max_zoom: number;
}

/* ---------------------------------------------
 * Small utilities
 * --------------------------------------------- */

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function quantizeMicrodeg(v: number): number {
  // WGS84 degrees -> microdegrees
  return Math.round(v * 1_000_000);
}

function splitAntimeridianIfNeeded(r: Rect): Rect[] {
  // If rectangle crosses the antimeridian, split into two
  // Otherwise return as-is
  // Keep lat order normalized
  let minLat = Math.min(r.minLat, r.maxLat);
  let maxLat = Math.max(r.minLat, r.maxLat);
  let minLon = r.minLon;
  let maxLon = r.maxLon;

  // Clamp longitudes to [-180, 180]
  minLon = clamp(minLon, -180, 180);
  maxLon = clamp(maxLon, -180, 180);

  if (minLon <= maxLon) {
    return [{ minLat, minLon, maxLat, maxLon }];
  } else {
    // Crosses antimeridian: e.g., minLon=170, maxLon=-170
    return [
      { minLat, minLon, maxLat, maxLon: 180 },
      { minLat, minLon: -180, maxLat, maxLon },
    ];
  }
}

function compareRectQ(a: RectQ, b: RectQ): number {
  if (a.minLatQ !== b.minLatQ) return a.minLatQ - b.minLatQ;
  if (a.minLonQ !== b.minLonQ) return a.minLonQ - b.minLonQ;
  if (a.maxLatQ !== b.maxLatQ) return a.maxLatQ - b.maxLatQ;
  return a.maxLonQ - b.maxLonQ;
}

/* ---------------------------------------------
 * Varint + ZigZag (32-bit)
 * --------------------------------------------- */

function zigzagEncode32(n: number): number {
  // force to 32-bit
  n |= 0;
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function zigzagDecode32(u: number): number {
  // u is unsigned 32
  return ((u >>> 1) ^ -(u & 1)) | 0;
}

function encodeUVarint(n: number): number[] {
  if (n < 0) throw new Error("uvarint negative");
  const out: number[] = [];
  // treat as unsigned 32-bit
  n >>>= 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function decodeUVarint(buf: Uint8Array, off: number): { value: number; offset: number } {
  let shift = 0;
  let result = 0 >>> 0;
  while (true) {
    if (off >= buf.length) throw new Error("Buffer underflow in uvarint");
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("uvarint too long");
  }
  // result is still <= 2^32-1
  return { value: result >>> 0, offset: off };
}

function encodeSVarint(n: number): number[] {
  const zz = zigzagEncode32(n);
  return encodeUVarint(zz);
}

function decodeSVarint(buf: Uint8Array, off: number): { value: number; offset: number } {
  const { value: u, offset } = decodeUVarint(buf, off);
  return { value: zigzagDecode32(u), offset };
}

/* ---------------------------------------------
 * Binary write helpers (little-endian)
 * --------------------------------------------- */

function writeU8(arr: number[], v: number): void {
  arr.push(v & 0xff);
}
function writeU16LE(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}
function writeU32LE(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/* ---------------------------------------------
 * Encoder
 * --------------------------------------------- */

export function encodeZMCF(
  baseZoom: number,
  layers: Map<number, Rect[]>,
): Buffer {
  // Build level data: sort zooms descending
  const levelZs = Array.from(layers.keys())
    .filter((z) => z > baseZoom)
    .sort((a, b) => b - a);

  const levelsData: { z: number; rectsQ: RectQ[] }[] = [];
  let rectsTotal = 0;

  for (const z of levelZs) {
    const rects = layers.get(z) || [];
    const rectsQ: RectQ[] = [];
    for (const r of rects) {
      const parts = splitAntimeridianIfNeeded(r);
      for (const p of parts) {
        // Normalize and quantize
        const minLat = Math.min(p.minLat, p.maxLat);
        const maxLat = Math.max(p.minLat, p.maxLat);
        const minLon = Math.min(p.minLon, p.maxLon);
        const maxLon = Math.max(p.minLon, p.maxLon);
        const minLatQ = quantizeMicrodeg(minLat);
        const minLonQ = quantizeMicrodeg(minLon);
        const maxLatQ = quantizeMicrodeg(maxLat);
        const maxLonQ = quantizeMicrodeg(maxLon);
        rectsQ.push({ minLatQ, minLonQ, maxLatQ, maxLonQ });
      }
    }
    rectsQ.sort(compareRectQ);
    rectsTotal += rectsQ.length;
    levelsData.push({ z, rectsQ });
  }

  // Level Directory + Rectangles block
  const levelDirEntries: LevelEntry[] = [];
  const rectChunks: number[][] = [];
  let dataRelOffset = 0;

  for (const { z, rectsQ } of levelsData) {
    const chunk: number[] = [];
    // Per-level count
    for (const b of encodeUVarint(rectsQ.length)) chunk.push(b);

    // Delta encode
    let prevMinLatQ = 0;
    let prevMinLonQ = 0;
    let prevMaxLatQ = 0;
    let prevMaxLonQ = 0;

    for (const r of rectsQ) {
      const dMinLat = (r.minLatQ | 0) - (prevMinLatQ | 0);
      const dMinLon = (r.minLonQ | 0) - (prevMinLonQ | 0);
      const dMaxLat = (r.maxLatQ | 0) - (prevMaxLatQ | 0);
      const dMaxLon = (r.maxLonQ | 0) - (prevMaxLonQ | 0);
      for (const b of encodeSVarint(dMinLat)) chunk.push(b);
      for (const b of encodeSVarint(dMinLon)) chunk.push(b);
      for (const b of encodeSVarint(dMaxLat)) chunk.push(b);
      for (const b of encodeSVarint(dMaxLon)) chunk.push(b);
      prevMinLatQ = r.minLatQ | 0;
      prevMinLonQ = r.minLonQ | 0;
      prevMaxLatQ = r.maxLatQ | 0;
      prevMaxLonQ = r.maxLonQ | 0;
    }

    levelDirEntries.push({ z, rectCount: rectsQ.length, relOffset: dataRelOffset });
    rectChunks.push(chunk);
    dataRelOffset += chunk.length;
  }

  const levelsCount = levelDirEntries.length;
  const zminOverrides = levelsCount
    ? levelDirEntries.map((e) => e.z).reduce((a, b) => Math.min(a, b))
    : (baseZoom + 1);
  const zmaxOverrides = levelsCount
    ? levelDirEntries.map((e) => e.z).reduce((a, b) => Math.max(a, b))
    : baseZoom;

  // Build the Level Directory bytes
  const levelDirBytes: number[] = [];
  for (const e of levelDirEntries) {
    writeU8(levelDirBytes, e.z);
    writeU32LE(levelDirBytes, e.rectCount >>> 0);
    writeU32LE(levelDirBytes, e.relOffset >>> 0);
  }

  // Rectangles Block bytes
  const rectBlockBytes = rectChunks.flat();

  // Header
  const headerBytes: number[] = [];
  // magic
  for (const c of MAGIC) headerBytes.push(c.charCodeAt(0));
  // version, coord_enc, flags, base_zoom
  writeU8(headerBytes, VERSION);
  writeU8(headerBytes, COORD_ENCODING_WGS84_MICRODEG);
  writeU8(headerBytes, 0); // flags (no coarse index)
  writeU8(headerBytes, baseZoom & 0xff);
  // zmin_overrides, zmax_overrides, reserved u16
  writeU8(headerBytes, zminOverrides & 0xff);
  writeU8(headerBytes, zmaxOverrides & 0xff);
  writeU16LE(headerBytes, 0);
  // levels_count, rects_total_count (u32)
  writeU32LE(headerBytes, levelsCount >>> 0);
  writeU32LE(headerBytes, rectsTotal >>> 0);

  // offsets (absolute)
  const levelDirOffset = headerBytes.length + 12; // after we write placeholders, but we can compute actual below
  const levelDirLength = levelDirBytes.length;
  const dataOffsetAbs = headerBytes.length + 12 + levelDirLength;
  const indexOffsetAbs = 0; // no index

  // placeholders -> now write actual offsets
  writeU32LE(headerBytes, levelDirOffset >>> 0);
  writeU32LE(headerBytes, dataOffsetAbs >>> 0);
  writeU32LE(headerBytes, indexOffsetAbs >>> 0);

  // Assemble
  const headerBuf = Buffer.from(Uint8Array.from(headerBytes));
  const levelDirBuf = Buffer.from(Uint8Array.from(levelDirBytes));
  const rectBlockBuf = Buffer.from(Uint8Array.from(rectBlockBytes));

  return Buffer.concat([headerBuf, levelDirBuf, rectBlockBuf]);
}

/* ---------------------------------------------
 * Decoder (optional, for validation / debugging)
 * --------------------------------------------- */

export function decodeZMCF(buf: Uint8Array) {
  let off = 0;

  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== MAGIC) throw new Error("Bad magic");
  off += 4;

  const version = buf[off++];
  const coordEnc = buf[off++];
  const flags = buf[off++];
  const baseZoom = buf[off++];

  if (version !== VERSION) throw new Error("Unsupported version");
  if (coordEnc !== COORD_ENCODING_WGS84_MICRODEG) throw new Error("Unsupported coord encoding");

  const zminOverrides = buf[off++];
  const zmaxOverrides = buf[off++];
  off += 2; // reserved

  const levelsCount =
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  off += 4;

  const rectsTotal =
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  off += 4;

  const levelDirOffset =
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  off += 4;

  const dataOffsetAbs =
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  off += 4;

  const indexOffsetAbs =
    buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  off += 4;

  // Level Directory
  let ldoff = levelDirOffset;
  const levelDir: LevelEntry[] = [];
  for (let i = 0; i < levelsCount; i++) {
    const z = buf[ldoff++];
    const rectCount =
      buf[ldoff] | (buf[ldoff + 1] << 8) | (buf[ldoff + 2] << 16) | (buf[ldoff + 3] << 24);
    ldoff += 4;
    const relOffset =
      buf[ldoff] | (buf[ldoff + 1] << 8) | (buf[ldoff + 2] << 16) | (buf[ldoff + 3] << 24);
    ldoff += 4;
    levelDir.push({ z, rectCount, relOffset });
  }

  // Rectangles
  const levels: { z: number; rectsQ: RectQ[] }[] = [];
  for (const { z, rectCount, relOffset } of levelDir) {
    let p = dataOffsetAbs + relOffset;
    const decCount = decodeUVarint(buf, p);
    const n = decCount.value;
    p = decCount.offset;
    if (n !== rectCount) throw new Error("Rect count mismatch in chunk");

    const rectsQ: RectQ[] = [];
    let prevMinLatQ = 0;
    let prevMinLonQ = 0;
    let prevMaxLatQ = 0;
    let prevMaxLonQ = 0;

    for (let i = 0; i < rectCount; i++) {
      const d1 = decodeSVarint(buf, p); p = d1.offset;
      const d2 = decodeSVarint(buf, p); p = d2.offset;
      const d3 = decodeSVarint(buf, p); p = d3.offset;
      const d4 = decodeSVarint(buf, p); p = d4.offset;

      const minLatQ = (prevMinLatQ + d1.value) | 0;
      const minLonQ = (prevMinLonQ + d2.value) | 0;
      const maxLatQ = (prevMaxLatQ + d3.value) | 0;
      const maxLonQ = (prevMaxLonQ + d4.value) | 0;

      rectsQ.push({ minLatQ, minLonQ, maxLatQ, maxLonQ });
      prevMinLatQ = minLatQ; prevMinLonQ = minLonQ; prevMaxLatQ = maxLatQ; prevMaxLonQ = maxLonQ;
    }
    levels.push({ z, rectsQ });
  }

  return {
    version,
    coordEnc,
    flags,
    baseZoom,
    zminOverrides,
    zmaxOverrides,
    levelsCount,
    rectsTotal,
    levelDirOffset,
    dataOffsetAbs,
    indexOffsetAbs,
    levelDir,
    levels,
  };
}

/* ---------------------------------------------
 * Query (optional; exact point max-zoom)
 * --------------------------------------------- */

export function queryMaxZoom(buf: Uint8Array, lat: number, lon: number): number {
  const decoded = decodeZMCF(buf);
  const latQ = quantizeMicrodeg(lat);
  const lonQ = quantizeMicrodeg(lon);

  // Scan stored levels in the order given by the Level Directory
  // If you encoded descending by z, this short-circuits efficiently.
  for (const { z, rectsQ } of decoded.levels) {
    for (const r of rectsQ) {
      if (r.minLatQ <= latQ && latQ <= r.maxLatQ && r.minLonQ <= lonQ && lonQ <= r.maxLonQ) {
        return z;
      }
    }
  }
  return decoded.baseZoom;
}

/* ---------------------------------------------
 * Packing from JSON inventory
 * --------------------------------------------- */

function isGlobalItem(i: JsonItem): boolean {
  const lonOK = approxEqual(i.min_lon, -180, 1e-6) && approxEqual(i.max_lon, 180, 1e-6);
  // MapLibre/WebMercator practical latitude limits
  const minLat = -85.0511287798066;
  const maxLat = 85.0511287798066;
  const latOK = i.min_lat <= minLat + 1e-6 && i.max_lat >= maxLat - 1e-6;
  return lonOK && latOK;
}

function buildLayersFromInventory(inv: JsonInventory, baseZoomOverride?: number) {
  const items = inv.items || [];

  // Determine base zoom: prefer a global item; else fallback
  const globalItems = items.filter(isGlobalItem);
  let baseZoom: number | undefined = undefined;
  if (typeof baseZoomOverride === "number") {
    baseZoom = baseZoomOverride | 0;
  } else if (globalItems.length > 0) {
    baseZoom = Math.max(...globalItems.map((it) => it.max_zoom | 0));
  } else if (items.length > 0) {
    // Fallback: choose min(max_zoom) across items, so that any region with higher max overrides
    baseZoom = Math.min(...items.map((it) => it.max_zoom | 0));
    console.warn(
      `[zmc] No global item found; falling back to base_zoom=${baseZoom}. You can override with --base-zoom N.`,
    );
  } else {
    baseZoom = 0;
  }

  const layers = new Map<number, Rect[]>();
  let added = 0;

  for (const it of items) {
    const z = it.max_zoom | 0;
    if (z <= (baseZoom | 0)) continue; // not increasing max zoom; ignore
    // Add as a single rectangle at zoom = max_zoom
    const rect: Rect = {
      minLat: it.min_lat,
      minLon: it.min_lon,
      maxLat: it.max_lat,
      maxLon: it.max_lon,
    };
    if (!layers.has(z)) layers.set(z, []);
    layers.get(z)!.push(rect);
    added++;
  }

  // Ensure deterministic order of rectangles within layers (optional; encode will sort anyway)
  for (const z of layers.keys()) {
    const arr = layers.get(z)!;
    layers.set(
      z,
      arr.map((r) => ({
        minLat: r.minLat,
        minLon: r.minLon,
        maxLat: r.maxLat,
        maxLon: r.maxLon,
      })),
    );
  }

  return { baseZoom, layers, added };
}

/* ---------------------------------------------
 * CLI
 * --------------------------------------------- */

function printUsageAndExit(): never {
  console.log(`Usage:
  zmc-pack input.json [output.zmc] [--base-zoom N]

Description:
  Packs a JSON inventory of rectangular coverages into a compact .zmc file
  that maps any (lat, lon) to the maximum available zoom.

Options:
  --base-zoom N    Override base zoom if no global item exists, or to force a value.

Examples:
  npx ts-node zmc.ts data.json out.zmc
  node dist/zmc.js data.json out.zmc
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length < 1) printUsageAndExit();
  let input = "";
  let output = "";
  let baseZoomOverride: number | undefined;

  // Simple positional args: input [output] + flags
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-zoom") {
      const v = args[++i];
      if (!v) {
        console.error("Missing value for --base-zoom");
        printUsageAndExit();
      }
      baseZoomOverride = parseInt(v, 10);
      if (!Number.isFinite(baseZoomOverride) || baseZoomOverride < 0) {
        console.error("Invalid --base-zoom value");
        printUsageAndExit();
      }
    } else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      printUsageAndExit();
    } else {
      rest.push(a);
    }
  }

  if (rest.length < 1) printUsageAndExit();
  input = rest[0];
  output = rest[1] || input.replace(/\.[^.]+$/, "") + ".zmc";
  if (!output.endsWith(".zmc")) output = output + ".zmc";
  return { input, output, baseZoomOverride };
}

function mainCLI() {
  const { input, output, baseZoomOverride } = parseArgs(process.argv);
  const raw = fs.readFileSync(input, "utf8");

  let inv: JsonInventory;
  try {
    inv = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse input JSON:", e);
    process.exit(2);
  }
  if (!inv || !Array.isArray(inv.items)) {
    console.error("Invalid JSON inventory: missing 'items' array");
    process.exit(2);
  }

  const { baseZoom, layers, added } = buildLayersFromInventory(inv, baseZoomOverride);
  console.log(`[zmc] Base zoom: ${baseZoom}, higher-zoom rectangles: ${added}`);

  const buf = encodeZMCF(baseZoom, layers);
  fs.writeFileSync(output, buf);
  console.log(`[zmc] Wrote ${buf.length} bytes -> ${output}`);

  // Optional tiny sanity check: decode and count
  try {
    const dec = decodeZMCF(buf);
    console.log(
      `[zmc] Levels: ${dec.levelsCount}, rects: ${dec.rectsTotal}, zmin=${dec.zminOverrides}, zmax=${dec.zmaxOverrides}`,
    );
  } catch (e) {
    console.warn("[zmc] Warning: decode sanity check failed:", e);
  }
}

if (require.main === module) {
  mainCLI();
}
