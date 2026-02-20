import type {
  BusIncident,
  BusPosition,
  BusRoute,
  BusStop,
  ElevatorIncident,
  RailIncident,
  StandardRoute,
  Station,
  TrainPosition,
} from "../interfaces.d.ts";

const env = (Deno.env.get("APP_ENV") ?? "development") as
  | "production"
  | "development";
const BASE_URL = "https://api.wmata.com";
const apiKey = env === "development"
  ? (await Deno.readTextFile(".api-key")).trim()
  : Deno.env.get("API_KEY") as string;

const CACHE_DIR = "data/cache";

async function readDiskCache<T>(filename: string): Promise<T | null> {
  try {
    const raw = await Deno.readTextFile(`${CACHE_DIR}/${filename}`);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeDiskCache(filename: string, data: unknown): Promise<void> {
  try {
    await Deno.mkdir(CACHE_DIR, { recursive: true });
  } catch { /* already exists */ }
  await Deno.writeTextFile(`${CACHE_DIR}/${filename}`, JSON.stringify(data));
}

async function fetchWmata<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { api_key: apiKey },
  });
  if (!response.ok) {
    throw new Error(
      `WMATA API error: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

export async function getTrainPositions(): Promise<TrainPosition[]> {
  const data = await fetchWmata<{ TrainPositions: TrainPosition[] }>(
    `${BASE_URL}/TrainPositions/TrainPositions?contentType=json`,
  );
  return data.TrainPositions;
}

let cachedRoutes: StandardRoute[] | null = null;

export async function getStandardRoutes(): Promise<StandardRoute[]> {
  if (cachedRoutes) return cachedRoutes;
  const disk = await readDiskCache<StandardRoute[]>("standard-routes.json");
  if (disk) {
    console.log("Loaded standard routes from disk cache");
    cachedRoutes = disk;
    return cachedRoutes;
  }
  const data = await fetchWmata<{ StandardRoutes: StandardRoute[] }>(
    `${BASE_URL}/TrainPositions/StandardRoutes?contentType=json`,
  );
  cachedRoutes = data.StandardRoutes;
  await writeDiskCache("standard-routes.json", cachedRoutes);
  console.log("Fetched and cached standard routes");
  return cachedRoutes;
}

let cachedStations: Station[] | null = null;

export async function getStations(): Promise<Station[]> {
  if (cachedStations) return cachedStations;
  const disk = await readDiskCache<Station[]>("stations.json");
  if (disk) {
    console.log("Loaded stations from disk cache");
    cachedStations = disk;
    return cachedStations;
  }
  const data = await fetchWmata<{ Stations: Station[] }>(
    `${BASE_URL}/Rail.svc/json/jStations`,
  );
  cachedStations = data.Stations;
  await writeDiskCache("stations.json", cachedStations);
  console.log("Fetched and cached stations");
  return cachedStations;
}

let cachedBusRoutes: BusRoute[] | null = null;

export async function getBusRoutes(): Promise<BusRoute[]> {
  if (cachedBusRoutes) return cachedBusRoutes;
  const disk = await readDiskCache<BusRoute[]>("bus-routes.json");
  if (disk) {
    console.log("Loaded bus routes from disk cache");
    cachedBusRoutes = disk;
    return cachedBusRoutes;
  }
  const data = await fetchWmata<{ Routes: BusRoute[] }>(
    `${BASE_URL}/Bus.svc/json/jRoutes`,
  );
  cachedBusRoutes = data.Routes;
  await writeDiskCache("bus-routes.json", cachedBusRoutes);
  console.log("Fetched and cached bus routes");
  return cachedBusRoutes;
}

let cachedBusStops: BusStop[] | null = null;

export async function getBusStops(routeId: string): Promise<BusStop[]> {
  if (!cachedBusStops) {
    const disk = await readDiskCache<BusStop[]>("bus-stops.json");
    if (disk) {
      console.log("Loaded bus stops from disk cache");
      cachedBusStops = disk;
    } else {
      const data = await fetchWmata<{ Stops: BusStop[] }>(
        `${BASE_URL}/Bus.svc/json/jStops`,
      );
      cachedBusStops = data.Stops;
      await writeDiskCache("bus-stops.json", cachedBusStops);
      console.log("Fetched and cached bus stops");
    }
  }
  return cachedBusStops.filter((s) => s.Routes.includes(routeId));
}

export async function getBusPositions(): Promise<BusPosition[]> {
  const data = await fetchWmata<{ BusPositions: BusPosition[] }>(
    `${BASE_URL}/Bus.svc/json/jBusPositions`,
  );
  return data.BusPositions;
}

interface RouteDirection {
  DirectionNum: string;
  DirectionText: string;
  TripHeadsign: string;
  Shape: { Lat: number; Lon: number; SeqNum: number }[];
}

interface RouteDetailsResponse {
  Direction0: RouteDirection | null;
  Direction1: RouteDirection | null;
  Name: string;
  RouteID: string;
}

interface Entrance {
  ID: string;
  Name: string;
  StationCode1: string;
  StationCode2: string;
  Description: string;
  Lat: number;
  Lon: number;
}

const entranceCache = new Map<string, Entrance[]>();

export async function getEntrances(
  lat: number,
  lon: number,
  radius: number,
): Promise<Entrance[]> {
  const key = `${lat},${lon},${radius}`;
  const cached = entranceCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({
    Lat: String(lat),
    Lon: String(lon),
    Radius: String(radius),
  });
  const data = await fetchWmata<{ Entrances: Entrance[] }>(
    `${BASE_URL}/Rail.svc/json/jStationEntrances?${params}`,
  );
  entranceCache.set(key, data.Entrances);
  return data.Entrances;
}

interface ArrivalPrediction {
  Car: string;
  Destination: string;
  DestinationCode: string;
  DestinationName: string;
  Group: string;
  Line: string;
  LocationCode: string;
  LocationName: string;
  Min: string;
}

export async function getTrainArrivals(
  stationCode: string | null,
): Promise<ArrivalPrediction[]> {
  const code = stationCode || "All";
  const data = await fetchWmata<{ Trains: ArrivalPrediction[] }>(
    `${BASE_URL}/StationPrediction.svc/json/GetPrediction/${encodeURIComponent(code)}`,
  );
  // Replace mangled desination with something more informative
  // To handle other manged cases (see todos)
  return data.Trains.map(t => t.Destination === "ssenger" ? { ...t, Destination: "No Passenger" } : t);
}

export async function getBusIncidents(): Promise<BusIncident[]> {
  const data = await fetchWmata<{ BusIncidents: BusIncident[] }>(
    `${BASE_URL}/Incidents.svc/json/BusIncidents`,
  );
  return data.BusIncidents;
}

export async function getElevatorIncidents(): Promise<ElevatorIncident[]> {
  const data = await fetchWmata<{ ElevatorIncidents: ElevatorIncident[] }>(
    `${BASE_URL}/Incidents.svc/json/ElevatorIncidents`,
  );
  return data.ElevatorIncidents;
}

export async function getRailIncidents(): Promise<RailIncident[]> {
  const data = await fetchWmata<{ Incidents: RailIncident[] }>(
    `${BASE_URL}/Incidents.svc/json/Incidents`,
  );
  return data.Incidents;
}

export async function getRouteShape(
  routeId: string,
  directionText: string,
): Promise<{ Lat: number; Lon: number; SeqNum: number }[]> {
  const data = await fetchWmata<RouteDetailsResponse>(
    `${BASE_URL}/Bus.svc/json/jRouteDetails?RouteID=${
      encodeURIComponent(routeId)
    }&contentType=json`,
  );
  const needle = directionText.toUpperCase();
  for (const dir of [data.Direction0, data.Direction1]) {
    if (dir && dir.DirectionText.toUpperCase() === needle) {
      return dir.Shape;
    }
  }
  return [];
}
