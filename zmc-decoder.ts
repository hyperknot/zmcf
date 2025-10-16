/**
 * Minimal ZMCF v1 decoder for browser/MapLibre environments (TypeScript).
 *
 * - Reads the compact "lat-lon -> max-zoom" coverage file (.zmc)
 * - Decodes microdegree-quantized rectangles grouped by zoom level
 * - Provides queryMaxZoom(lat, lon) for interactive use
 *
 * Assumptions:
 * - Version = 1
 * - Coord encoding = WGS84 microdegrees
 * - No coarse index (flags bit 0 = 0)
 *
 * Typical usage with MapLibre:
 *
 * import { ZMCF } from "./zmc-decoder";
 *
 * const zmc = await ZMCF.fromUrl("/coverage.zmc");
 * map.on("mousemove", (e) => {
 *   const maxZ = zmc.queryMaxZoom(e.lngLat.lat, e.lngLat.lng);
 *   // e.g., show a tooltip, adjust UI, choose data source, etc.
 *   console.log("Max zoom at cursor:", maxZ);
 * });
 */

export class ZMCF {
  readonly baseZoom: number;
  // Each level stores rectangles as Int32Array in the order:
  // [minLatQ, minLonQ, maxLatQ, maxLonQ, ...] (4 ints per rect)
  private readonly levels: { z: number; rects: Int32Array }[];

  private constructor(baseZoom: number, levels: { z: number; rects: Int32Array }[]) {
    this.baseZoom = baseZoom | 0;
    // Sort levels by descending z for early-out during queries
    this.levels = levels.slice().sort((a, b) => b.z - a.z);
  }

  // Load from a URL via fetch (browser-friendly)
  static async fromUrl(url: string, init?: RequestInit): Promise<ZMCF> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Failed to fetch ZMCF: ${res.status} ${res.statusText}`);
    const ab = await res.arrayBuffer();
    return ZMCF.fromArrayBuffer(ab);
  }

  // Build from an ArrayBuffer (e.g., from <input type="file"> or other sources)
  static fromArrayBuffer(ab: ArrayBuffer): ZMCF {
    const u8 = new Uint8Array(ab);
    const dv = new DataView(ab);

    // --- Header ---
    let off = 0;
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== "ZMC1") throw new Error("ZMCF: bad magic");
    off += 4;

    const version = u8[off++];
    if (version !== 1) throw new Error(`ZMCF: unsupported version ${version}`);
    const coordEnc = u8[off++];
    if (coordEnc !== 0) throw new Error("ZMCF: unsupported coord encoding");
    const flags = u8[off++]; // currently unused (no coarse index expected)
    const baseZoom = u8[off++];

    // zmin_overrides, zmax_overrides, reserved
    // Not needed for decoding rectangles, but read to advance offset.
    off += 1; // zmin_overrides
    off += 1; // zmax_overrides
    off += 2; // reserved u16

    const levelsCount = dv.getUint32(off, true); off += 4;
    const rectsTotal = dv.getUint32(off, true); off += 4;
    const levelDirOffset = dv.getUint32(off, true); off += 4;
    const dataOffsetAbs = dv.getUint32(off, true); off += 4;
    const indexOffsetAbs = dv.getUint32(off, true); off += 4; // not used (no index)

    // --- Level Directory ---
    let ldoff = levelDirOffset >>> 0;
    const dir: { z: number; rectCount: number; relOff: number }[] = [];
    for (let i = 0; i < levelsCount; i++) {
      const z = u8[ldoff++];
      const rectCount = dv.getUint32(ldoff, true); ldoff += 4;
      const relOff = dv.getUint32(ldoff, true); ldoff += 4;
      dir.push({ z, rectCount, relOff });
    }

    // --- Rectangles per level ---
    const levels: { z: number; rects: Int32Array }[] = [];
    for (const entry of dir) {
      const { z, rectCount, relOff } = entry;
      let p = (dataOffsetAbs + relOff) >>> 0;

      // Read the per-level varint count
      const c1 = decodeUVarint(u8, p);
      const n = c1.value;
      p = c1.offset;
      if (n !== rectCount) {
        throw new Error(`ZMCF: rect_count mismatch for level z=${z} (${n} vs ${rectCount})`);
      }

      // Delta-decode rectangles into Int32Array
      const rects = new Int32Array(rectCount * 4);
      let prevMinLatQ = 0, prevMinLonQ = 0, prevMaxLatQ = 0, prevMaxLonQ = 0;
      for (let i = 0; i < rectCount; i++) {
        const d1 = decodeSVarint(u8, p); p = d1.offset;
        const d2 = decodeSVarint(u8, p); p = d2.offset;
        const d3 = decodeSVarint(u8, p); p = d3.offset;
        const d4 = decodeSVarint(u8, p); p = d4.offset;

        const minLatQ = (prevMinLatQ + d1.value) | 0;
        const minLonQ = (prevMinLonQ + d2.value) | 0;
        const maxLatQ = (prevMaxLatQ + d3.value) | 0;
        const maxLonQ = (prevMaxLonQ + d4.value) | 0;

        const base = i * 4;
        rects[base + 0] = minLatQ;
        rects[base + 1] = minLonQ;
        rects[base + 2] = maxLatQ;
        rects[base + 3] = maxLonQ;

        prevMinLatQ = minLatQ;
        prevMinLonQ = minLonQ;
        prevMaxLatQ = maxLatQ;
        prevMaxLonQ = maxLonQ;
      }
      levels.push({ z, rects });
    }

    // Optional sanity check
    const totalDecoded = levels.reduce((acc, L) => acc + L.rects.length / 4, 0);
    if (totalDecoded !== rectsTotal) {
      // Not fatal in practice, but can warn
      // console.warn(`ZMCF: rects_total mismatch (${totalDecoded} vs ${rectsTotal})`);
    }

    return new ZMCF(baseZoom, levels);
  }

  // Query the maximum available zoom at (lat, lon) in degrees.
  queryMaxZoom(latDeg: number, lonDeg: number): number {
    const latQ = Math.round(latDeg * 1_000_000) | 0;
    const lonQ = Math.round(lonDeg * 1_000_000) | 0;

    for (const L of this.levels) {
      const arr = L.rects;
      for (let i = 0; i < arr.length; i += 4) {
        // minLatQ <= latQ <= maxLatQ and minLonQ <= lonQ <= maxLonQ
        if (arr[i] <= latQ && latQ <= arr[i + 2] &&
            arr[i + 1] <= lonQ && lonQ <= arr[i + 3]) {
          return L.z;
        }
      }
    }
    return this.baseZoom;
  }
}

/* -----------------------------
 * Minimal varint helpers
 * ----------------------------- */

function decodeUVarint(buf: Uint8Array, off: number): { value: number; offset: number } {
  let shift = 0;
  let result = 0 >>> 0;

  while (true) {
    if (off >= buf.length) throw new Error("ZMCF: uvarint underflow");
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("ZMCF: uvarint too long");
  }
  return { value: result >>> 0, offset: off };
}

function decodeSVarint(buf: Uint8Array, off: number): { value: number; offset: number } {
  const { value: u, offset } = decodeUVarint(buf, off);
  // ZigZag decode (32-bit)
  const s = ((u >>> 1) ^ -(u & 1)) | 0;
  return { value: s, offset };
}
