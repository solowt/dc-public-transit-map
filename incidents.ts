import type { IncidentsSnapshot } from "./interfaces.d.ts";
import {
  getBusIncidents,
  getElevatorIncidents,
  getRailIncidents,
} from "./scripts/wmata-api.ts";

const POLL_INTERVAL_MS = 30_000;
const MAX_BACKPRESSURE = 65_536;

const clients = new Set<WebSocket>();

let latestSnapshot: IncidentsSnapshot = {
  busIncidents: [],
  elevatorIncidents: [],
  railIncidents: [],
};

function broadcast(data: IncidentsSnapshot) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > MAX_BACKPRESSURE) {
        client.close(4002, "Slow consumer");
      } else {
        client.send(message);
      }
    }
  }
}

async function pollIncidents() {
  try {
    const [busIncidents, elevatorIncidents, railIncidents] = await Promise.all([
      getBusIncidents(),
      getElevatorIncidents(),
      getRailIncidents(),
    ]);
    latestSnapshot = { busIncidents, elevatorIncidents, railIncidents };
    broadcast(latestSnapshot);
  } catch (err) {
    console.error("Error polling incidents:", err);
  }
}

let polling = false;
let pollGeneration = 0;

function startPolling(): void {
  if (polling) return;
  polling = true;
  const gen = ++pollGeneration;
  (async () => {
    while (polling && gen === pollGeneration) {
      await pollIncidents();
      if (!polling || gen !== pollGeneration) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();
}

function stopPolling(): void {
  polling = false;
  latestSnapshot = {
    busIncidents: [],
    elevatorIncidents: [],
    railIncidents: [],
  };
}

/** Return the latest incidents snapshot. */
export function getLatestSnapshot(): IncidentsSnapshot {
  return latestSnapshot;
}

/** Handle a new incidents WebSocket connection. */
export function handleIncidentsSocket(
  req: Request,
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
    console.log(`[incidents] clients: ${clients.size}`);
    if (clients.size === 1) startPolling();
    // Send current snapshot immediately
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(latestSnapshot));
    }
    pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(latestSnapshot));
      }
    }, 30_000);
  };

  socket.onclose = () => {
    clearInterval(pingInterval);
    if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
    clients.delete(socket);
    console.log(`[incidents] clients: ${clients.size}`);
    if (clients.size === 0) stopPolling();
  };

  return response;
}
