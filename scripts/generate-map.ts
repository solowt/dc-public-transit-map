import type { Line, Point } from "../interfaces.d.ts";
import { getStandardRoutes, getStations } from "./wmata-api.ts";
import {
  buildPolyline,
  interpolatePolyline,
  projectOntoPolyline,
} from "./polyline.ts";
import type { Coord, Polyline } from "./polyline.ts";

const GEOJSON_PATH =
  new URL("../data/metro_lines_processed.geojson", import.meta.url).pathname;

const NAME_TO_LINE: Record<string, Line> = {
  red: "RD",
  blue: "BL",
  green: "GR",
  orange: "OR",
  silver: "SV",
  yellow: "YL",
};

/** Chain an unordered list of segments into a single coordinate array by matching endpoints. */
function chainSegments(segments: Coord[][]): Coord[] {
  if (segments.length === 1) return segments[0];

  const THRESHOLD = 0.001; // ~100m, actual gaps are < 0.0002
  const n = segments.length;

  // Build adjacency: for each segment pair, find which endpoints connect
  type Endpoint = "start" | "end";
  type Connection = { neighbor: number; thisEnd: Endpoint; neighborEnd: Endpoint };
  const adjacency: Connection[][] = Array.from({ length: n }, () => []);

  function dist(a: Coord, b: Coord): number {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ends: [Endpoint, Coord][] = [
        ["start", segments[i][0]],
        ["end", segments[i][segments[i].length - 1]],
      ];
      const jEnds: [Endpoint, Coord][] = [
        ["start", segments[j][0]],
        ["end", segments[j][segments[j].length - 1]],
      ];
      for (const [iEnd, iPt] of ends) {
        for (const [jEnd, jPt] of jEnds) {
          if (dist(iPt, jPt) < THRESHOLD) {
            adjacency[i].push({ neighbor: j, thisEnd: iEnd, neighborEnd: jEnd });
            adjacency[j].push({ neighbor: i, thisEnd: jEnd, neighborEnd: iEnd });
            break;
          }
        }
      }
    }
  }

  // Start from a terminal segment (one with only 1 neighbor)
  let startIdx = adjacency.findIndex((adj) => adj.length === 1);
  if (startIdx === -1) startIdx = 0;

  const result: Coord[] = [];
  const visited = new Set<number>();

  // First segment: orient so connecting end is last
  const firstConn = adjacency[startIdx][0];
  if (firstConn.thisEnd === "start") {
    // Connecting at start -> reverse so connecting end comes last
    result.push(...[...segments[startIdx]].reverse());
  } else {
    result.push(...segments[startIdx]);
  }
  visited.add(startIdx);

  let currentIdx = startIdx;
  while (visited.size < n) {
    const conn = adjacency[currentIdx].find((c) => !visited.has(c.neighbor));
    if (!conn) break;

    const nextIdx = conn.neighbor;
    // conn.neighborEnd tells us which end of nextIdx connects to currentIdx
    if (conn.neighborEnd === "start") {
      // Enters at start, exits at end -> natural order
      result.push(...segments[nextIdx].slice(1));
    } else {
      // Enters at end, exits at start -> reverse
      const rev = [...segments[nextIdx]].reverse();
      result.push(...rev.slice(1));
    }
    visited.add(nextIdx);
    currentIdx = nextIdx;
  }

  return result;
}

/** Load GeoJSON and build a Polyline for each metro line. */
async function loadLinePolylines(): Promise<Record<Line, Polyline>> {
  const raw = await Deno.readTextFile(GEOJSON_PATH);
  const geojson = JSON.parse(raw);

  // Group segments by line code
  const segmentsByLine: Partial<Record<Line, Coord[][]>> = {};
  for (const feature of geojson.features) {
    const lines: string[] = feature.properties.lines;
    const coords: Coord[] = feature.geometry.coordinates;
    for (const name of lines) {
      const lineCode = NAME_TO_LINE[name];
      if (!lineCode) continue;
      (segmentsByLine[lineCode] ??= []).push(coords);
    }
  }

  // Chain segments and build polylines
  const result = {} as Record<Line, Polyline>;
  for (const [line, segments] of Object.entries(segmentsByLine)) {
    result[line as Line] = buildPolyline(chainSegments(segments!));
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

const CIRCUIT_MAP_PATH = "data/cache/circuit-map.json";

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
    await Deno.mkdir("data/cache", { recursive: true });
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
  await Deno.mkdir("data/cache", { recursive: true });
  await Deno.writeTextFile(CIRCUIT_MAP_PATH, JSON.stringify(map, null, 2));
  console.log(
    `Generated circuit map: ${
      Object.keys(map).length
    } lines, ${totalCircuits} total circuits`,
  );
}
