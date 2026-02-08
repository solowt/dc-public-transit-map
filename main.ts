import { loadCircuitMap } from "./scripts/generate-map.ts";
import { getRouteShape, getStations } from "./scripts/wmata-api.ts";
import {
  getLatestSnapshot as getTrainSnapshot,
  init as initTrains,
  startPolling as startTrainPolling,
} from "./trains.ts";
import {
  getLatestSnapshot as getBusSnapshot,
  init as initBuses,
  startPolling as startBusPolling,
} from "./buses.ts";

const circuitMap = await loadCircuitMap();

// Track connected WebSocket clients (separate sets for trains and buses)
const trainClients = new Set<WebSocket>();
const busClients = new Set<WebSocket>();

// Initialize modules and start polling
await initTrains(circuitMap, trainClients);
startTrainPolling();

initBuses(busClients);
startBusPolling();

function handleWebSocket(
  req: Request,
  clients: Set<WebSocket>,
  getSnapshot: () => unknown[],
): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    clients.add(socket);
    const snapshot = getSnapshot();
    if (snapshot.length > 0) {
      socket.send(JSON.stringify(snapshot));
    }
  };

  socket.onclose = () => {
    clients.delete(socket);
  };

  return response;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".geojson": "application/json",
};

async function serveStatic(path: string): Promise<Response> {
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

Deno.serve({ port: 8080 }, async (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const wsUrl = new URL(req.url);
    if (wsUrl.pathname === "/ws/trains") {
      return handleWebSocket(req, trainClients, getTrainSnapshot);
    }
    if (wsUrl.pathname === "/ws/buses") {
      return handleWebSocket(req, busClients, getBusSnapshot);
    }
    return new Response("Not Found", { status: 404 });
  }

  const url = new URL(req.url);
  let pathname = url.pathname;

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

  // Serve public/ directory (default to index.html)
  if (pathname === "/") pathname = "/index.html";
  const filePath = "./public" + pathname;
  return serveStatic(filePath);
});
