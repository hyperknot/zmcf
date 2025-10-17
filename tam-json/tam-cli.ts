// tam-cli.ts
//
// Node CLI for TAM-JSON v1.
// - Encode a rectangle inventory into a compact TAM-JSON file.
//
// Usage:
//   tsx tam-cli.ts encode inventory.json out.tam.json [--base-zoom N] [--zmax N]
//
// Example:
//   tsx tam-cli.ts encode example.json coverage.tam.json --base-zoom 12 --zmax 21

import fs from 'node:fs'
import { encodeTamJson, type Inventory } from './tam-encoder'

function usage(): never {
  console.log(`Usage:
  tsx tam-cli.ts encode input.json out.tam.json [--base-zoom N] [--zmax N]

Description:
  Encode a rectangle inventory (JSON) into a compact TAM-JSON v1 file
  that supports fast "max zoom at lat/lon" and "dataset for tile z/x/y" queries.

Options:
  --base-zoom N   Override derived base zoom (default = best global or min(max_zoom)).
  --zmax N        Cap the highest zoom to encode (default = max(item.max_zoom)).

Inventory JSON schema (example):
{
  "version": "0.0.3",
  "items": [
    {
      "name": "planet.pmtiles",
      "min_lon": -180, "min_lat": -85.0511287798066,
      "max_lon":  180, "max_lat":  85.0511287798066,
      "min_zoom": 0, "max_zoom": 12
    },
    {
      "name": "6-34-22.pmtiles",
      "min_lon": 11.25, "min_lat": 45.08,
      "max_lon": 16.875, "max_lat": 48.92,
      "min_zoom": 13, "max_zoom": 17
    }
  ]
}
`)
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  if (args.length < 3 || args[0] !== 'encode') usage()

  const input = args[1]
  const output = args[2]
  let baseZoomOverride: number | undefined
  let zmaxOverride: number | undefined

  for (let i = 3; i < args.length; i++) {
    const a = args[i]
    if (a === '--base-zoom') {
      const v = Number(args[++i])
      if (!Number.isFinite(v) || v < 0) {
        console.error('Invalid --base-zoom')
        process.exit(1)
      }
      baseZoomOverride = v | 0
    } else if (a === '--zmax') {
      const v = Number(args[++i])
      if (!Number.isFinite(v) || v < 0) {
        console.error('Invalid --zmax')
        process.exit(1)
      }
      zmaxOverride = v | 0
    } else {
      console.error(`Unknown arg: ${a}`)
      usage()
    }
  }

  return { input, output, baseZoomOverride, zmaxOverride }
}

async function main() {
  const { input, output, baseZoomOverride, zmaxOverride } = parseArgs(process.argv)

  const raw = fs.readFileSync(input, 'utf8')
  let inv: Inventory
  try {
    inv = JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse input JSON:', e)
    process.exit(2)
    return
  }
  if (!inv || !Array.isArray(inv.items)) {
    console.error("Invalid inventory: missing 'items' array")
    process.exit(2)
    return
  }

  const t0 = Date.now()
  const tam = encodeTamJson(inv, { baseZoom: baseZoomOverride, zmax: zmaxOverride })

  // Stats
  let rowsTotal = 0,
    rangesTotal = 0
  for (const L of tam.levels) {
    rowsTotal += L.rows.length
    for (const r of L.rows) rangesTotal += r[1] | 0
  }
  const json = JSON.stringify(tam)
  fs.writeFileSync(output, json)
  const dt = Date.now() - t0

  console.log(
    `[tam-json] zbase=${tam.zbase}, zmax=${tam.zmax}, datasets=${tam.datasets.length}, base_dataset=${tam.base_dataset}`,
  )
  console.log(`[tam-json] levels=${tam.levels.length}, rows=${rowsTotal}, ranges=${rangesTotal}`)
  console.log(`[tam-json] wrote ${Buffer.byteLength(json)} bytes -> ${output} in ${dt} ms`)
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main()
}
