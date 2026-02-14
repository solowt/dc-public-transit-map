import type { Point, TrainData, TrainPosition } from "./interfaces.d.ts";
import { getStandardRoutes, getTrainPositions } from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 5_000;

// Module state, set by init()
let circuitMap: Record<number, Point>;
let clients: Set<WebSocket>;

// Circuit adjacency (both tracks are ordered in the same physical direction)
const nextCircuit = new Map<number, number>();
const prevCircuit = new Map<number, number>();

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
      nextCircuit.set(circuits[i].CircuitId, circuits[i + 1].CircuitId);
      prevCircuit.set(circuits[i + 1].CircuitId, circuits[i].CircuitId);
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
  const aheadId = forward.get(train.CircuitId);
  if (aheadId !== undefined && circuitMap[aheadId]) {
    heading = bearing(point, circuitMap[aheadId]);
  } else {
    // End of line: use the circuit behind to infer heading
    const behindId = backward.get(train.CircuitId);
    if (behindId !== undefined && circuitMap[behindId]) {
      heading = bearing(circuitMap[behindId], point);
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
 * to a station. Returns -1 if the station is not reachable (train has passed it).
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

  let current = circuitId;
  for (let hops = 1; hops <= MAX_CIRCUIT_HOPS; hops++) {
    const next = forward.get(current);
    if (next === undefined) break;
    if (targetCircuits.has(next)) return hops;
    current = next;
  }
  return -1;
}

/** Return the latest full snapshot of all trains (wrapped for protocol). */
export function getLatestSnapshot(): { updates: TrainData[]; removals: string[] } {
  return { updates: latestSnapshot, removals: [] };
}
