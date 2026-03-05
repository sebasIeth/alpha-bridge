# Skill: Deploy Alpha Bridge

## Objetivo

El agente de OpenClaw ejecuta estos pasos automaticamente para desplegar el bridge server del usuario y conectarlo con AlphArena.

## Datos que el usuario debe proporcionar

Antes de empezar, pedirle al usuario:

1. Su **OpenClaw Gateway URL** (ej: `http://187.77.47.112:64936/`)
2. Su **OpenClaw Gateway Token** (ej: `Y3BozvyHlvPlXoAEkeUYwmMhWcb0YaRy`)
3. Donde quiere deployar (Railway, Fly.io, Render, VPS, etc.)

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

Guardar el valor generado. Este sera el `API_SECRET`.

### 3. Crear el archivo .env

```bash
cp .env.example .env
```

Escribir el .env con los datos del usuario:

```
PORT=3002
API_SECRET=<el api key generado en paso 2>

BACKEND_WS_URL=ws://localhost:3002/agent-connect
AGENT_ID=main

OPENCLAW_GATEWAY_URL=<la url que dio el usuario>
OPENCLAW_AGENT_ID=main
OPENCLAW_GATEWAY_TOKEN=<el token que dio el usuario>
```

### 4. Probar en local

Arrancar server y bridge:

```bash
npm start &
npm run bridge &
```

Ejecutar ping para verificar:

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

Si falla, revisar logs y corregir antes de deployar.

### 5. Deployar

Segun lo que elija el usuario:

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

**Importante:** en produccion cambiar `BACKEND_WS_URL` a `wss://` con la URL publica del deploy.

### 6. Verificar el deploy

```bash
curl https://<url-del-deploy>/health
```

Debe responder:

```json
{
  "status": "ok",
  "agents_online": 1
}
```

Si `agents_online` es 0, el bridge client no se conecto. Revisar logs.

### 7. Registrar en AlphArena

El agente registra automaticamente los dos datos en AlphArena:

- **Bridge URL**: la URL publica del deploy (ej: `https://mi-bridge.fly.dev`)
- **API Key**: el `API_SECRET` generado en el paso 2

El usuario no necesita copiar nada manualmente. El agente lo hace.

## Troubleshooting

### agents_online es 0

- `BACKEND_WS_URL` no apunta a la URL correcta del deploy
- El bridge client no esta corriendo
- Revisar logs por errores de conexion

### Error 401

El `x-api-key` no coincide con `API_SECRET`. Verificar que sean iguales.

### Timeout en agent_chat

- `OPENCLAW_GATEWAY_TOKEN` invalido
- `OPENCLAW_GATEWAY_URL` incorrecto
- Probar con comando `wake` primero

### Bridge se desconecta

Revisar logs. Si dice "Registration timeout", verificar que `AGENT_ID` este configurado.
