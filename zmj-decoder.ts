/**
 * ZMJ (Zoom‑Max JSON) minimal decoder for browser/MapLibre environments.
 *
 * Notes for contributors:
 * - Rectangles are scanned highest-zoom-first and return on first match.
 * - Antimeridian wrap: if min_lon > max_lon, we consider (lon >= min_lon || lon <= max_lon).
 * - Keep objects simple; switch to typed arrays only if you truly need it.
 */

export type ZMJRect = {
  z: number;
  dataset: string;
  min_lat: number; min_lon: number;
  max_lat: number; max_lon: number;
};

export type ZMJJson = {
  format: "zmj-json-v1";
  base_zoom: number;
  base_dataset: string | null;
  rects: ZMJRect[];
};

export class ZMJ {
  readonly baseZoom: number;
  readonly baseDataset: string | null;
  private rects: ZMJRect[];

  private constructor(baseZoom: number, baseDataset: string | null, rects: ZMJRect[]) {
    this.baseZoom = baseZoom | 0;
    this.baseDataset = baseDataset ?? null;
    // Defensive: ensure descending zoom for early-out
    this.rects = rects.slice().sort((a, b) => (b.z|0) - (a.z|0));
  }

  static async fromUrl(url: string, init?: RequestInit): Promise<ZMJ> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Failed to fetch ZMJ: ${res.status} ${res.statusText}`);
    const obj = await res.json();
    return ZMJ.fromObject(obj as ZMJJson);
  }

  static fromObject(obj: ZMJJson): ZMJ {
    if (!obj || obj.format !== "zmj-json-v1" || !Array.isArray(obj.rects)) {
      throw new Error("Invalid ZMJ JSON");
    }
    // Normalize lat order; keep lon order for wrap behavior
    const rects = obj.rects.map(r => ({
      z: r.z|0,
      dataset: String(r.dataset),
      min_lat: Math.min(r.min_lat, r.max_lat),
      max_lat: Math.max(r.min_lat, r.max_lat),
      min_lon: r.min_lon,
      max_lon: r.max_lon
    }));
    return new ZMJ(obj.base_zoom|0, obj.base_dataset ?? null, rects);
  }

  // Returns only the zoom (helper for drop-in use)
  queryMaxZoom(latDeg: number, lonDeg: number): number {
    return this.query(latDeg, lonDeg).zoom;
  }

  // Returns zoom and dataset string (or base fallback)
  query(latDeg: number, lonDeg: number): { zoom: number; dataset: string | null } {
    for (const r of this.rects) {
      if (r.min_lat <= latDeg && latDeg <= r.max_lat) {
        const inLon = (r.min_lon <= r.max_lon)
          ? (r.min_lon <= lonDeg && lonDeg <= r.max_lon)
          : (lonDeg >= r.min_lon || lonDeg <= r.max_lon); // wrap across ±180°
        if (inLon) return { zoom: r.z, dataset: r.dataset };
      }
    }
    return { zoom: this.baseZoom, dataset: this.baseDataset };
  }
}