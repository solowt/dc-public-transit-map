import type { Point, TrainData, TrainPosition } from "./interfaces.d.ts";
import { getStandardRoutes, getTrainPositions } from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 5_000;

// Module state, set by init()
let circuitMap: Record<number, Point>;
let clients: Set<WebSocket>;

// Circuit adjacency (both tracks are ordered in the same physical direction)
const nextCircuit = new Map<number, number>();
const prevCircuit = new Map<number, number>();

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

function broadcast(data: TrainData[]) {
  const message = JSON.stringify(data);
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
    for (const id of lastKnownCircuits.keys()) {
      if (!activeIds.has(id)) {
        lastKnownCircuits.delete(id);
      }
    }

    latestSnapshot = allTrains;

    if (changedTrains.length > 0) {
      broadcast(changedTrains);
    }
  } catch (err) {
    console.error("Error polling trains:", err);
  }
}

/** Start polling for train positions at a fixed interval. */
export function startPolling(): void {
  setInterval(pollTrains, POLL_INTERVAL_MS);
  pollTrains();
}

/** Return the latest full snapshot of all trains. */
export function getLatestSnapshot(): TrainData[] {
  return latestSnapshot;
}
