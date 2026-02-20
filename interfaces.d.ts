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

export interface BusRoute {
  RouteID: string;
  Name: string;
  LineDescription: string;
}

export interface BusStop {
  StopID: string;
  Name: string;
  Lat: number;
  Lon: number;
  Routes: string[];
}

export interface BusIncident {
  IncidentID: string;
  DateUpdated: string;
  IncidentType: string;
  Description: string;
  RoutesAffected: string[];
}

export interface ElevatorIncident {
  UnitName: string;
  UnitType: string;
  StationCode: string;
  StationName: string;
  LocationDescription: string;
  DateOutOfServ: string;
  DateUpdated: string;
  SymptomDescription: string;
  EstimatedReturnToService: string | null;
}

export interface RailIncident {
  IncidentID: string;
  DateUpdated: string;
  IncidentType: string;
  Description: string;
  LinesAffected: string;
}

export interface IncidentsSnapshot {
  busIncidents: BusIncident[];
  elevatorIncidents: ElevatorIncident[];
  railIncidents: RailIncident[];
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
