/**
 * OpenClaw WebSocket Client
 *
 * Implements the full OpenClaw gateway protocol:
 * - WebSocket connection to the OpenClaw gateway
 * - Ed25519 challenge-response authentication
 * - Request/response RPC (type: "req" / "res")
 * - Streaming events (type: "event") for agent runs
 * - agentAndWait() to send a prompt and collect the full streamed response
 *
 * SECURITY: This client runs ONLY on the user's machine.
 * The gateway token is used here for authentication with OpenClaw
 * and is NEVER transmitted to the AlphArena backend.
 * Only command results (the agent's text output) are sent back.
 */

const { randomUUID } = require('node:crypto');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

function base64url(buf) {
  return buf.toString('base64url');
}

class OpenClawWsClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = {
      reconnect: true,
      reconnectDelay: 800,
      ...options,
    };

    this.ws = null;
    // Pending RPC requests: id -> { resolve, reject, timer }
    this.pending = new Map();
    // Pending agent runs waiting for stream completion: runId -> { resolve, reject, timer, events }
    this.pendingAgentRuns = new Map();
    this.instanceId = randomUUID();
    this._state = 'disconnected';
    this.reconnectTimer = null;

    this._generateDeviceKeys();
  }

  get state() {
    return this._state;
  }

  // -- Ed25519 Key Generation --
  // Generates a temporary device key pair for signing the auth challenge.
  // These are ephemeral -- new keys each time the client is created.
  _generateDeviceKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.devicePrivateKey = privateKey;

    const spki = publicKey.export({ type: 'spki', format: 'der' });
    // The raw 32-byte public key is at the end of the SPKI DER encoding
    this.devicePublicKeyRaw = spki.subarray(spki.length - 32);

    this.deviceId = crypto.createHash('sha256')
      .update(this.devicePublicKeyRaw)
      .digest('hex');
  }

  // -- Challenge Signature --
  // Signs the nonce from the OpenClaw challenge using the format:
  // v2|deviceId|openclaw-control-ui|webchat|operator|scopes|signedAt|token|nonce
  _sign(nonce) {
    const signedAt = Date.now();
    const scopes = 'operator.admin,operator.approvals,operator.pairing';
    const message = `v2|${this.deviceId}|openclaw-control-ui|webchat|operator|${scopes}|${signedAt}|${this.options.token}|${nonce}`;
    const sig = crypto.sign(null, Buffer.from(message, 'utf8'), this.devicePrivateKey);
    return { signature: base64url(sig), signedAt };
  }

  // -- Connection --

  connect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this._setState('connecting');
    const httpUrl = this.options.url.replace(/^ws/, 'http');

    this.ws = new WebSocket(this.options.url, {
      headers: { Origin: httpUrl },
    });

    this.ws.on('open', () => {
      this._setState('authenticating');
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data.toString());
    });

    this.ws.on('close', (code) => {
      this._setState('disconnected');
      this._rejectAllPending(new Error(`WebSocket closed (code ${code})`));
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  disconnect() {
    this.options.reconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._setState('disconnected');
  }

  _setState(state) {
    this._state = state;
    this.emit('stateChange', state);
  }

  _scheduleReconnect() {
    if (!this.options.reconnect) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.options.reconnectDelay);
  }

  // -- Message Routing --

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'event') {
      this._handleEvent(msg);
    } else if (msg.type === 'res') {
      this._handleResponse(msg);
    }
  }

  _handleEvent(event) {
    // Handle the authentication challenge from OpenClaw
    if (event.event === 'connect.challenge') {
      this._sendConnect(event.payload.nonce);
    }

    // Collect streaming events for pending agent runs
    const runId = event.payload?.runId;
    if (runId) {
      const pending = this.pendingAgentRuns.get(runId);
      if (pending) {
        pending.events.push({ ...event.payload, _event: event.event });

        const stream = event.payload?.stream;
        const data = event.payload?.data;
        const phase = data?.phase;

        // Agent run failed
        if (stream === 'lifecycle' && phase === 'error') {
          this.pendingAgentRuns.delete(runId);
          clearTimeout(pending.timer);
          const errorMsg = data?.error || data?.message || 'Agent run failed';
          pending.reject(new Error(errorMsg));
          return;
        }

        // Agent run completed -- resolve with the last assistant event's text
        if (stream === 'lifecycle' && (phase === 'complete' || phase === 'end' || phase === 'done')) {
          this.pendingAgentRuns.delete(runId);
          clearTimeout(pending.timer);
          const lastAssistant = [...pending.events].reverse().find((e) => e.stream === 'assistant');
          pending.resolve(lastAssistant || data || {});
          return;
        }
      }
    }

    this.emit('event', event);
    this.emit(`event:${event.event}`, event.payload);
  }

  _handleResponse(res) {
    const pending = this.pending.get(res.id);
    if (!pending) return;
    this.pending.delete(res.id);
    clearTimeout(pending.timer);

    if (res.ok) {
      pending.resolve(res.result || res.payload || {});
    } else {
      pending.reject(new Error(`${res.error.code}: ${res.error.message}`));
    }
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    for (const [id, pending] of this.pendingAgentRuns) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingAgentRuns.delete(id);
    }
  }

  // -- Connect Handshake --
  // After OpenClaw sends the challenge nonce, we sign it with our device key
  // and send back the connect request with the signature + gateway token.

  _sendConnect(nonce) {
    const { signature, signedAt } = this._sign(nonce);

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: 'dev',
        platform: process.platform,
        mode: 'webchat',
        instanceId: this.instanceId,
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
      device: {
        id: this.deviceId,
        publicKey: base64url(this.devicePublicKeyRaw),
        signature,
        signedAt,
        nonce,
      },
      caps: [],
      auth: { token: this.options.token },
      locale: 'en',
    };

    this._send('connect', params)
      .then(() => {
        this._setState('connected');
        this.emit('connected');
      })
      .catch((err) => {
        this.emit('error', err);
        if (this.ws) this.ws.close();
      });
  }

  // -- Low-level RPC --

  _send(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const id = randomUUID();
      const req = { type: 'req', id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(req));
    });
  }

  // -- Public: Wait for Connection --

  waitForConnect(timeoutMs = 10000) {
    if (this._state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('connected', onConnect);
        reject(new Error('Connection timed out'));
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnect);
    });
  }

  // -- Public: Send agent message and wait for streamed response --

  async agent(params) {
    const full = { idempotencyKey: randomUUID(), ...params };
    return this._send('agent', full);
  }

  /**
   * Send a prompt to the OpenClaw agent and wait for the full streamed response.
   *
   * Flow:
   * 1. Send req {method: "agent", message: "..."}
   * 2. OpenClaw responds with {runId: "abc"}
   * 3. Listen for streaming events with that runId:
   *    - stream: "assistant" events carry the agent's text
   *    - stream: "lifecycle", phase: "complete" means done
   *    - stream: "lifecycle", phase: "error" means failure
   * 4. Resolves with the last assistant event (containing data.text)
   */
  async agentAndWait(params, timeoutMs = 90000) {
    const accepted = await this.agent(params);
    const runId = accepted.runId;
    if (!runId) {
      return accepted;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentRuns.delete(runId);
        reject(new Error(`Agent run ${runId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingAgentRuns.set(runId, { resolve, reject, timer, events: [] });
    });
  }

  // -- Public: Other RPC methods --

  async wake(params) {
    return this._send('wake', params);
  }

  async health() {
    return this._send('health', {});
  }

  async status() {
    return this._send('status', {});
  }
}

module.exports = OpenClawWsClient;
