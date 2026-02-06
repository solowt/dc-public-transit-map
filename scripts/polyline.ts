/** Geometry helpers for projecting points onto polylines and interpolating along them. */

/** A coordinate pair: [longitude, latitude]. */
export type Coord = [number, number];

/** A precomputed polyline with cumulative distances along each vertex. */
export interface Polyline {
  coords: Coord[];
  /** cumDist[i] = cumulative Euclidean distance from coords[0] to coords[i]. */
  cumDist: number[];
}

function dist(a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Build a Polyline from an array of [lng, lat] coordinates. */
export function buildPolyline(coords: Coord[]): Polyline {
  const cumDist: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + dist(coords[i - 1], coords[i]));
  }
  return { coords, cumDist };
}

/**
 * Project a point onto the polyline, returning the distance parameter
 * (cumulative distance along the polyline to the closest point).
 */
export function projectOntoPolyline(polyline: Polyline, point: Coord): number {
  const { coords, cumDist } = polyline;
  let bestDist = Infinity;
  let bestParam = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];

    // Vector from a to b
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const segLen2 = abx * abx + aby * aby;

    // Project point onto segment, clamped to [0, 1]
    let t: number;
    if (segLen2 === 0) {
      t = 0;
    } else {
      t = ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / segLen2;
      t = Math.max(0, Math.min(1, t));
    }

    // Closest point on segment
    const cx = a[0] + t * abx;
    const cy = a[1] + t * aby;
    const d = Math.sqrt((point[0] - cx) ** 2 + (point[1] - cy) ** 2);

    if (d < bestDist) {
      bestDist = d;
      // Distance parameter = cumulative distance to segment start + fraction of segment
      const segLen = cumDist[i + 1] - cumDist[i];
      bestParam = cumDist[i] + t * segLen;
    }
  }

  return bestParam;
}

/**
 * Given a distance parameter along the polyline, return the interpolated [lng, lat].
 */
export function interpolatePolyline(polyline: Polyline, param: number): Coord {
  const { coords, cumDist } = polyline;
  const totalLen = cumDist[cumDist.length - 1];

  // Clamp to polyline bounds
  if (param <= 0) return coords[0];
  if (param >= totalLen) return coords[coords.length - 1];

  // Find the segment containing this parameter via binary search
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= param) lo = mid;
    else hi = mid;
  }

  const segStart = cumDist[lo];
  const segEnd = cumDist[hi];
  const t = segEnd === segStart ? 0 : (param - segStart) / (segEnd - segStart);

  const a = coords[lo];
  const b = coords[hi];
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
  ];
}
