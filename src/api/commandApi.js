/**
 * Command API
 *
 * HTTP endpoints that dispatch commands to connected bridge agents
 * and WAIT for the response. This is no longer fire-and-forget --
 * each endpoint sends the command via WebSocket and holds the HTTP
 * connection open until the bridge responds or the timeout expires.
 *
 * Full round-trip flow:
 *
 *   curl POST /agents/:id/ping
 *     -> backend sends { type: "command", command: "ping" } via WS
 *     -> bridge receives it, responds { type: "result", status: "success", data: {...} }
 *     -> WS server routes the result to pendingCommands.resolve()
 *     -> this endpoint returns the bridge's actual response as HTTP JSON
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');

function createCommandApi(registry, pendingCommands) {
  const router = Router();

  /**
   * Helper: send a command to a bridge and wait for the result.
   * Returns the bridge's { status, data } response.
   * Throws if the agent is offline, not found, or the command times out.
   */
  async function sendAndWait(agentId, command, payload = {}, timeoutMs = 30000) {
    const agent = registry.getAgent(agentId);
    if (!agent) {
      const err = new Error(`Agent "${agentId}" not found`);
      err.httpStatus = 404;
      throw err;
    }

    if (agent.status !== 'online') {
      const err = new Error(`Agent "${agentId}" is offline`);
      err.httpStatus = 503;
      throw err;
    }

    if (agent.ws.readyState !== 1) {
      const err = new Error(`Agent "${agentId}" connection is not open`);
      err.httpStatus = 503;
      throw err;
    }

    const commandId = uuidv4();

    const message = {
      type: 'command',
      command_id: commandId,
      command,
      payload,
    };

    // Register the pending command BEFORE sending, so we don't miss a fast response
    const resultPromise = pendingCommands.wait(commandId, timeoutMs);

    agent.ws.send(JSON.stringify(message));
    console.log(`[API] Command sent to ${agentId}: ${command} (${commandId})`);

    // Wait for the bridge to respond
    const result = await resultPromise;
    return { command_id: commandId, ...result };
  }

  // ---------------------------------------------------------
  // POST /agents/:agent_id/ping
  //
  // Simple test: "are you there?"
  // Sends a ping command to the bridge, waits for the response.
  // The bridge responds immediately without touching OpenClaw.
  //
  // Response example:
  // {
  //   "agent_id": "agent_123",
  //   "command_id": "uuid",
  //   "status": "success",
  //   "data": {
  //     "bridge": "online",
  //     "uptime": 42.5,
  //     "timestamp": 1709654400000
  //   }
  // }
  // ---------------------------------------------------------
  router.post('/agents/:agent_id/ping', async (req, res) => {
    try {
      const result = await sendAndWait(req.params.agent_id, 'ping', {}, 10000);
      res.json({ agent_id: req.params.agent_id, ...result });
    } catch (err) {
      const status = err.httpStatus || 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------
  // POST /agents/:agent_id/command
  //
  // Generic command endpoint. Sends any command and waits for result.
  //
  // Body:
  // {
  //   "command": "agent_chat",
  //   "payload": { "message": "Your turn in Reversi..." },
  //   "timeout": 60000
  // }
  //
  // The command is sent through the WebSocket to the bridge.
  // The bridge executes it locally using the OpenClaw Gateway Token
  // (which never reaches this server) and sends back the result.
  // ---------------------------------------------------------
  router.post('/agents/:agent_id/command', async (req, res) => {
    const { command, payload, timeout } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Missing "command" field' });
    }

    try {
      const timeoutMs = timeout || 30000;
      const result = await sendAndWait(req.params.agent_id, command, payload || {}, timeoutMs);
      res.json({ agent_id: req.params.agent_id, ...result });
    } catch (err) {
      const status = err.httpStatus || 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------
  // GET /agents/:agent_id/status
  // ---------------------------------------------------------
  router.get('/agents/:agent_id/status', (req, res) => {
    const status = registry.getStatus(req.params.agent_id);
    if (!status.exists) {
      return res.status(404).json({ error: `Agent "${req.params.agent_id}" not found` });
    }
    res.json({ agent_id: req.params.agent_id, ...status });
  });

  // ---------------------------------------------------------
  // GET /agents
  // ---------------------------------------------------------
  router.get('/agents', (_req, res) => {
    res.json({ agents: registry.getAllAgents() });
  });

  return router;
}

module.exports = createCommandApi;
