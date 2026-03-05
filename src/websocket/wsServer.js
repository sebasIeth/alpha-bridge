/**
 * WebSocket Server
 *
 * SECURITY MODEL - Why this architecture is secure:
 *
 * 1. The bridge (on the user's machine) initiates the connection TO us.
 *    We never connect outbound to the user's machine.
 *
 * 2. No local servers are exposed to the internet on the user's side.
 *    The bridge is a WebSocket CLIENT, not a server.
 *
 * 3. No ports need to be opened on the user's machine.
 *    Only standard outbound HTTPS/WSS traffic (port 443) is required.
 *
 * 4. The connection works behind NAT and firewalls because
 *    the user's bridge initiates the outbound connection.
 *
 * 5. The OpenClaw Gateway Token NEVER leaves the user's machine.
 *    The bridge uses it locally to talk to OpenClaw, and only sends
 *    command results back through the WebSocket.
 *
 * 6. Only our backend can send commands through the established
 *    WebSocket channel. The bridge validates message format before acting.
 */

const { WebSocketServer } = require('ws');

function createWebSocketServer(server, registry, pendingCommands) {
  const wss = new WebSocketServer({ server, path: '/agent-connect' });

  wss.on('connection', (ws, req) => {
    let agentId = null;
    const remoteAddr = req.socket.remoteAddress;
    console.log(`[WS] New connection from ${remoteAddr}`);

    // Agents must register within 10 seconds or get disconnected
    const registrationTimeout = setTimeout(() => {
      if (!agentId) {
        console.log(`[WS] Connection from ${remoteAddr} timed out (no registration)`);
        ws.close(4001, 'Registration timeout');
      }
    }, 10_000);

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // --- Registration ---
      if (message.type === 'register') {
        if (!message.agent_id || typeof message.agent_id !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing or invalid agent_id' }));
          ws.close(4002, 'Invalid agent_id');
          return;
        }

        agentId = message.agent_id;
        clearTimeout(registrationTimeout);
        registry.register(agentId, ws);

        ws.send(JSON.stringify({
          type: 'registered',
          agent_id: agentId,
          message: 'Successfully connected to backend',
        }));
        return;
      }

      // All other messages require a registered agent
      if (!agentId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Must register first' }));
        return;
      }

      // --- Heartbeat ---
      if (message.type === 'heartbeat') {
        registry.recordHeartbeat(agentId);
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        return;
      }

      // --- Command results from bridge ---
      // This is the key piece: when a bridge responds to a command,
      // we resolve the pending Promise so the HTTP endpoint can return
      // the actual result to whoever called the API.
      if (message.type === 'result') {
        const { command_id, status, data } = message;
        console.log(`[WS] Result from ${agentId}: command=${command_id} status=${status}`);

        const resolved = pendingCommands.resolve(command_id, { status, data });
        if (!resolved) {
          console.log(`[WS] No pending request for command ${command_id} (already timed out or fire-and-forget)`);
        }
        return;
      }

      console.log(`[WS] Unknown message type from ${agentId}: ${message.type}`);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(registrationTimeout);
      if (agentId) {
        console.log(`[WS] Agent disconnected: ${agentId} (code=${code})`);
        registry.unregister(agentId);
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for agent ${agentId || 'unregistered'}: ${err.message}`);
    });
  });

  return wss;
}

module.exports = createWebSocketServer;
