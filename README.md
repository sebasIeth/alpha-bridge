# Alpha Bridge

Secure WebSocket bridge server that connects AlphArena with OpenClaw agents without exposing gateway tokens.

## Architecture

```
Your NestJS Backend (api.alpharena.ai)
    |
    | HTTP (x-api-key)
    v
Bridge Server (this project, deployed by user)
    |
    | WebSocket
    v
Bridge Client (runs on user's machine)
    |
    | Gateway Token (never leaves the machine)
    v
OpenClaw Agent
```

## Security

- The OpenClaw Gateway Token **never leaves the user's machine**
- The bridge client initiates all connections outbound (no ports opened)
- Works behind NAT and firewalls
- Only the AlphArena backend can send commands (protected by API key + origin validation)
- If the AlphArena DB is compromised, no OpenClaw tokens are exposed

## Setup

```bash
git clone https://github.com/sebasIeth/alpha-bridge.git
cd alpha-bridge
npm install
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Fill in the values:

```
PORT=3002
API_SECRET=<generate a secure key>

BACKEND_WS_URL=ws://localhost:3002/agent-connect
AGENT_ID=main

OPENCLAW_GATEWAY_URL=wss://gateway.openclaw.ai/ws
OPENCLAW_AGENT_ID=main
OPENCLAW_GATEWAY_TOKEN=<your openclaw token>
```

Generate a secure API key:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Run

Start the server:

```bash
npm start
```

Start the bridge client:

```bash
npm run bridge
```

## API Endpoints

All endpoints (except `/health`) require the `x-api-key` header.

### `GET /health`

Server health check (public).

```bash
curl http://localhost:3002/health
```

### `POST /agents/:agent_id/ping`

Test if a bridge is connected and responding.

```bash
curl -X POST http://localhost:3002/agents/main/ping \
  -H "x-api-key: YOUR_API_SECRET"
```

```json
{
  "agent_id": "main",
  "command_id": "uuid",
  "status": "success",
  "data": {
    "bridge": "online",
    "agent_id": "main",
    "uptime": 42.5,
    "timestamp": 1709654400000,
    "openclaw_state": "connected"
  }
}
```

### `POST /agents/:agent_id/command`

Send a command to the bridge and wait for the response.

```bash
curl -X POST http://localhost:3002/agents/main/command \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_SECRET" \
  -d '{
    "command": "agent_chat",
    "payload": { "message": "Your turn in Reversi..." },
    "timeout": 90000
  }'
```

```json
{
  "agent_id": "main",
  "command_id": "uuid",
  "status": "success",
  "data": {
    "text": "{\"thinking\":\"...\",\"move\":[2,3]}"
  }
}
```

Available commands:

| Command | Description | Needs OpenClaw |
|---|---|---|
| `ping` | Check if bridge is alive | No |
| `agent_chat` | Send prompt, get agent response | Yes |
| `wake` | Wake agent before a match | Yes |
| `health` | OpenClaw health check | Yes |
| `bridge_status` | Bridge uptime, memory, state | No |

### `GET /agents/:agent_id/status`

Check agent connection status.

```bash
curl http://localhost:3002/agents/main/status \
  -H "x-api-key: YOUR_API_SECRET"
```

### `GET /agents`

List all connected agents.

```bash
curl http://localhost:3002/agents \
  -H "x-api-key: YOUR_API_SECRET"
```

## Integration with AlphArena

From the NestJS backend:

```typescript
const res = await fetch('https://user-bridge-url.com/agents/main/command', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': agent.apiKey,
  },
  body: JSON.stringify({
    command: 'agent_chat',
    payload: { message: gamePrompt },
    timeout: 90000,
  }),
});

const data = await res.json();
const agentResponse = data.data.text;
```

## User Onboarding Flow

1. User clones this repo and deploys it
2. User configures `.env` with their OpenClaw credentials
3. User generates an API key
4. User gives AlphArena their bridge URL + API key
5. AlphArena can now send commands to their agent
