import type { BusPosition } from "./interfaces.d.ts";
import { getBusPositions } from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 15_000;

let clients: Set<WebSocket>;

// Bus state: track last known "lat,lon" per VehicleID for change detection
const lastKnownPositions = new Map<string, string>();
let latestSnapshot: BusPosition[] = [];

/** Initialize bus module: store client set reference. */
export function init(wsClients: Set<WebSocket>): void {
  clients = wsClients;
}

const MAX_BACKPRESSURE = 65_536;

function broadcast(updates: BusPosition[], removals: string[] = []) {
  const message = JSON.stringify({ updates, removals });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > MAX_BACKPRESSURE) {
        client.close(4002, "Slow consumer");
      } else {
        client.send(message);
      }
    }
  }
}

async function pollBuses() {
  try {
    const positions = await getBusPositions();
    const changedBuses: BusPosition[] = [];

    for (const bus of positions) {
      const key = `${bus.Lat},${bus.Lon}`;
      const prev = lastKnownPositions.get(bus.VehicleID);
      if (prev !== key) {
        changedBuses.push(bus);
        lastKnownPositions.set(bus.VehicleID, key);
      }
    }

    // Remove buses that are no longer reporting
    const activeIds = new Set(positions.map((b) => b.VehicleID));
    const removedIds: string[] = [];
    for (const id of lastKnownPositions.keys()) {
      if (!activeIds.has(id)) {
        lastKnownPositions.delete(id);
        removedIds.push(id);
      }
    }

    latestSnapshot = positions;

    if (changedBuses.length > 0 || removedIds.length > 0) {
      broadcast(changedBuses, removedIds);
    }
  } catch (err) {
    console.error("Error polling buses:", err);
  }
}

let polling = false;
let pollGeneration = 0;

/** Start the async poll loop. No-op if already running. */
export function startPolling(): void {
  if (polling) return;
  polling = true;
  const gen = ++pollGeneration;
  (async () => {
    while (polling && gen === pollGeneration) {
      await pollBuses();
      if (!polling || gen !== pollGeneration) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();
}

/** Stop the poll loop and clear stale data. */
export function stopPolling(): void {
  polling = false;
  latestSnapshot = [];
  lastKnownPositions.clear();
}

/** Return the latest full snapshot of all buses (wrapped for protocol). */
export function getLatestSnapshot(): { updates: BusPosition[]; removals: string[] } {
  return { updates: latestSnapshot, removals: [] };
}
