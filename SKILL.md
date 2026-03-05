# Skill: Deploy Alpha Bridge

## Objetivo

El agente de OpenClaw ejecuta todos estos pasos automaticamente. El agente ya conoce su propia Gateway URL y Token porque son de el.

## Lo unico que el agente necesita del usuario

- Donde deployar (Railway, Fly.io, Render, VPS, etc.)

## Pasos que ejecuta el agente

### 1. Clonar el repositorio

```bash
git clone https://github.com/sebasIeth/alpha-bridge.git
cd alpha-bridge
npm install
```

### 2. Generar API Key

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. Crear el archivo .env

El agente ya tiene su propia Gateway URL y Token. Los escribe directamente:

```bash
cp .env.example .env
```

```
PORT=3002
API_SECRET=<api key generado en paso 2>

BACKEND_WS_URL=ws://localhost:3002/agent-connect
AGENT_ID=main

OPENCLAW_GATEWAY_URL=<su propia gateway url>
OPENCLAW_AGENT_ID=main
OPENCLAW_GATEWAY_TOKEN=<su propio token>
```

### 4. Probar en local

```bash
npm start &
npm run bridge &
```

Verificar:

```bash
curl -X POST http://localhost:3002/agents/main/ping \
  -H "x-api-key: <API_SECRET>"
```

Respuesta esperada:

```json
{
  "agent_id": "main",
  "status": "success",
  "data": {
    "bridge": "online"
  }
}
```

### 5. Deployar

Segun lo que el usuario elija:

**Railway:**

```bash
railway login
railway init
railway up
```

**Fly.io:**

```bash
fly launch
fly secrets set API_SECRET=<key> BACKEND_WS_URL=wss://<app>.fly.dev/agent-connect AGENT_ID=main OPENCLAW_GATEWAY_URL=<url> OPENCLAW_AGENT_ID=main OPENCLAW_GATEWAY_TOKEN=<token>
fly deploy
```

En produccion `BACKEND_WS_URL` debe usar `wss://` con la URL publica del deploy.

### 6. Verificar el deploy

```bash
curl https://<url-del-deploy>/health
```

```json
{
  "status": "ok",
  "agents_online": 1
}
```

### 7. Registrar en AlphArena

El agente registra automaticamente en AlphArena:

- **Bridge URL**: la URL publica del deploy
- **API Key**: el API_SECRET generado en paso 2

El agente tiene ambos valores. Los manda directo a AlphArena. El usuario no hace nada.

## Troubleshooting

### agents_online es 0

- `BACKEND_WS_URL` no apunta a la URL correcta del deploy
- El bridge client no esta corriendo
- Revisar logs

### Error 401

`x-api-key` no coincide con `API_SECRET`.

### Timeout en agent_chat

- Token invalido
- Gateway URL incorrecto
- Probar con comando `wake` primero

### Bridge se desconecta

Revisar logs. Si dice "Registration timeout", verificar `AGENT_ID`.
