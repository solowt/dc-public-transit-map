import type { TrainData } from "./interfaces.d.ts";
import { getStations, getTrainArrivals } from "./scripts/wmata-api.ts";
import { circuitDistanceToStation } from "./trains.ts";

const POLL_INTERVAL_MS = 10_000;

// Station lookups (populated on first use)
let nameToCode: Map<string, string> | null = null;
// Transfer station paired codes: code → set of equivalent codes (including itself)
let pairedCodes: Map<string, Set<string>> | null = null;

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
  pairedCodes = new Map();
  for (const s of stations) {
    nameToCode.set(s.Name, s.Code);
  }
  // Register aliases
  for (const [alias, canonical] of Object.entries(DESTINATION_ALIASES)) {
    const code = nameToCode.get(canonical);
    if (code) nameToCode.set(alias, code);
  }
  // Build transfer station pairs (e.g. B01 <-> F01 for Gallery Place)
  for (const s of stations) {
    if (s.StationTogether1) {
      const a = s.Code;
      const b = s.StationTogether1;
      if (!pairedCodes.has(a)) pairedCodes.set(a, new Set([a]));
      if (!pairedCodes.has(b)) pairedCodes.set(b, new Set([b]));
      pairedCodes.get(a)!.add(b);
      pairedCodes.get(b)!.add(a);
    }
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

/** Get all equivalent codes for a station (itself + transfer partners). */
function getEquivalentCodes(code: string): Set<string> {
  return pairedCodes?.get(code) ?? new Set([code]);
}

/** Check if two station codes refer to the same physical station. */
function isSameStation(a: string, b: string): boolean {
  if (a === b) return true;
  return getEquivalentCodes(a).has(b);
}

/** Sort key for the Min field: BRD < ARR < numeric minutes < unknown. */
function arrivalMinKey(min: string): number {
  if (min === "BRD") return -1;
  if (min === "ARR") return 0;
  const n = parseInt(min);
  if (!isNaN(n)) return n;
  return Infinity;
}

function arrivalSortCompare(a: ArrivalWithTrain, b: ArrivalWithTrain): number {
  return arrivalMinKey(a.Min) - arrivalMinKey(b.Min);
}

function matchTrainIds(
  arrivals: ArrivalWithTrain[],
  stationCode: string,
): void {
  const trains = getTrainSnapshot();
  const stationCodes = getEquivalentCodes(stationCode);

  // Track which TrainIds have already been assigned to avoid duplicates
  const usedTrainIds = new Set<string>();

  for (const arrival of arrivals) {
    const destCode = resolveDestinationCode(arrival);

    // Find candidate trains that match criteria and are approaching the station
    const candidates: { train: TrainData; hops: number }[] = [];
    for (const t of trains) {
      if (t.LineCode !== arrival.Line) continue;
      if (destCode && !isSameStation(t.DestinationStationCode, destCode)) continue;
      if (arrival.Car !== "-" && arrival.Car !== "" &&
          t.CarCount !== parseInt(arrival.Car)) continue;
      if (usedTrainIds.has(t.TrainId)) continue;

      // Check circuit distance to any of the station's equivalent codes
      let bestHops = -1;
      for (const code of stationCodes) {
        const hops = circuitDistanceToStation(
          t.CircuitId,
          t.DirectionNum,
          code,
        );
        if (hops >= 0 && (bestHops < 0 || hops < bestHops)) {
          bestHops = hops;
        }
      }
      // Only include trains that are approaching (station is ahead)
      if (bestHops >= 0) {
        candidates.push({ train: t, hops: bestHops });
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

    // Expand to include all equivalent codes for transfer stations
    const allCodes = new Set<string>();
    for (const code of codes) {
      for (const eq of getEquivalentCodes(code)) {
        allCodes.add(eq);
      }
    }
    const rawArrivals = await getTrainArrivals([...allCodes].join(","));

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

    // Send merged results to each station's clients
    for (const [code, clients] of stationClients) {
      // Collect arrivals from all equivalent codes
      const stationArrivals: ArrivalWithTrain[] = [];
      for (const eq of getEquivalentCodes(code)) {
        const eqArrivals = byStation.get(eq);
        if (eqArrivals) stationArrivals.push(...eqArrivals);
      }
      stationArrivals.sort(arrivalSortCompare);
      matchTrainIds(stationArrivals, code);
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
  tokenExpiry?: number,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  let expiryTimeout: number | undefined;

  socket.onopen = async () => {
    if (tokenExpiry !== undefined) {
      const ms = tokenExpiry * 1000 - Date.now();
      if (ms > 0) {
        expiryTimeout = setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(4001, "Token expired");
          }
        }, ms);
      } else {
        socket.close(4001, "Token expired");
        return;
      }
    }
    addClient(stationCode, socket);

    // Send initial arrivals immediately with train IDs
    try {
      await ensureStationData();
      const allCodes = [...getEquivalentCodes(stationCode)];
      const rawArrivals = await getTrainArrivals(allCodes.join(","));
      const arrivals: ArrivalWithTrain[] = rawArrivals.map((a) => ({
        ...a,
        DestinationCode: resolveDestinationCode(a) ?? "",
        TrainId: null,
      }));
      arrivals.sort(arrivalSortCompare);
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
    if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
    removeClient(stationCode, socket);
    stopPollingIfEmpty();
  };

  return response;
}
