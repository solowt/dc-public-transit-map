import type { BusPosition } from "./interfaces.d.ts";
import { getBusPositions } from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 10_000;

let clients: Set<WebSocket>;

// Bus state: track last known "lat,lon" per VehicleID for change detection
const lastKnownPositions = new Map<string, string>();
let latestSnapshot: BusPosition[] = [];

/** Initialize bus module: store client set reference. */
export function init(wsClients: Set<WebSocket>): void {
  clients = wsClients;
}

function broadcast(data: BusPosition[]) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
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
    for (const id of lastKnownPositions.keys()) {
      if (!activeIds.has(id)) {
        lastKnownPositions.delete(id);
      }
    }

    latestSnapshot = positions;

    if (changedBuses.length > 0) {
      broadcast(changedBuses);
    }
  } catch (err) {
    console.error("Error polling buses:", err);
  }
}

let polling = false;

/** Start the async poll loop. No-op if already running. */
export function startPolling(): void {
  if (polling) return;
  polling = true;
  (async () => {
    while (polling) {
      await pollBuses();
      if (!polling) break;
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

/** Return the latest full snapshot of all buses. */
export function getLatestSnapshot(): BusPosition[] {
  return latestSnapshot;
}
