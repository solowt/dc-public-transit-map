# DC Transit Map

Real-time transit tracker for the Washington Metropolitan Area Transit
Authority (WMATA). Polls WMATA APIs for live train positions, bus positions,
arrival predictions, and service incidents, then pushes updates to browser
clients over WebSockets.

## Prerequisites

- [Deno](https://deno.land/) v2+
- A [WMATA developer API key](https://developer.wmata.com/)

## Setup

Place your WMATA API key in a `.api-key` file at the project root (development)
or set the `API_KEY` environment variable (production).

```bash
echo "your-api-key-here" > .api-key
```

## Running

```bash
deno task dev     # Development (watches for changes)
deno task start   # Production
```

The server starts on `http://127.0.0.1:8080`.

## Authentication

All API and WebSocket endpoints (except auth and static files) require
authentication via a two-token scheme:

1. **Obtain tokens** — `POST /auth/token` returns a JSON access token and sets
   an HttpOnly refresh token cookie.
2. **Use the access token** — Pass as `Authorization: Bearer <token>` for HTTP
   APIs, or as `?token=<token>` query parameter for WebSocket connections.
3. **Refresh** — When the access token expires (15 min), call
   `POST /auth/refresh` with the cookie to get a new access token and rotated
   refresh token.

WebSocket connections close with code `4001` when the access token expires,
signaling the client to refresh and reconnect.

## Endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/token` | Issue access token + set refresh cookie |
| POST | `/auth/refresh` | Rotate refresh token, return new access token |

### WebSocket (query token auth)

| Path | Poll Rate | Description |
|------|-----------|-------------|
| `/ws/trains?token=...` | 5s | Live train positions with coordinates and heading |
| `/ws/buses?token=...` | 15s | Live bus positions |
| `/ws/arrivals/<stationCode>?token=...` | 10s | Arrival predictions for a station |
| `/ws/incidents?token=...` | 30s | Bus, rail, and elevator/escalator incidents |

Train and bus channels send `{ updates, removals }` diffs after an initial full
snapshot. The arrivals channel sends data grouped by station code. The incidents
channel sends the full snapshot (`{ busIncidents, elevatorIncidents,
railIncidents }`) on every cycle.

### REST API (Bearer token auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stations` | All WMATA stations |
| GET | `/api/bus-routes` | All bus routes |
| GET | `/api/bus-stops?routeId=...` | Stops for a bus route |
| GET | `/api/bus-route?routeId=...&directionText=...` | Bus route shape |
| GET | `/api/entrances?lat=...&lon=...&radius=...` | Station entrances near a point |

### Static

| Path | Description |
|------|-------------|
| `/` | ArcGIS-based map frontend |
| `/maplibre/` | MapLibre-based alternative frontend (work in progress)|
| `/data/*` | Pre-generated JSON data files |

## Other Commands

```bash
deno check main.ts          # Type-check
deno test                   # Run tests (there are none)
deno task process-lines     # Process GeoJSON for shared corridors
deno task clear-cache       # Delete cached data files
```
