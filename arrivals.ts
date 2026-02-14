import type { TrainData } from "./interfaces.d.ts";
import { getStations, getTrainArrivals } from "./scripts/wmata-api.ts";
import { circuitDistanceToStation } from "./trains.ts";

const POLL_INTERVAL_MS = 10_000;

// Station lookups (populated on first use)
let nameToCode: Map<string, string> | null = null;

// WMATA arrival predictions use abbreviated names that don't match the stations
// API. This maps known abbreviations to the canonical station name.
const DESTINATION_ALIASES: Record<string, string> = {
  "Shady Grv": "Shady Grove",
  "Mt Vern Sq": "Mt Vernon Sq 7th St-Convention Center",
  "MtVern Sq": "Mt Vernon Sq 7th St-Convention Center",
  "N Carrollton": "New Carrollton",
  "NewCrlton": "New Carrollton",
  "Branch Av": "Branch Ave",
};

async function ensureStationData() {
  if (nameToCode) return;
  const stations = await getStations();
  nameToCode = new Map();
  for (const s of stations) {
    nameToCode.set(s.Name, s.Code);
  }
  // Register aliases
  for (const [alias, canonical] of Object.entries(DESTINATION_ALIASES)) {
    const code = nameToCode.get(canonical);
    if (code) nameToCode.set(alias, code);
  }
}

function resolveDestinationCode(arrival: { DestinationCode: string | null; DestinationName: string }): string | null {
  if (arrival.DestinationCode) return arrival.DestinationCode;
  return nameToCode?.get(arrival.DestinationName) ?? null;
}

// Reference to train snapshot getter, set by init()
let getTrainSnapshot: () => TrainData[];

export function init(snapshotFn: () => TrainData[]): void {
  getTrainSnapshot = snapshotFn;
}

// Map of station code → set of WebSocket clients watching that station
const stationClients = new Map<string, Set<WebSocket>>();

function addClient(stationCode: string, socket: WebSocket): void {
  let clients = stationClients.get(stationCode);
  if (!clients) {
    clients = new Set();
    stationClients.set(stationCode, clients);
  }
  clients.add(socket);
}

function removeClient(stationCode: string, socket: WebSocket): void {
  const clients = stationClients.get(stationCode);
  if (!clients) return;
  clients.delete(socket);
  if (clients.size === 0) {
    stationClients.delete(stationCode);
  }
}

function totalClients(): number {
  let n = 0;
  for (const clients of stationClients.values()) {
    n += clients.size;
  }
  return n;
}

interface ArrivalWithTrain {
  Car: string;
  Destination: string;
  DestinationCode: string;
  DestinationName: string;
  Group: string;
  Line: string;
  LocationCode: string;
  LocationName: string;
  Min: string;
  TrainId: string | null;
}

function matchTrainIds(
  arrivals: ArrivalWithTrain[],
  stationCode: string,
): void {
  const trains = getTrainSnapshot();

  // Track which TrainIds have already been assigned to avoid duplicates
  const usedTrainIds = new Set<string>();

  for (const arrival of arrivals) {
    const destCode = resolveDestinationCode(arrival);

    // Find candidate trains that match criteria and are approaching the station
    const candidates: { train: TrainData; hops: number }[] = [];
    for (const t of trains) {
      if (t.LineCode !== arrival.Line) continue;
      if (t.DestinationStationCode !== destCode) continue;
      if (arrival.Car !== "-" && arrival.Car !== "" &&
          t.CarCount !== parseInt(arrival.Car)) continue;
      if (usedTrainIds.has(t.TrainId)) continue;

      const hops = circuitDistanceToStation(
        t.CircuitId,
        t.DirectionNum,
        stationCode,
      );
      // Only include trains that are approaching (station is ahead)
      if (hops >= 0) {
        candidates.push({ train: t, hops });
      }
    }

    if (candidates.length === 0) {
      arrival.TrainId = null;
      continue;
    }

    // Sort by circuit distance — closest approaching train first
    candidates.sort((a, b) => a.hops - b.hops);

    arrival.TrainId = candidates[0].train.TrainId;
    usedTrainIds.add(candidates[0].train.TrainId);
  }
}

async function poll(): Promise<void> {
  const codes = [...stationClients.keys()];
  if (codes.length === 0) return;

  try {
    await ensureStationData();
    const rawArrivals = await getTrainArrivals(codes.join(","));

    // Group arrivals by LocationCode
    const byStation = new Map<string, ArrivalWithTrain[]>();
    for (const a of rawArrivals) {
      let list = byStation.get(a.LocationCode);
      if (!list) {
        list = [];
        byStation.set(a.LocationCode, list);
      }
      list.push({ ...a, DestinationCode: resolveDestinationCode(a) ?? "", TrainId: null });
    }

    // Match train IDs per station
    for (const [code, arrivals] of byStation) {
      matchTrainIds(arrivals, code);
    }

    // Send filtered results to each station's clients
    for (const [code, clients] of stationClients) {
      const stationArrivals = byStation.get(code) ?? [];
      const message = JSON.stringify(stationArrivals);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  } catch (err) {
    console.error("Error polling arrivals:", err);
  }
}

let polling = false;

function startPolling(): void {
  if (polling) return;
  polling = true;
  (async () => {
    while (polling) {
      await poll();
      if (!polling) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();
}

function stopPollingIfEmpty(): void {
  if (totalClients() === 0) {
    polling = false;
  }
}

/** Handle a new arrivals WebSocket connection for the given station code. */
export function handleArrivalsSocket(
  req: Request,
  stationCode: string,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = async () => {
    addClient(stationCode, socket);

    // Send initial arrivals immediately with train IDs
    try {
      await ensureStationData();
      const rawArrivals = await getTrainArrivals(stationCode);
      const arrivals: ArrivalWithTrain[] = rawArrivals.map((a) => ({
        ...a,
        DestinationCode: resolveDestinationCode(a) ?? "",
        TrainId: null,
      }));
      matchTrainIds(arrivals, stationCode);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(arrivals));
      }
    } catch (err) {
      console.error("Error fetching initial arrivals:", err);
    }

    startPolling();
  };

  socket.onclose = () => {
    removeClient(stationCode, socket);
    stopPollingIfEmpty();
  };

  return response;
}
