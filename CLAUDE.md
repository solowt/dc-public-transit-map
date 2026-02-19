# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository.

## Project Overview

A Deno-based real-time transit tracking server and web client for the Washington
Metropolitan Area Transit Authority (WMATA). The system polls WMATA APIs to
track live train and bus positions, calculates geographic coordinates for trains
(which the WMATA API does not natively provide), and pushes updates to connected
browser clients via WebSockets. A pre-computation pipeline converts WMATA's
circuit-based train position data into geographic coordinates using GeoJSON metro
line shapes.

**Stack:**
- **Runtime:** Deno (JSR package imports)
- **Deployment:** DigitalOcean (`root@165.22.36.160`), managed by systemd
- **Protocol:** WebSockets for real-time updates, JWT for authentication
- **Frontend:** Two map implementations — ArcGIS (primary) and MapLibre (alternative)

---

## Commands

```bash
deno task dev           # Run with --watch (development)
deno task start         # Run in production mode
deno task process-lines # Process raw GeoJSON for shared corridors
deno task clear-cache   # Delete cached data files in data/cache/
deno task deploy        # Deploy to DigitalOcean via rsync + systemctl
deno test               # Run all tests
deno check main.ts      # Type-check without running
```

---

## Directory Structure

```
dc-transit-map/
├── main.ts                  # HTTP server, routing, WebSocket handling
├── trains.ts                # Train polling, enrichment, circuit→coord lookup
├── buses.ts                 # Bus polling and broadcasting
├── arrivals.ts              # Arrival predictions + train matching
├── auth.ts                  # JWT access tokens + refresh token rotation
├── interfaces.d.ts          # Shared TypeScript type definitions
├── deno.json                # Tasks, imports, compiler options
├── deno.lock
├── .api-key                 # WMATA API key (dev only; excluded from deploy)
├── scripts/
│   ├── wmata-api.ts         # WMATA API client with caching
│   ├── generate-map.ts      # Generates circuit→coordinate map from GeoJSON
│   ├── polyline.ts          # Polyline geometry (project, interpolate)
│   ├── process-lines.ts     # GeoJSON processing for shared corridors
│   └── deploy.sh            # Deployment script
├── todos.md                 # Task tracking notes
├── public/
│   ├── index.html           # ArcGIS-based map frontend
│   ├── editor.html          # Metro lines GeoJSON editor/viewer
│   ├── maplibre/index.html  # MapLibre-based alternative frontend
│   └── favicon.svg
└── data/
    ├── Metro_Lines_Regional.geojson    # Raw metro line GeoJSON
    ├── metro_lines_processed.geojson   # Processed (shared corridor–aware)
    └── cache/
        ├── circuit-map.json            # Precomputed circuit ID → lat/lon
        ├── standard-routes.json        # WMATA circuit sequences per line
        ├── stations.json               # Station metadata + coordinates
        ├── bus-routes.json             # Bus route definitions
        └── bus-stops.json              # Bus stop locations
```

---

## Architecture

### Data Flow

```
WMATA APIs
    ↓ (every 5s / 10s / 15s)
wmata-api.ts  (fetch wrappers + disk/memory caching)
    ↓
trains.ts / buses.ts / arrivals.ts  (polling + change detection)
    ↓
WebSocket server (main.ts)
    ↓
Browser clients (public/)
```

### Lazy Polling

Polling only starts when the first WebSocket client connects and stops when all
clients disconnect. This conserves WMATA API quota.

---

## Server (`main.ts`)

Deno HTTP server on `127.0.0.1:8080`. Routes all requests by pathname.

### Endpoints

| Endpoint | Type | Auth | Description |
|---|---|---|---|
| `POST /auth/token` | HTTP | None | Issue access token + set refresh cookie |
| `POST /auth/refresh` | HTTP | Cookie | Rotate refresh token, return new access token |
| `GET /ws/trains?token=...` | WebSocket | Query token | Live train positions |
| `GET /ws/buses?token=...` | WebSocket | Query token | Live bus positions |
| `GET /ws/arrivals/<code>?token=...` | WebSocket | Query token | Arrival predictions for a station |
| `GET /api/stations` | HTTP | Bearer | All WMATA stations |
| `GET /api/bus-routes` | HTTP | Bearer | All bus routes |
| `GET /api/bus-stops?routeId=...` | HTTP | Bearer | Stops for a bus route |
| `GET /api/bus-route?routeId=...&directionText=...` | HTTP | Bearer | Bus route shape (GeoJSON) |
| `GET /api/entrances?lat=...&lon=...&radius=...` | HTTP | Bearer | Station entrances near a point |
| `GET /data/*` | Static | None | Pre-generated JSON data files |
| `GET /` or `/public/*` | Static | None | HTML/JS/CSS/SVG frontend assets |

### WebSocket Message Format

All WebSocket channels (trains, buses) use the same envelope:
```json
{
  "updates": [ { ...fields } ],
  "removals": ["trainId1", "trainId2"]
}
```
On connect, clients receive the full current snapshot immediately. After that,
only changes are sent. A ping is sent every 30 seconds. The connection closes
with code `4001` if the access token expires.

Arrivals channel sends a JSON object keyed by station code, where each value
is a sorted array of arrival objects for that code:
```json
{
  "B01": [{ ...arrival }, { ...arrival }],
  "F01": [{ ...arrival }]
}
```
For single-code stations, the object has one key. For transfer stations with
paired codes (e.g., Gallery Place = B01/F01), the object has multiple keys,
allowing the client to segregate arrivals by platform/line. All equivalent
codes are always included as keys, even if their arrival array is empty.

---

## Authentication (`auth.ts`)

Two-token scheme:

- **Access token** (15 min): HS512-signed JWT. Used as Bearer token for HTTP
  APIs or `?token=` query param for WebSocket upgrades. Payload: `{ sub: refreshTokenId, exp }`.
- **Refresh token** (7 days): UUID stored server-side in a `Map`. Sent as
  `HttpOnly; SameSite=Strict` cookie. Rotated on every use (single-use).

A background task prunes expired refresh tokens every 10 minutes.

**API key:** In development, read from `.api-key` file. In production, read from
`API_KEY` environment variable.

---

## Train Tracking (`trains.ts`)

Polls WMATA `TrainPositions` every **5 seconds**.

### Key State

```typescript
circuitMap      // Record<number, Point> loaded from circuit-map.json
nextCircuit     // Map<circuitId, Set<circuitId>> — forward adjacency
prevCircuit     // Map<circuitId, Set<circuitId>> — backward adjacency
stationCircuits // Map<stationCode, Set<circuitId>>
lastKnownCircuits // Map<trainId, circuitId> — for change detection
latestSnapshot  // TrainData[] — sent to new clients on connect
```

### `enrichTrain()` Algorithm

1. Look up `CircuitId` in `circuitMap` → `location: { latitude, longitude }`
2. Compute heading via `bearing()`:
   - Dir 1 trains: bearing from current to any next circuit
   - Dir 2 trains: bearing from current to any prev circuit
   - Falls back to reverse bearing if no forward circuit exists (end of line)

### `bearing(a, b)` Formula

Uses the haversine/atan2 bearing formula to return a 0–360° compass heading
from point A to point B.

### `circuitDistanceToStation()` — BFS

Starting from a train's current circuit, performs a BFS following
direction-appropriate edges (next or prev) to count circuit hops to a target
station. Used by the arrivals module to match trains to predictions. Returns -1
if station is not reachable ahead.

### Change Detection

Only broadcasts when a train moves to a new circuit (comparing
`lastKnownCircuits`). Removals (trains no longer in API response) are included
in every diff.

---

## Bus Tracking (`buses.ts`)

Polls WMATA `BusPositions` every **15 seconds**.

Simpler than trains: WMATA already provides `Lat`/`Lon` for buses. Change
detection uses `"lat,lon"` string comparison per vehicle. Same
`updates`/`removals` broadcast protocol as trains.

---

## Arrival Predictions (`arrivals.ts`)

Polls WMATA `StationPrediction` every **10 seconds** per subscribed station.

### Key Features

- **Transfer station handling:** Some stations have multiple codes (e.g., Gallery
  Place = B01/F01, Metro Center = A01/C01). The `pairedCodes` map tracks
  these using `StationTogether1` from station data (note: `StationTogether2`
  is not currently used). Arrival requests fetch from all paired codes and
  merge results.

- **Destination name resolution:** Maps partial WMATA destination names (e.g.,
  "Shady Grv") to full names and station codes via an alias lookup.

- **Train matching (`matchTrainIds()`):** For each arrival prediction, finds the
  best matching live train by: line code, destination, car count, and proximity
  (using `circuitDistanceToStation()` BFS). Avoids duplicate assignments.

- **Sort order:** Arrivals sorted by `Min` field: `"BRD"` < `"ARR"` < numeric
  minutes.

---

## WMATA API Integration (`scripts/wmata-api.ts`)

### Endpoints Used

| Endpoint | Cache | Interval | Purpose |
|---|---|---|---|
| `TrainPositions/TrainPositions` | None | 5s | Live train circuits |
| `TrainPositions/StandardRoutes` | Disk + memory | Startup | Circuit sequences |
| `Rail.svc/json/jStations` | Disk + memory | Startup | Station metadata |
| `Bus.svc/json/jBusPositions` | None | 15s | Live bus coordinates |
| `Bus.svc/json/jRoutes` | Disk + memory | Startup | Bus routes |
| `Bus.svc/json/jStops` | Disk + memory | Startup | Bus stops |
| `Bus.svc/json/jRouteDetails` | None | On-demand | Bus route shapes |
| `Rail.svc/json/jStationEntrances` | Memory | On-demand | Station entrances |
| `StationPrediction.svc/json/GetPrediction` | None | 10s | Arrival predictions |

### Caching Strategy

Static data (routes, stations, stops) is cached to `data/cache/` on first fetch
and reloaded from disk on restart. Dynamic data (positions, predictions) is never
cached. Entrances are cached in memory on first request; route shapes are fetched
fresh each time.

---

## Circuit-to-Coordinate Map (`scripts/generate-map.ts`)

This is the core precomputation pipeline. Run once; output cached to
`data/cache/circuit-map.json` and loaded at server startup.

### Algorithm

1. **Load GeoJSON** (`metro_lines_processed.geojson`): Metro line polylines with
   shared-corridor metadata per line.

2. **Chain segments** into continuous polylines per line using a proximity-based
   chaining algorithm (O(n²) segment matching by endpoint proximity).

3. **Project stations** onto polylines: For each station, find the closest point
   on its line's polyline using `projectOntoPolyline()`. Store as anchor:
   `{ circuitIndex, polylineParam, lat, lon }`.

4. **Interpolate circuits** between consecutive anchor stations:
   ```
   t = (circuitIndex - A.circuitIndex) / (B.circuitIndex - A.circuitIndex)
   param = A.param + t * (B.param - A.param)
   coord = interpolatePolyline(polyline, param)
   ```
   Circuits beyond the first/last anchor are clamped to the anchor position.

5. **Flatten** nested `Record<Line, Record<CircuitId, Point>>` to flat
   `Record<CircuitId, Point>` and write to disk.

### Polyline Utilities (`scripts/polyline.ts`)

```typescript
buildPolyline(coords)              // Precompute cumulative distances
projectOntoPolyline(poly, point)   // Closest point + distance parameter
interpolatePolyline(poly, param)   // [lng, lat] at distance parameter
```

`projectOntoPolyline` is O(vertices); `interpolatePolyline` uses binary search
O(log vertices).

---

## Type Definitions (`interfaces.d.ts`)

```typescript
Point            { longitude, latitude }
Line             "RD" | "BL" | "GR" | "OR" | "SV" | "YL"
TrainPosition    { TrainId, TrainNumber, CarCount, DirectionNum, CircuitId,
                   DestinationStationCode, LineCode: Line | null, SecondsAtLocation, ServiceType }
TrainData        extends TrainPosition { location: Point; heading: number }
BusPosition      { VehicleID, Lat, Lon, RouteID, DirectionText, TripHeadsign,
                   Deviation, DateTime, TripEndTime, TripStartTime, TripID }
BusRoute         { RouteID, Name, LineDescription }
BusStop          { StopID, Name, Lat, Lon, Routes: string[] }
Station          { Code, Name, Lat, Lon, LineCode1-4: Line | null, StationTogether1-2, Address }
TrackCircuit     { SeqNum, CircuitId, StationCode: string | null }
StandardRoute    { LineCode: Line, TrackNum, TrackCircuits: TrackCircuit[] }
```

---

## Frontend Clients (`public/`)

Both frontends connect to the WebSocket endpoints on load, parse JSON updates,
and update marker positions in real-time.

- **`index.html`** — ArcGIS JavaScript API v4.34 + Calcite Components v5.0.
  Dark theme. Responsive (mobile sheet / desktop panel). Layer toggles for
  trains and buses.
- **`editor.html`** — ArcGIS-based metro lines GeoJSON editor/viewer for
  inspecting processed line data.
- **`maplibre/index.html`** — MapLibre GL v5. Lightweight alternative. Same dark
  theme. Status indicators (live / connecting / disconnected), vehicle counts.

Both main frontends handle token acquisition (`POST /auth/token`), token refresh
on expiry, and WebSocket reconnection.

---

## Deployment (`scripts/deploy.sh`)

1. `rsync` project to `/opt/dc-transit-map_new` on the remote, excluding files
   listed in `.rsyncignore` (`.git/`, `.gitignore`, `.api-key`, `CLAUDE.md`,
   `todos.md`, and Claude-related tool directories/files).
2. SSH: backup old install to `_old`, move new to `/opt/dc-transit-map`.
3. `systemctl restart dc-transit-map`
4. Stream logs via `journalctl`.

Production API key comes from the `API_KEY` environment variable in the systemd
unit, not from `.api-key`.
