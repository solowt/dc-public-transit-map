export interface Point {
  longitude: number;
  latitude: number;
}

export type Line = "RD" | "BL" | "GR" | "OR" | "SV" | "YL";

export interface TrainData extends TrainPosition {
  location: Point;
  heading: number;
}

export interface TrainPosition {
  TrainId: string;
  TrainNumber: string;
  CarCount: number;
  DirectionNum: number;
  CircuitId: number;
  DestinationStationCode: string;
  LineCode: Line | null;
  SecondsAtLocation: number;
  ServiceType: string;
}

export interface TrackCircuit {
  SeqNum: number;
  CircuitId: number;
  StationCode: string | null;
}

export interface StandardRoute {
  LineCode: Line;
  TrackNum: number;
  TrackCircuits: TrackCircuit[];
}

export interface BusPosition {
  VehicleID: string;
  Lat: number;
  Lon: number;
  RouteID: string;
  DirectionText: string;
  TripHeadsign: string;
  Deviation: number;
  DateTime: string;
  TripEndTime: string;
  TripStartTime: string;
  TripID: string;
}

export interface Station {
  Code: string;
  Name: string;
  StationTogether1: string;
  StationTogether2: string;
  LineCode1: Line | null;
  LineCode2: Line | null;
  LineCode3: Line | null;
  LineCode4: Line | null;
  Lat: number;
  Lon: number;
  Address: {
    Street: string;
    City: string;
    State: string;
    Zip: string;
  };
}
