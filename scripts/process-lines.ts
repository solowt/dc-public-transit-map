/**
 * Processes Metro_Lines_Regional.geojson to detect shared corridors
 * and outputs metro_lines_processed.geojson where each feature has a
 * `lines` property indicating which metro lines use that stretch.
 *
 * Shared corridors are detected via proximity: if a vertex on one line
 * is within THRESHOLD_METERS of a segment on another line, they're
 * considered to share that stretch of track.
 *
 * Post-processing steps clean up junction artifacts:
 * 1. Smoothing: short runs where a crossing line briefly appears nearby
 *    (e.g. Red crossing BL/OR/SV at Metro Center) are absorbed into the
 *    surrounding longer runs.
 * 2. Convergence settling: when lines converge at a junction (e.g. Rosslyn),
 *    they're detected as shared ~200m before truly running parallel. The
 *    first MIN_SETTLE_M of each superset transition is trimmed back to the
 *    previous set, pushing the shared corridor start to the actual junction.
 * 3. Endpoint snapping: at junctions where corridors branch, the ~6m
 *    coordinate gap between features from different base paths is closed
 *    by snapping nearby endpoints to a common reference point.
 *
 * Run: deno task process-lines
 */

const THRESHOLD_METERS = 15;
const SMOOTH_THRESHOLD_M = 500;

type Coord = [number, number]; // [longitude, latitude]

/** Approximate distance between two points, in meters. */
function distMeters(
  lon1: number, lat1: number,
  lon2: number, lat2: number,
): number {
  const cosLat = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dx = (lon2 - lon1) * cosLat * 111_320;
  const dy = (lat2 - lat1) * 111_320;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Approximate distance from a point to a line segment, in meters. */
function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const cosLat = Math.cos(py * (Math.PI / 180));
  const mLon = cosLat * 111_320;
  const mLat = 111_320;

  const pxm = px * mLon, pym = py * mLat;
  const axm = ax * mLon, aym = ay * mLat;
  const bxm = bx * mLon, bym = by * mLat;

  const dx = bxm - axm, dy = bym - aym;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = pxm - axm, ddy = pym - aym;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  const t = Math.max(0, Math.min(1, ((pxm - axm) * dx + (pym - aym) * dy) / lenSq));
  const cx = axm + t * dx, cy = aym + t * dy;
  const ddx = pxm - cx, ddy = pym - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/** Check if a point is within threshold of any segment on another line. */
function isNearLine(lon: number, lat: number, otherCoords: Coord[]): boolean {
  const margin = 0.0003;
  for (let j = 0; j < otherCoords.length - 1; j++) {
    const [aLon, aLat] = otherCoords[j];
    const [bLon, bLat] = otherCoords[j + 1];
    if (
      lon < Math.min(aLon, bLon) - margin || lon > Math.max(aLon, bLon) + margin ||
      lat < Math.min(aLat, bLat) - margin || lat > Math.max(aLat, bLat) + margin
    ) continue;
    if (pointToSegmentDist(lon, lat, aLon, aLat, bLon, bLat) < THRESHOLD_METERS) {
      return true;
    }
  }
  return false;
}

/** Length of a polyline in meters. */
function polylineLength(coords: Coord[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += distMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

// ============================================================
// Load GeoJSON
// ============================================================
const raw = JSON.parse(await Deno.readTextFile("data/Metro_Lines_Regional.geojson"));

const lines = new Map<string, Coord[]>();
for (const f of raw.features) {
  lines.set(f.properties.NAME as string, f.geometry.coordinates as Coord[]);
}
const lineNames = [...lines.keys()].sort();
console.log("Lines:", lineNames.join(", "));

// ============================================================
// Phase 1: Per-vertex line-set detection
// ============================================================
console.log("\nDetecting shared corridors...");
const vertexLineSets = new Map<string, string[][]>();

for (const [name, coords] of lines) {
  const lineSets: string[][] = [];
  const t0 = performance.now();

  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const nearby: string[] = [name];
    for (const [otherName, otherCoords] of lines) {
      if (otherName === name) continue;
      if (isNearLine(lon, lat, otherCoords)) {
        nearby.push(otherName);
      }
    }
    nearby.sort();
    lineSets.push(nearby);
  }

  vertexLineSets.set(name, lineSets);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`  ${name}: ${coords.length} vertices (${ms}ms)`);
}

// ============================================================
// Phase 2: Smooth per-vertex line-sets
// At transfer stations, a crossing line briefly appears nearby,
// creating short "noisy" runs like [BL,OR,RD,SV] between two
// [BL,OR,SV] runs. Replace short runs with the surrounding
// longer run's line-set.
// ============================================================
console.log("\nSmoothing...");

for (const [name, coords] of lines) {
  const lineSets = vertexLineSets.get(name)!;

  for (let pass = 0; pass < 5; pass++) {
    // Build runs
    interface Run { start: number; end: number; key: string; lengthM: number }
    const runs: Run[] = [];
    let rStart = 0;
    for (let i = 1; i <= lineSets.length; i++) {
      const prevKey = lineSets[i - 1].join(",");
      const currKey = i < lineSets.length ? lineSets[i].join(",") : null;
      if (currKey !== prevKey) {
        let lengthM = 0;
        for (let j = rStart + 1; j < i; j++) {
          lengthM += distMeters(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]);
        }
        runs.push({ start: rStart, end: i - 1, key: prevKey, lengthM });
        rStart = i;
      }
    }

    let changed = false;
    for (let r = 0; r < runs.length; r++) {
      if (runs[r].lengthM >= SMOOTH_THRESHOLD_M) continue;

      const prev = r > 0 ? runs[r - 1] : null;
      const next = r < runs.length - 1 ? runs[r + 1] : null;

      // Pick the neighbor to absorb into
      let donor: Run | null = null;
      if (prev && next && prev.key === next.key) {
        donor = prev; // both sides agree
      } else if (prev && next) {
        donor = prev.lengthM >= next.lengthM ? prev : next;
      } else {
        donor = prev ?? next;
      }

      if (donor && donor.lengthM > runs[r].lengthM) {
        const newSet = lineSets[donor.start];
        for (let i = runs[r].start; i <= runs[r].end; i++) {
          lineSets[i] = newSet;
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// ============================================================
// Phase 2b: Settle convergence zones
// When lines converge at a junction (e.g. Rosslyn), the shared
// corridor is detected ~200m before the lines are truly parallel.
// Trim the first MIN_SETTLE_M of each superset transition back
// to the previous smaller set, so the shared corridor starts
// closer to the actual junction.
// ============================================================
console.log("\nSettling convergence zones...");
const MIN_SETTLE_M = 200;

for (const [_name, coords] of lines) {
  const lineSets = vertexLineSets.get(_name)!;

  // Build runs from current labels (snapshot before modifying)
  interface SettleRun { start: number; end: number; set: string[] }
  const runs: SettleRun[] = [];
  let rStart = 0;
  for (let i = 1; i <= lineSets.length; i++) {
    const prevKey = lineSets[i - 1].join(",");
    const currKey = i < lineSets.length ? lineSets[i].join(",") : null;
    if (currKey !== prevKey) {
      runs.push({ start: rStart, end: i - 1, set: [...lineSets[rStart]] });
      rStart = i;
    }
  }

  // Process each run boundary: trim the start of superset runs
  for (let r = 1; r < runs.length; r++) {
    const prev = runs[r - 1];
    const curr = runs[r];
    if (curr.set.length <= prev.set.length) continue;
    if (!prev.set.every(l => curr.set.includes(l))) continue;
    // Only settle 3+ line corridors; 2-line junctions are close
    // enough that snapping handles them without visible overlap.
    if (curr.set.length < 3) continue;

    let dist = 0;
    for (let j = curr.start; j <= curr.end; j++) {
      if (j > curr.start) {
        dist += distMeters(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]);
      }
      if (dist >= MIN_SETTLE_M) break;
      lineSets[j] = [...prev.set];
    }
  }
}

// ============================================================
// Phase 3: Group consecutive same-line-set vertices into
// stretches and emit features (primary line only)
// ============================================================
interface ProcessedFeature {
  type: "Feature";
  properties: { lines: string[] };
  geometry: { type: "LineString"; coordinates: Coord[] };
}

const output: ProcessedFeature[] = [];

for (const name of lineNames) {
  const coords = lines.get(name)!;
  const lineSets = vertexLineSets.get(name)!;

  let currentKey: string | null = null;
  let currentLines: string[] = [];
  let currentCoords: Coord[] = [];

  const emitStretch = () => {
    if (currentCoords.length >= 2 && currentLines[0] === name) {
      output.push({
        type: "Feature",
        properties: { lines: [...currentLines] },
        geometry: { type: "LineString", coordinates: [...currentCoords] },
      });
    }
  };

  for (let i = 0; i < coords.length; i++) {
    const key = lineSets[i].join(",");
    if (key !== currentKey) {
      emitStretch();
      const prevPoint = currentCoords.length > 0
        ? currentCoords[currentCoords.length - 1]
        : null;
      currentKey = key;
      currentLines = lineSets[i];
      currentCoords = prevPoint ? [prevPoint] : [];
    }
    currentCoords.push(coords[i]);
  }
  emitStretch();
}

// ============================================================
// Phase 4: Snap nearby endpoints
// At real junctions (e.g. Rosslyn, L'Enfant), features from
// different base paths have endpoints ~6m apart. Cluster nearby
// endpoints and snap them to the centroid of the cluster.
// ============================================================
console.log("\nSnapping endpoints...");

interface Endpoint {
  fi: number;      // feature index
  isStart: boolean;
  coord: Coord;
}

const endpoints: Endpoint[] = [];
for (let i = 0; i < output.length; i++) {
  const c = output[i].geometry.coordinates;
  endpoints.push({ fi: i, isStart: true, coord: c[0] });
  endpoints.push({ fi: i, isStart: false, coord: c[c.length - 1] });
}

// Cluster with single-linkage: two endpoints in same cluster if < 15m
const parent = endpoints.map((_, i) => i);
function find(x: number): number {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
  return x;
}
function union(a: number, b: number) { parent[find(a)] = find(b); }

for (let i = 0; i < endpoints.length; i++) {
  for (let j = i + 1; j < endpoints.length; j++) {
    if (endpoints[i].fi === endpoints[j].fi) continue;
    const d = distMeters(
      endpoints[i].coord[0], endpoints[i].coord[1],
      endpoints[j].coord[0], endpoints[j].coord[1],
    );
    if (d > 0.1 && d < THRESHOLD_METERS) {
      union(i, j);
    }
  }
}

// Group by cluster root
const clusters = new Map<number, number[]>();
for (let i = 0; i < endpoints.length; i++) {
  const root = find(i);
  if (!clusters.has(root)) clusters.set(root, []);
  clusters.get(root)!.push(i);
}

let snapped = 0;
for (const members of clusters.values()) {
  if (members.length < 2) continue;

  // Use the endpoint from the feature with the most lines as the
  // reference point. This keeps the shared corridor's path stable
  // and snaps solo lines to it (no kink in the multi-line corridor).
  let bestIdx = members[0];
  let bestLineCount = output[endpoints[bestIdx].fi].properties.lines.length;
  for (const idx of members) {
    const lc = output[endpoints[idx].fi].properties.lines.length;
    if (lc > bestLineCount) {
      bestLineCount = lc;
      bestIdx = idx;
    }
  }
  const ref: Coord = [...endpoints[bestIdx].coord];

  // Snap all cluster members to the reference
  for (const idx of members) {
    const ep = endpoints[idx];
    const coords = output[ep.fi].geometry.coordinates;
    if (ep.isStart) {
      coords[0] = ref;
    } else {
      coords[coords.length - 1] = ref;
    }
    snapped++;
  }
}
console.log(`  Snapped ${snapped} endpoints in ${clusters.size - [...clusters.values()].filter(m => m.length < 2).length} clusters`);

// ============================================================
// Write output
// ============================================================
const outGeoJSON = { type: "FeatureCollection", features: output };
await Deno.writeTextFile(
  "data/metro_lines_processed.geojson",
  JSON.stringify(outGeoJSON),
);

// Summary
console.log(`\nOutput: ${output.length} features`);
const summary = new Map<string, number>();
for (const f of output) {
  const key = f.properties.lines.join(" + ");
  summary.set(key, (summary.get(key) || 0) + 1);
}
for (const [key, count] of [...summary].sort()) {
  console.log(`  ${key}: ${count} stretches`);
}
