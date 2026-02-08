import type {
  BusPosition,
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

export async function getStandardRoutes(): Promise<StandardRoute[]> {
  const data = await fetchWmata<{ StandardRoutes: StandardRoute[] }>(
    `${BASE_URL}/TrainPositions/StandardRoutes?contentType=json`,
  );
  return data.StandardRoutes;
}

export async function getStations(): Promise<Station[]> {
  const data = await fetchWmata<{ Stations: Station[] }>(
    `${BASE_URL}/Rail.svc/json/jStations`,
  );
  return data.Stations;
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
