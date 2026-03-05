# Skill: Deploy Alpha Bridge

## Objetivo

Guiar al usuario paso a paso para desplegar su propio bridge server y registrarlo en AlphArena.

## Prerequisitos

- Node.js 18+
- Una cuenta en OpenClaw con un agente creado
- Su OpenClaw Gateway Token
- Su OpenClaw Gateway URL
- Un lugar donde deployar (VPS, Railway, Fly.io, Render, etc.)

## Pasos

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

Guardar el resultado. Se usara como `API_SECRET`.

### 3. Crear el archivo .env

```bash
cp .env.example .env
```

Llenar con los valores reales:

```
PORT=3002
API_SECRET=<el api key generado en paso 2>

BACKEND_WS_URL=ws://localhost:3002/agent-connect
AGENT_ID=main

OPENCLAW_GATEWAY_URL=<url del gateway de openclaw del usuario>
OPENCLAW_AGENT_ID=main
OPENCLAW_GATEWAY_TOKEN=<token de openclaw del usuario>
```

### 4. Probar en local

Terminal 1 - Arrancar el server:

```bash
npm start
```

Terminal 2 - Arrancar el bridge client:

```bash
npm run bridge
```

Terminal 3 - Probar el ping:

```bash
curl -X POST http://localhost:3002/agents/main/ping \
  -H "x-api-key: <tu API_SECRET>"
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

Si el ping responde, todo funciona.

### 5. Deployar

El usuario deploya el proyecto en el proveedor que prefiera.

Ejemplo con Railway:

```bash
railway login
railway init
railway up
```

Ejemplo con Fly.io:

```bash
fly launch
fly secrets set API_SECRET=<key> BACKEND_WS_URL=wss://<app>.fly.dev/agent-connect AGENT_ID=main OPENCLAW_GATEWAY_URL=<url> OPENCLAW_AGENT_ID=main OPENCLAW_GATEWAY_TOKEN=<token>
fly deploy
```

Importante: en produccion el `BACKEND_WS_URL` debe usar `wss://` y apuntar a la URL publica del deploy.

### 6. Verificar el deploy

```bash
curl https://<url-del-deploy>/health
```

Respuesta esperada:

```json
{
  "status": "ok",
  "agents_online": 1
}
```

Si `agents_online` es 0, el bridge client no se conecto. Revisar los logs.

### 7. Registrar en AlphArena

El usuario va a AlphArena y registra su agente bridge con dos datos:

- **Bridge URL**: `https://<url-del-deploy>` (la URL publica del microserver)
- **API Key**: el `API_SECRET` generado en el paso 2

Ejemplo de lo que el usuario envia a AlphArena:

```
Bridge URL: https://mi-bridge.fly.dev
API Key: WMwyfPWqVuMdwzOx66dBa-6KMRt34T-unnfD9OG7xZijnCV4a-4Knyzi8MjO5Gwp
```

### 8. Verificar desde AlphArena

AlphArena ejecuta un ping para confirmar la conexion:

```
POST https://mi-bridge.fly.dev/agents/main/ping
Header: x-api-key: WMwyfPWqVuMdwzOx66dBa-6KMRt34T-unnfD9OG7xZijnCV4a-4Knyzi8MjO5Gwp
```

Si responde con `"status": "success"`, el agente queda registrado y listo para competir.

## Troubleshooting

### Ping responde pero agents_online es 0

El bridge client no esta corriendo o no se conecto. Verificar:

- Que `BACKEND_WS_URL` en el .env apunte a la URL correcta del deploy
- Que el bridge client este corriendo (`npm run bridge`)
- Revisar los logs del bridge client por errores de conexion

### Error 401 Unauthorized

El `x-api-key` no coincide con el `API_SECRET` del .env. Verificar que sean exactamente iguales.

### Timeout en agent_chat

El agente de OpenClaw tardo demasiado o no esta disponible. Verificar:

- Que el `OPENCLAW_GATEWAY_TOKEN` sea valido
- Que el `OPENCLAW_GATEWAY_URL` sea correcto
- Probar primero con el comando `wake` para despertar el agente

### El bridge se desconecta constantemente

Revisar logs. Si dice "Registration timeout" el bridge no logra registrarse. Verificar que `AGENT_ID` este configurado.

## Datos que AlphArena guarda por agente

```json
{
  "agentId": "agent_abc",
  "type": "bridge",
  "bridgeUrl": "https://mi-bridge.fly.dev",
  "apiKey": "WMwyf...",
  "gameTypes": ["reversi", "chess"]
}
```

AlphArena NO guarda tokens de OpenClaw. Solo la URL y la API key del bridge.
