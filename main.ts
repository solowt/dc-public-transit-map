import { loadCircuitMap } from "./scripts/generate-map.ts";
import { getRouteShape, getStations } from "./scripts/wmata-api.ts";
import {
  getLatestSnapshot as getTrainSnapshot,
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

const circuitMap = await loadCircuitMap();

// Track connected WebSocket clients (separate sets for trains and buses)
const trainClients = new Set<WebSocket>();
const busClients = new Set<WebSocket>();

// Initialize modules (polling starts on first client connect)
await initTrains(circuitMap, trainClients);
initBuses(busClients);

function handleWebSocket(
  req: Request,
  clients: Set<WebSocket>,
  getSnapshot: () => unknown[],
  onStartPolling: () => void,
  onStopPolling: () => void,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    clients.add(socket);
    if (clients.size === 1) onStartPolling();
    const snapshot = getSnapshot();
    if (snapshot.length > 0) {
      socket.send(JSON.stringify(snapshot));
    }
  };

  socket.onclose = () => {
    clients.delete(socket);
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

Deno.serve({ port: 8080 }, async (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const wsUrl = new URL(req.url);
    if (wsUrl.pathname === "/ws/trains") {
      return handleWebSocket(req, trainClients, getTrainSnapshot, startTrainPolling, stopTrainPolling);
    }
    if (wsUrl.pathname === "/ws/buses") {
      return handleWebSocket(req, busClients, getBusSnapshot, startBusPolling, stopBusPolling);
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

  // Serve public/ directory (default to index.html for directory paths)
  if (pathname.endsWith("/")) pathname += "index.html";
  const filePath = "./public" + pathname;
  return serveStatic(filePath);
});
