import type { Point, TrainData, TrainPosition } from "./interfaces.d.ts";
import { generateCircuitMap } from "./scripts/generate-map.ts";
import type { CircuitMap } from "./scripts/generate-map.ts";
import { getStations, getTrainPositions } from "./scripts/wmata-api.ts";

const CIRCUIT_MAP_PATH = "circuit-map.json";
const POLL_INTERVAL_MS = 5_000;

/** Flatten the per-line circuit map into a single circuitId -> Point lookup. */
function flattenCircuitMap(nested: CircuitMap): Record<number, Point> {
  const flat: Record<number, Point> = {};
  for (const lineMap of Object.values(nested)) {
    for (const [id, point] of Object.entries(lineMap)) {
      flat[Number(id)] = point;
    }
  }
  return flat;
}

// Load circuit map from disk, or generate and save it
async function loadCircuitMap(): Promise<Record<number, Point>> {
  let nested: CircuitMap;
  try {
    const raw = await Deno.readTextFile(CIRCUIT_MAP_PATH);
    console.log("Loaded circuit map from disk");
    nested = JSON.parse(raw);
  } catch {
    console.log("Circuit map not found, generating...");
    nested = await generateCircuitMap();
    await Deno.writeTextFile(CIRCUIT_MAP_PATH, JSON.stringify(nested, null, 2));
    console.log(`Generated circuit map`);
  }
  const flat = flattenCircuitMap(nested);
  console.log(`Circuit map: ${Object.keys(flat).length} circuits`);
  return flat;
}

const circuitMap = await loadCircuitMap();

// Track connected WebSocket clients
const clients = new Set<WebSocket>();

// Last known circuit for each train, used to detect changes
const lastKnownCircuits = new Map<string, number>();

function enrichTrain(train: TrainPosition): TrainData | null {
  const point = circuitMap[train.CircuitId];
  if (!point) return null;
  return { ...train, location: point };
}

function broadcast(data: TrainData[]) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

async function pollTrains() {
  try {
    const positions = await getTrainPositions();
    const allTrains: TrainData[] = [];
    const changedTrains: TrainData[] = [];

    for (const pos of positions) {
      const enriched = enrichTrain(pos);
      if (!enriched) continue;

      allTrains.push(enriched);

      const prevCircuit = lastKnownCircuits.get(pos.TrainId);
      if (prevCircuit !== pos.CircuitId) {
        changedTrains.push(enriched);
        lastKnownCircuits.set(pos.TrainId, pos.CircuitId);
      }
    }

    // Remove trains that are no longer reporting
    const activeIds = new Set(positions.map((p) => p.TrainId));
    for (const id of lastKnownCircuits.keys()) {
      if (!activeIds.has(id)) {
        lastKnownCircuits.delete(id);
      }
    }

    // Store latest full snapshot for new connections
    latestSnapshot = allTrains;

    if (changedTrains.length > 0) {
      broadcast(changedTrains);
    }
  } catch (err) {
    console.error("Error polling trains:", err);
  }
}

// Latest full snapshot for sending to newly connected clients
let latestSnapshot: TrainData[] = [];

function handleWebSocket(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    clients.add(socket);
    // Send current snapshot immediately on connect
    if (latestSnapshot.length > 0) {
      socket.send(JSON.stringify(latestSnapshot));
    }
  };

  socket.onclose = () => {
    clients.delete(socket);
  };

  return response;
}

// Start polling
setInterval(pollTrains, POLL_INTERVAL_MS);
pollTrains();

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
    return handleWebSocket(req);
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
