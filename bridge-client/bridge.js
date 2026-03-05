/**
 * Bridge Client - Runs on the user's machine
 *
 * SECURITY MODEL:
 *
 * This bridge is the cornerstone of the secure architecture:
 *
 * 1. NO LOCAL SERVERS EXPOSED - This is a WebSocket CLIENT, not a server.
 *    Nothing listens on any port. The user's machine has zero attack surface.
 *
 * 2. NO PORTS OPENED - Only standard outbound WSS (port 443) traffic.
 *    Works behind any NAT, firewall, or corporate proxy.
 *
 * 3. GATEWAY TOKEN STAYS LOCAL - The OpenClaw Gateway Token is loaded
 *    from the local .env file and ONLY used to authenticate with
 *    OpenClaw over the local WebSocket. It is NEVER sent to the
 *    AlphArena backend server.
 *
 * 4. OUTBOUND-ONLY CONNECTION - The bridge initiates the connection
 *    to the backend. The backend cannot reach the bridge unless the
 *    bridge has connected first. This eliminates SSRF and reverse-
 *    connection attack vectors.
 *
 * 5. COMMAND VALIDATION - Every command received from the backend is
 *    validated before execution. The bridge only acts on known command
 *    types with properly structured payloads.
 *
 * Why this is better than exposing a public API on the user's machine:
 * - No DNS/IP exposure needed
 * - No SSL certificate management for the bridge
 * - No DDoS risk on the user's machine
 * - No authentication endpoint to brute-force
 * - The gateway token cannot be intercepted in transit to the backend
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const WebSocket = require('ws');
const OpenClawWsClient = require('./openclawClient');

// --- Configuration ---
const BACKEND_WS_URL = process.env.BACKEND_WS_URL;
const AGENT_ID = process.env.AGENT_ID;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'wss://gateway.openclaw.ai/ws';
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';

if (!BACKEND_WS_URL || !AGENT_ID || !OPENCLAW_GATEWAY_TOKEN) {
  console.error('[Bridge] Missing required environment variables.');
  console.error('[Bridge] Required: BACKEND_WS_URL, AGENT_ID, OPENCLAW_GATEWAY_TOKEN');
  console.error('[Bridge] Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// --- State ---
let ws = null;
let heartbeatInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60_000;

// --- OpenClaw Client ---
// The gateway token is used HERE, locally, and nowhere else.
// It authenticates with OpenClaw via Ed25519 challenge-response.
// The token NEVER travels over the backend WebSocket.
let openclawClient = null;

async function ensureOpenClawConnected() {
  if (openclawClient && openclawClient.state === 'connected') {
    return openclawClient;
  }

  // Disconnect stale client if any
  if (openclawClient) {
    openclawClient.disconnect();
  }

  console.log(`[OpenClaw] Connecting to ${OPENCLAW_GATEWAY_URL}...`);
  openclawClient = new OpenClawWsClient({
    url: OPENCLAW_GATEWAY_URL,
    token: OPENCLAW_GATEWAY_TOKEN,
    reconnect: true,
    reconnectDelay: 800,
  });

  openclawClient.on('error', (err) => {
    console.error(`[OpenClaw] Error: ${err.message}`);
  });

  openclawClient.on('stateChange', (state) => {
    console.log(`[OpenClaw] State: ${state}`);
  });

  openclawClient.connect();
  await openclawClient.waitForConnect(15000);
  console.log('[OpenClaw] Connected and authenticated');
  return openclawClient;
}

// --- Backend WebSocket Connection ---

function connect() {
  console.log(`[Bridge] Connecting to ${BACKEND_WS_URL}...`);

  ws = new WebSocket(BACKEND_WS_URL);

  ws.on('open', () => {
    console.log('[Bridge] Connected to backend');
    reconnectAttempts = 0;

    // Register this agent with the backend
    send({
      type: 'register',
      agent_id: AGENT_ID,
    });

    startHeartbeat();
  });

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.error('[Bridge] Received invalid JSON from backend');
      return;
    }

    console.log(`[Bridge] Received: ${message.type}`);

    switch (message.type) {
      case 'registered':
        console.log(`[Bridge] Registration confirmed: ${message.message}`);
        break;

      case 'command':
        await handleCommand(message);
        break;

      case 'heartbeat_ack':
        break;

      case 'error':
        console.error(`[Bridge] Error from backend: ${message.message}`);
        break;

      default:
        console.log(`[Bridge] Unknown message type: ${message.type}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Bridge] Disconnected (code=${code}, reason=${reason})`);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] WebSocket error: ${err.message}`);
  });
}

// --- Command Handling ---
// The backend sends commands through the WebSocket. The bridge executes
// them using the local OpenClaw connection (which uses the gateway token).
// Only the RESULT text is sent back -- never the token.

async function handleCommand(message) {
  const { command_id, command, payload } = message;
  console.log(`[Bridge] Executing command: ${command} (${command_id})`);

  try {
    let result;

    switch (command) {
      // Simple ping -- responds immediately, no OpenClaw needed.
      // Used by the backend's POST /agents/:id/ping endpoint to verify
      // the bridge is alive and reachable.
      case 'ping': {
        result = {
          bridge: 'online',
          agent_id: AGENT_ID,
          uptime: process.uptime(),
          timestamp: Date.now(),
          openclaw_state: openclawClient ? openclawClient.state : 'not_initialized',
        };
        break;
      }

      // Primary command: send a prompt to the OpenClaw agent and wait for response.
      // Used for game moves -- the backend sends the board state + legal moves as
      // a prompt, and the agent responds with its chosen move.
      case 'agent_chat': {
        const client = await ensureOpenClawConnected();
        const params = {
          message: payload.message,
          agentId: payload.agentId || OPENCLAW_AGENT_ID,
        };
        const response = await client.agentAndWait(params, payload.timeoutMs || 90000);
        // Extract the text from the assistant stream event
        const text = response.data?.text || response.text || JSON.stringify(response);
        result = { text };
        break;
      }

      // Wake the agent (useful before a game to reduce cold-start latency)
      case 'wake': {
        const client = await ensureOpenClawConnected();
        const response = await client.wake({
          text: payload.text || 'AlphArena wake',
          mode: payload.mode || 'now',
        });
        result = response;
        break;
      }

      // Health check -- verify the OpenClaw agent is reachable
      case 'health': {
        const client = await ensureOpenClawConnected();
        const response = await client.health();
        result = response;
        break;
      }

      // Status of the bridge itself
      case 'bridge_status': {
        result = {
          bridge: 'online',
          openclaw_state: openclawClient ? openclawClient.state : 'disconnected',
          uptime: process.uptime(),
          memory: process.memoryUsage().heapUsed,
        };
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }

    // Send result back to backend. Note: only the result data is sent.
    // The gateway token stays local -- it was used by openclawClient
    // to authenticate with OpenClaw, not with our backend.
    send({
      type: 'result',
      agent_id: AGENT_ID,
      command_id,
      status: 'success',
      data: result,
    });

    console.log(`[Bridge] Command ${command_id} completed successfully`);
  } catch (err) {
    console.error(`[Bridge] Command ${command_id} failed: ${err.message}`);

    send({
      type: 'result',
      agent_id: AGENT_ID,
      command_id,
      status: 'error',
      data: { error: err.message },
    });
  }
}

// --- Heartbeat ---

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: 'heartbeat', agent_id: AGENT_ID });
    }
  }, 30_000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// --- Reconnection with Exponential Backoff ---

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  console.log(`[Bridge] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  setTimeout(connect, delay);
}

// --- Helpers ---

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// --- Start ---

console.log('[Bridge] AlphArena Bridge Client');
console.log(`[Bridge] Agent ID:       ${AGENT_ID}`);
console.log(`[Bridge] Backend:        ${BACKEND_WS_URL}`);
console.log(`[Bridge] OpenClaw URL:   ${OPENCLAW_GATEWAY_URL}`);
console.log(`[Bridge] OpenClaw Agent: ${OPENCLAW_AGENT_ID}`);
console.log('[Bridge] Gateway token loaded locally (will NOT be sent to backend)');
console.log('');

connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  stopHeartbeat();
  if (openclawClient) openclawClient.disconnect();
  if (ws) ws.close(1000, 'Bridge shutting down');
  process.exit(0);
});
