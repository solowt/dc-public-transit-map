import { loadCircuitMap } from "./scripts/generate-map.ts";
import { getBusRoutes, getBusStops, getRouteShape, getStations, getEntrances, getWmataUsage } from "./scripts/wmata-api.ts";
import { handleArrivalsSocket, init as initArrivals } from "./arrivals.ts";
import {
  getLatestSnapshot as getTrainSnapshot,
  getTrains,
  init as initTrains,
  startPolling as startTrainPolling,
  stopPolling as stopTrainPolling,
} from "./trains.ts";
import {
  getLatestSnapshot as getBusSnapshot,
  init as initBuses,
  startPolling as startBusPolling,
  stopPolling as stopBusPolling,
} from "./buses.ts";
import { handleIncidentsSocket } from "./incidents.ts";
import { createTokens, refreshAccessToken, verifyAccessToken } from "./auth.ts";

const circuitMap = await loadCircuitMap();

// Track connected WebSocket clients (separate sets for trains and buses)
const trainClients = new Set<WebSocket>();
const busClients = new Set<WebSocket>();

// Initialize modules (polling starts on first client connect)
await initTrains(circuitMap, trainClients);
initBuses(busClients);
initArrivals(getTrains);

function handleWebSocket(
  req: Request,
  label: string,
  clients: Set<WebSocket>,
  getSnapshot: () => { updates: unknown[]; removals: string[] },
  onStartPolling: () => void,
  onStopPolling: () => void,
  tokenExpiry?: number,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  let pingInterval: number;
  let expiryTimeout: number | undefined;

  socket.onopen = () => {
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
    clients.add(socket);
    console.log(`[${label}] clients: ${clients.size}`);
    if (clients.size === 1) onStartPolling();
    const snapshot = getSnapshot();
    if (snapshot.updates.length > 0) {
      socket.send(JSON.stringify(snapshot));
    }
    pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ updates: [], removals: [] }));
      }
    }, 30_000);
  };

  socket.onclose = () => {
    clearInterval(pingInterval);
    if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
    clients.delete(socket);
    console.log(`[${label}] clients: ${clients.size}`);
    if (clients.size === 0) onStopPolling();
  };

  return response;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".geojson": "application/json",
  ".svg": "image/svg+xml",
};

async function serveStatic(path: string): Promise<Response> {
  try {
    const stat = await Deno.stat(path);
    if (stat.isDirectory) {
      path = path.replace(/\/?$/, "/index.html");
    }
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const ext = path.substring(path.lastIndexOf("."));
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  try {
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: { "content-type": contentType },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function authenticate(
  req: Request,
): Promise<{ payload: { sub: string; exp: number } } | { error: Response }> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) };
  }
  const payload = await verifyAccessToken(authHeader.slice(7));
  if (!payload) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) };
  }
  return { payload };
}

async function authenticateWs(
  req: Request,
): Promise<{ payload: { sub: string; exp: number } } | { error: Response }> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) };
  }
  const payload = await verifyAccessToken(token);
  if (!payload) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) };
  }
  return { payload };
}

Deno.serve({ port: 8080, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Auth endpoints (no auth required)
  if (pathname === "/auth/token" && req.method === "POST") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? req.headers.get("x-real-ip")
            ?? "unknown";
    const ua = req.headers.get("user-agent") ?? "unknown";
    const referer = req.headers.get("referer") ?? "none";
    console.log(`[auth] new token ip=${ip} ua=${ua} referer=${referer}`);
    const { accessToken, refreshTokenCookie } = await createTokens();
    return new Response(JSON.stringify({ token: accessToken }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": refreshTokenCookie,
      },
    });
  }

  if (pathname === "/auth/refresh" && req.method === "POST") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? req.headers.get("x-real-ip")
            ?? "unknown";
    const ua = req.headers.get("user-agent") ?? "unknown";
    const referer = req.headers.get("referer") ?? "none";
    const result = await refreshAccessToken(req.headers.get("cookie"));
    if (!result) {
      console.log(`[auth] refresh failed ip=${ip} ua=${ua} referer=${referer}`);
      return new Response(JSON.stringify({ error: "Invalid refresh token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    console.log(`[auth] refresh ok ip=${ip} ua=${ua} referer=${referer}`);
    return new Response(JSON.stringify({ token: result.accessToken }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": result.refreshTokenCookie,
      },
    });
  }

  // WebSocket routes (auth via query param)
  if (req.headers.get("upgrade") === "websocket") {
    const auth = await authenticateWs(req);
    if ("error" in auth) {
      // Upgrade then immediately close with 4001 so the client gets a
      // distinguishable code (a plain 401 shows up as 1006 on the client).
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => socket.close(4001, "Token expired");
      return response;
    }

    if (pathname === "/ws/trains") {
      return handleWebSocket(req, "trains", trainClients, getTrainSnapshot, startTrainPolling, stopTrainPolling, auth.payload.exp);
    }
    if (pathname === "/ws/buses") {
      return handleWebSocket(req, "buses", busClients, getBusSnapshot, startBusPolling, stopBusPolling, auth.payload.exp);
    }
    if (pathname === "/ws/incidents") {
      return handleIncidentsSocket(req, auth.payload.exp);
    }
    const arrivalsMatch = pathname.match(/^\/ws\/arrivals\/([A-Za-z0-9]+)$/);
    if (arrivalsMatch) {
      return handleArrivalsSocket(req, arrivalsMatch[1], auth.payload.exp);
    }
    return new Response("Not Found", { status: 404 });
  }

  // API: WMATA request counter (no auth — lightweight diagnostic)
  if (pathname === "/api/wmata-usage") {
    return new Response(JSON.stringify(getWmataUsage()), {
      headers: { "content-type": "application/json" },
    });
  }

  // Auth gate for all /api/* routes
  if (pathname.startsWith("/api/")) {
    const auth = await authenticate(req);
    if ("error" in auth) return auth.error;
  }

  // API: entrances
  if (pathname === "/api/entrances") {
    const lat = url.searchParams.get("lat");
    const lon = url.searchParams.get("lon");
    const radius = url.searchParams.get("radius");
    if (!lat || !lon || !radius) {
      return new Response("Missing lat, lon, or radius", { status: 400 });
    }
    try {
      const entrances = await getEntrances(Number(lat), Number(lon), Number(radius));
      return new Response(JSON.stringify(entrances), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("Error fetching entrances:", err);
      return new Response("Failed to fetch entrances", { status: 500 });
    }
  }

  // API: stations
  if (pathname === "/api/stations") {
    try {
      const stations = await getStations();
      return new Response(JSON.stringify(stations), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("Error fetching stations:", err);
      return new Response("Failed to fetch stations", { status: 500 });
    }
  }

  // API: bus routes
  if (pathname === "/api/bus-routes") {
    try {
      const routes = await getBusRoutes();
      return new Response(JSON.stringify(routes), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("Error fetching bus routes:", err);
      return new Response("Failed to fetch bus routes", { status: 500 });
    }
  }

  // API: bus stops (filtered by route)
  if (pathname === "/api/bus-stops") {
    const routeId = url.searchParams.get("routeId");
    if (!routeId) {
      return new Response("Missing routeId", { status: 400 });
    }
    try {
      const stops = await getBusStops(routeId);
      return new Response(JSON.stringify(stops), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("Error fetching bus stops:", err);
      return new Response("Failed to fetch bus stops", { status: 500 });
    }
  }

  // API: bus route shape
  if (pathname === "/api/bus-route") {
    const routeId = url.searchParams.get("routeId");
    const directionText = url.searchParams.get("directionText");
    if (!routeId || !directionText) {
      return new Response("Missing routeId or directionText", { status: 400 });
    }
    try {
      const shape = await getRouteShape(routeId, directionText);
      return new Response(JSON.stringify(shape), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("Error fetching bus route:", err);
      return new Response("Failed to fetch bus route", { status: 500 });
    }
  }

  // Serve data/ directory
  if (pathname.startsWith("/data/")) {
    const filePath = "." + pathname;
    return serveStatic(filePath);
  }

  // Serve public/ directory (default to index.html for directory paths)
  const publicPath = pathname.endsWith("/") ? pathname + "index.html" : pathname;
  const filePath = "./public" + publicPath;
  return serveStatic(filePath);
});
