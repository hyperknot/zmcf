// tam-decoder.ts
//
// Decoder for TAM-JSON v1 (Tile Availability Map in JSON).
// - Parses JSON into typed arrays and a sparse row index per zoom.
// - Fast queries: datasetForTile(z,x,y) and datasetHere(lat,lon).
//
// Exported API:
// - TAM.fromUrl(url): Promise<TAM>
// - TAM.fromObject(obj: TamJson): TAM
// - Methods: datasetForTile, datasetHere, maxZoomAt, hasTile

export type TamJsonLevel = {
  z: number;
  rows: number[][];
};
export type TamJson = {
  format: "tam-json-v1";
  zbase: number;
  zmax: number;
  datasets: (string | Record<string, unknown>)[];
  base_dataset: number; // -1 if none
  levels: TamJsonLevel[];
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export class TAM {
  readonly zbase: number;
  readonly zmax: number;
  readonly datasets: (string | Record<string, unknown>)[];
  readonly baseDataset: number;

  // Per level: sparse index and flat arrays for ranges
  private levels: {
    z: number;
    rowY: Uint32Array;      // sorted non-empty row indices
    rowStart: Uint32Array;  // start index in x0/x1/ds for each row
    rowEnd: Uint32Array;    // end index (exclusive)
    x0: Uint32Array;        // range starts
    x1: Uint32Array;        // range ends
    ds: Uint16Array;        // dataset index per range
  }[];

  private constructor(
    zbase: number,
    zmax: number,
    datasets: (string | Record<string, unknown>)[],
    baseDataset: number,
    levels: TAM["levels"]
  ) {
    this.zbase = zbase|0;
    this.zmax = zmax|0;
    this.datasets = datasets;
    this.baseDataset = baseDataset|0;
    this.levels = levels;
  }

  /** Fetch and decode a TAM-JSON file. */
  static async fromUrl(url: string, init?: RequestInit): Promise<TAM> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
    const obj = await res.json();
    return TAM.fromObject(obj as TamJson);
  }

  /** Build from a parsed object. */
  static fromObject(obj: TamJson): TAM {
    if (!obj || obj.format !== "tam-json-v1") throw new Error("Invalid TAM JSON: bad format");
    const zbase = obj.zbase|0, zmax = obj.zmax|0;

    const byZ = new Map<number, TamJsonLevel>();
    for (const L of obj.levels) byZ.set(L.z|0, L);

    const levels: TAM["levels"] = [];
    for (let z = zbase + 1; z <= zmax; z++) {
      const L = byZ.get(z);
      if (!L || L.rows.length === 0) {
        levels.push({
          z,
          rowY: new Uint32Array(0),
          rowStart: new Uint32Array(0),
          rowEnd: new Uint32Array(0),
          x0: new Uint32Array(0),
          x1: new Uint32Array(0),
          ds: new Uint16Array(0)
        });
        continue;
      }

      const rowCount = L.rows.length;
      let rangesTotal = 0;
      for (const row of L.rows) rangesTotal += (row[1] | 0);

      const rowY = new Uint32Array(rowCount);
      const rowStart = new Uint32Array(rowCount);
      const rowEnd = new Uint32Array(rowCount);
      const x0 = new Uint32Array(rangesTotal);
      const x1 = new Uint32Array(rangesTotal);
      const ds = new Uint16Array(rangesTotal);

      let prevY = -1;
      let cursor = 0;
      for (let i = 0; i < rowCount; i++) {
        const arr = L.rows[i];
        let idx = 0;
        const yTok = arr[idx++] | 0;
        const nRanges = arr[idx++] | 0;
        const y = (prevY < 0 ? yTok : (prevY + yTok)) | 0;
        rowY[i] = y;
        rowStart[i] = cursor;

        let prevEndPlus1 = 0;
        for (let k = 0; k < nRanges; k++) {
          const dx0 = arr[idx++] | 0;
          const len = arr[idx++] | 0;
          const d = arr[idx++] | 0;
          const start = (prevEndPlus1 + dx0) >>> 0;
          const end = (start + len - 1) >>> 0;
          x0[cursor] = start;
          x1[cursor] = end;
          ds[cursor] = d;
          prevEndPlus1 = end + 1;
          cursor++;
        }

        rowEnd[i] = cursor;
        prevY = y;
      }

      levels.push({ z, rowY, rowStart, rowEnd, x0, x1, ds });
    }

    return new TAM(zbase, zmax, obj.datasets.slice(), obj.base_dataset|0, levels);
  }

  /** Dataset index for z/x/y or -1 if absent at this level. */
  datasetForTile(z: number, x: number, y: number): number {
    const L = this.levels[z - this.zbase - 1];
    if (!L) return -1;
    // Binary search rowY for y
    let lo = 0, hi = L.rowY.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const yy = L.rowY[mid];
      if (yy === y) {
        const s = L.rowStart[mid], e = L.rowEnd[mid];
        for (let i = s; i < e; i++) if (L.x0[i] <= x && x <= L.x1[i]) return L.ds[i];
        return -1;
      }
      if (yy < y) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /** Highest-zoom dataset at lat/lon. */
  datasetHere(lat: number, lon: number): { zoom: number; datasetIndex: number; dataset: string | Record<string, unknown> | null } {
    for (let z = this.zmax; z >= this.zbase + 1; z--) {
      const n = 1 << z;
      const x = Math.floor(((lon + 180) / 360) * n) & (n - 1);
      const s = Math.sin(lat * Math.PI / 180);
      const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
      const yy = clamp(y, 0, n - 1);
      const ds = this.datasetForTile(z, x, yy);
      if (ds >= 0) return { zoom: z, datasetIndex: ds, dataset: this.datasets[ds] as any };
    }
    const base = this.baseDataset >= 0 ? this.baseDataset : -1;
    return { zoom: this.zbase, datasetIndex: base, dataset: base >= 0 ? (this.datasets[base] as any) : null };
  }

  /** Convenience: returns only max zoom at lat/lon (base if none). */
  maxZoomAt(lat: number, lon: number): number {
    return this.datasetHere(lat, lon).zoom;
  }

  /** True if a tile exists at z/x/y (ignoring base coverage). */
  hasTile(z: number, x: number, y: number): boolean {
    return this.datasetForTile(z, x, y) >= 0;
  }
}