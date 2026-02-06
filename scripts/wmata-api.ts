import type { Line, TrainPosition, TrackCircuit, StandardRoute, Station } from "../interfaces.d.ts";

const BASE_URL = "https://api.wmata.com";
const apiKey = (await Deno.readTextFile(".api-key")).trim();

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
