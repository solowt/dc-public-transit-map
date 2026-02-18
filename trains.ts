import type { Point, TrainData, TrainPosition } from "./interfaces.d.ts";
import { getStandardRoutes, getTrainPositions } from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 5_000;

// Module state, set by init()
let circuitMap: Record<number, Point>;
let clients: Set<WebSocket>;

// Circuit adjacency — maps support branching at junctions (one circuit can
// lead to multiple next/prev circuits where lines diverge or merge).
const nextCircuit = new Map<number, Set<number>>();
const prevCircuit = new Map<number, Set<number>>();

// Station code → set of circuit IDs where that station is located
const stationCircuits = new Map<string, Set<number>>();

// Train state
const lastKnownCircuits = new Map<string, number>();
let latestSnapshot: TrainData[] = [];

/** Initialize train module: store references and build circuit adjacency. */
export async function init(
  map: Record<number, Point>,
  wsClients: Set<WebSocket>,
): Promise<void> {
  circuitMap = map;
  clients = wsClients;

  const routes = await getStandardRoutes();
  for (const route of routes) {
    const circuits = route.TrackCircuits;
    for (let i = 0; i < circuits.length - 1; i++) {
      const a = circuits[i].CircuitId;
      const b = circuits[i + 1].CircuitId;
      if (!nextCircuit.has(a)) nextCircuit.set(a, new Set());
      nextCircuit.get(a)!.add(b);
      if (!prevCircuit.has(b)) prevCircuit.set(b, new Set());
      prevCircuit.get(b)!.add(a);
    }
    for (const tc of circuits) {
      if (tc.StationCode) {
        let set = stationCircuits.get(tc.StationCode);
        if (!set) {
          set = new Set();
          stationCircuits.set(tc.StationCode, set);
        }
        set.add(tc.CircuitId);
      }
    }
  }
  console.log(`Circuit adjacency: ${nextCircuit.size} entries`);
}

function bearing(from: Point, to: Point): number {
  const toRad = Math.PI / 180;
  const lat1 = from.latitude * toRad;
  const lat2 = to.latitude * toRad;
  const dLon = (to.longitude - from.longitude) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function enrichTrain(train: TrainPosition): TrainData | null {
  const point = circuitMap[train.CircuitId];
  if (!point) return null;

  // Both tracks are ordered in the same physical direction in StandardRoutes.
  // Dir 1 travels forward (next), Dir 2 travels backward (prev).
  const forward = train.DirectionNum === 1 ? nextCircuit : prevCircuit;
  const backward = train.DirectionNum === 1 ? prevCircuit : nextCircuit;

  let heading = 0;
  const aheadIds = forward.get(train.CircuitId);
  const firstAhead = aheadIds ? aheadIds.values().next().value : undefined;
  if (firstAhead !== undefined && circuitMap[firstAhead]) {
    heading = bearing(point, circuitMap[firstAhead]);
  } else {
    // End of line: use the circuit behind to infer heading
    const behindIds = backward.get(train.CircuitId);
    const firstBehind = behindIds ? behindIds.values().next().value : undefined;
    if (firstBehind !== undefined && circuitMap[firstBehind]) {
      heading = bearing(circuitMap[firstBehind], point);
    }
  }

  return { ...train, location: point, heading };
}

function broadcast(updates: TrainData[], removals: string[] = []) {
  const message = JSON.stringify({ updates, removals });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

async function pollTrains() {
  try {
    const positions = await getTrainPositions();
    const allTrains: TrainData[] = [];
    const changedTrains: TrainData[] = [];

    for (const pos of positions) {
      const enriched = enrichTrain(pos);
      if (!enriched) continue;

      allTrains.push(enriched);

      const prev = lastKnownCircuits.get(pos.TrainId);
      if (prev !== pos.CircuitId) {
        changedTrains.push(enriched);
        lastKnownCircuits.set(pos.TrainId, pos.CircuitId);
      }
    }

    // Remove trains that are no longer reporting
    const activeIds = new Set(positions.map((p) => p.TrainId));
    const removedIds: string[] = [];
    for (const id of lastKnownCircuits.keys()) {
      if (!activeIds.has(id)) {
        lastKnownCircuits.delete(id);
        removedIds.push(id);
      }
    }

    latestSnapshot = allTrains;

    if (changedTrains.length > 0 || removedIds.length > 0) {
      broadcast(changedTrains, removedIds);
    }
  } catch (err) {
    console.error("Error polling trains:", err);
  }
}

let polling = false;

/** Start the async poll loop. No-op if already running. */
export function startPolling(): void {
  if (polling) return;
  polling = true;
  (async () => {
    while (polling) {
      await pollTrains();
      if (!polling) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();
}

/** Stop the poll loop and clear stale data. */
export function stopPolling(): void {
  polling = false;
  latestSnapshot = [];
  lastKnownCircuits.clear();
}

/** Return the latest train data array. */
export function getTrains(): TrainData[] {
  return latestSnapshot;
}

const MAX_CIRCUIT_HOPS = 500;

/**
 * Count how many circuit hops it takes to walk forward from a train's circuit
 * to a station. Uses BFS to handle branching junctions where lines diverge.
 * Returns -1 if the station is not reachable (train has passed it).
 */
export function circuitDistanceToStation(
  circuitId: number,
  directionNum: number,
  stationCode: string,
): number {
  const targetCircuits = stationCircuits.get(stationCode);
  if (!targetCircuits) return -1;
  if (targetCircuits.has(circuitId)) return 0;

  // Dir 1 travels forward (next), Dir 2 travels backward (prev)
  const forward = directionNum === 1 ? nextCircuit : prevCircuit;

  const visited = new Set<number>([circuitId]);
  let frontier = [circuitId];

  for (let hops = 1; hops <= MAX_CIRCUIT_HOPS; hops++) {
    const nextFrontier: number[] = [];
    for (const current of frontier) {
      const neighbors = forward.get(current);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (targetCircuits.has(next)) return hops;
        if (!visited.has(next)) {
          visited.add(next);
          nextFrontier.push(next);
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  return -1;
}

/** Return the latest full snapshot of all trains (wrapped for protocol). */
export function getLatestSnapshot(): { updates: TrainData[]; removals: string[] } {
  return { updates: latestSnapshot, removals: [] };
}
