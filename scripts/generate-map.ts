import type { Line, Point } from "../interfaces.d.ts";
import { getStandardRoutes, getStations } from "./wmata-api.ts";
import {
  buildPolyline,
  interpolatePolyline,
  projectOntoPolyline,
} from "./polyline.ts";
import type { Coord, Polyline } from "./polyline.ts";

const GEOJSON_PATH =
  new URL("../data/Metro_Lines_Regional.geojson", import.meta.url).pathname;

const NAME_TO_LINE: Record<string, Line> = {
  red: "RD",
  blue: "BL",
  green: "GR",
  orange: "OR",
  silver: "SV",
  yellow: "YL",
};

/** Load GeoJSON and build a Polyline for each metro line. */
async function loadLinePolylines(): Promise<Record<Line, Polyline>> {
  const raw = await Deno.readTextFile(GEOJSON_PATH);
  const geojson = JSON.parse(raw);

  const result = {} as Record<Line, Polyline>;
  for (const feature of geojson.features) {
    const name: string = feature.properties.NAME;
    const lineCode = NAME_TO_LINE[name];
    if (!lineCode) continue;
    const coords: Coord[] = feature.geometry.coordinates;
    result[lineCode] = buildPolyline(coords);
  }
  return result;
}

export type CircuitMap = Record<Line, Record<number, Point>>;

export async function generateCircuitMap(): Promise<CircuitMap> {
  const [polylines, routes, stations] = await Promise.all([
    loadLinePolylines(),
    getStandardRoutes(),
    getStations(),
  ]);

  // Build stationCode -> Point lookup
  const stationLocations = new Map<string, Point>();
  for (const station of stations) {
    stationLocations.set(station.Code, {
      latitude: station.Lat,
      longitude: station.Lon,
    });
  }

  const circuitMap: CircuitMap = {
    RD: {},
    BL: {},
    GR: {},
    OR: {},
    SV: {},
    YL: {},
  };

  for (const route of routes) {
    const line = route.LineCode;
    const polyline = polylines[line];
    if (!polyline) continue;

    const circuits = route.TrackCircuits;
    const lineMap = circuitMap[line];

    // Find anchor points: circuits at stations with known coordinates
    type Anchor = { index: number; param: number; point: Point };
    const anchors: Anchor[] = [];
    for (let i = 0; i < circuits.length; i++) {
      const code = circuits[i].StationCode;
      if (code && stationLocations.has(code)) {
        const pt = stationLocations.get(code)!;
        const param = projectOntoPolyline(polyline, [
          pt.longitude,
          pt.latitude,
        ]);
        anchors.push({ index: i, param, point: pt });
      }
    }

    if (anchors.length === 0) continue;

    // Circuits before the first anchor: clamp to first anchor's position
    for (let i = 0; i < anchors[0].index; i++) {
      const id = circuits[i].CircuitId;
      if (!(id in lineMap)) {
        lineMap[id] = anchors[0].point;
      }
    }

    // Interpolate between consecutive anchors
    for (let a = 0; a < anchors.length - 1; a++) {
      const from = anchors[a];
      const to = anchors[a + 1];
      const span = to.index - from.index;

      for (let i = from.index; i <= to.index; i++) {
        const id = circuits[i].CircuitId;
        if (!(id in lineMap)) {
          const t = span === 0 ? 0 : (i - from.index) / span;
          const param = from.param + t * (to.param - from.param);
          const coord = interpolatePolyline(polyline, param);
          lineMap[id] = { latitude: coord[1], longitude: coord[0] };
        }
      }
    }

    // Circuits after the last anchor: clamp to last anchor's position
    const last = anchors[anchors.length - 1];
    for (let i = last.index; i < circuits.length; i++) {
      const id = circuits[i].CircuitId;
      if (!(id in lineMap)) {
        lineMap[id] = last.point;
      }
    }
  }

  return circuitMap;
}

const CIRCUIT_MAP_PATH = "circuit-map.json";

/** Flatten the per-line circuit map into a single circuitId -> Point lookup. */
function flattenCircuitMap(nested: CircuitMap): Record<number, Point> {
  const flat: Record<number, Point> = {};
  for (const lineMap of Object.values(nested)) {
    for (const [id, point] of Object.entries(lineMap)) {
      flat[Number(id)] = point;
    }
  }
  return flat;
}

/** Load circuit map from disk, or generate and save it. Returns flat circuitId -> Point lookup. */
export async function loadCircuitMap(): Promise<Record<number, Point>> {
  let nested: CircuitMap;
  try {
    const raw = await Deno.readTextFile(CIRCUIT_MAP_PATH);
    console.log("Loaded circuit map from disk");
    nested = JSON.parse(raw);
  } catch {
    console.log("Circuit map not found, generating...");
    nested = await generateCircuitMap();
    await Deno.writeTextFile(CIRCUIT_MAP_PATH, JSON.stringify(nested, null, 2));
    console.log("Generated circuit map");
  }
  const flat = flattenCircuitMap(nested);
  console.log(`Circuit map: ${Object.keys(flat).length} circuits`);
  return flat;
}

if (import.meta.main) {
  const map = await generateCircuitMap();
  const totalCircuits = Object.values(map).reduce(
    (sum, lineMap) => sum + Object.keys(lineMap).length,
    0,
  );
  await Deno.writeTextFile("circuit-map.json", JSON.stringify(map, null, 2));
  console.log(
    `Generated circuit map: ${
      Object.keys(map).length
    } lines, ${totalCircuits} total circuits`,
  );
}
