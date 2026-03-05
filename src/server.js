/**
 * Bridge AlphArena - Backend Server
 *
 * This server accepts inbound WebSocket connections from bridge clients
 * running on users' machines. It provides an HTTP API to send commands
 * to connected agents and WAIT for their responses.
 *
 * The key security property: the backend NEVER connects outbound to users.
 * Users connect TO us. Their OpenClaw Gateway Token stays on their machine.
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const AgentRegistry = require('./registry/agentRegistry');
const PendingCommands = require('./registry/pendingCommands');
const createWebSocketServer = require('./websocket/wsServer');
const createCommandApi = require('./api/commandApi');
const authMiddleware = require('./middleware/auth');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const registry = new AgentRegistry();
const pendingCommands = new PendingCommands();

// Health check (public, no auth needed)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agents_online: registry.getAllAgents().filter(a => a.status === 'online').length,
    pending_commands: pendingCommands.size,
  });
});

// All /agents/* endpoints require auth - only api.alpharena.ai can call them
app.use(authMiddleware);
app.use(createCommandApi(registry, pendingCommands));

// Create HTTP server and attach WebSocket server to it
const server = http.createServer(app);
const wss = createWebSocketServer(server, registry, pendingCommands);

server.listen(PORT, () => {
  console.log(`[Server] HTTP API listening on port ${PORT}`);
  console.log(`[Server] WebSocket accepting connections at ws://localhost:${PORT}/agent-connect`);
  console.log(`[Server] In production, use wss:// with TLS termination (nginx/cloudflare)`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  pendingCommands.rejectAll('Server shutting down');
  registry.shutdown();
  wss.close();
  server.close(() => process.exit(0));
});
