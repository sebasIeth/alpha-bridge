/**
 * Agent Registry
 *
 * Maintains a map of agent_id -> websocket connection.
 * Tracks online/offline status and handles reconnections.
 *
 * Designed for future scalability:
 * - Can be backed by Redis for multi-server deployments
 * - Supports pub/sub command distribution across instances
 * - Handles thousands of concurrent agent connections
 */

class AgentRegistry {
  constructor() {
    // agent_id -> { ws, status, lastHeartbeat, connectedAt }
    this.agents = new Map();

    // How long before a missed heartbeat marks an agent offline (ms)
    this.heartbeatTimeout = 90_000; // 3x the 30s heartbeat interval

    this._startHealthCheck();
  }

  register(agentId, ws) {
    const existing = this.agents.get(agentId);
    if (existing && existing.ws.readyState === 1) {
      // Close stale connection on reconnect
      existing.ws.close(4000, 'Replaced by new connection');
    }

    this.agents.set(agentId, {
      ws,
      status: 'online',
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
    });

    console.log(`[Registry] Agent registered: ${agentId} (total: ${this.agents.size})`);
  }

  unregister(agentId) {
    if (this.agents.has(agentId)) {
      this.agents.delete(agentId);
      console.log(`[Registry] Agent unregistered: ${agentId} (total: ${this.agents.size})`);
    }
  }

  recordHeartbeat(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeat = Date.now();
      agent.status = 'online';
    }
  }

  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  isOnline(agentId) {
    const agent = this.agents.get(agentId);
    return agent !== undefined && agent.status === 'online';
  }

  getStatus(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return { exists: false };
    return {
      exists: true,
      status: agent.status,
      connectedAt: agent.connectedAt,
      lastHeartbeat: agent.lastHeartbeat,
    };
  }

  getAllAgents() {
    const result = [];
    for (const [agentId, agent] of this.agents) {
      result.push({
        agent_id: agentId,
        status: agent.status,
        connectedAt: agent.connectedAt,
        lastHeartbeat: agent.lastHeartbeat,
      });
    }
    return result;
  }

  /**
   * Periodically check for agents that missed their heartbeat window.
   * Marks them offline so the command API can report accurate status.
   */
  _startHealthCheck() {
    this._healthInterval = setInterval(() => {
      const now = Date.now();
      for (const [agentId, agent] of this.agents) {
        if (agent.status === 'online' && now - agent.lastHeartbeat > this.heartbeatTimeout) {
          agent.status = 'offline';
          console.log(`[Registry] Agent timed out (no heartbeat): ${agentId}`);
        }
      }
    }, 15_000);
  }

  shutdown() {
    clearInterval(this._healthInterval);
  }
}

module.exports = AgentRegistry;
