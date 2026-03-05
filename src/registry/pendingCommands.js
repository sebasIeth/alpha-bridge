/**
 * Pending Commands Registry
 *
 * Tracks commands that have been sent to bridges and are awaiting a response.
 * When the bridge sends back a { type: "result", command_id } message,
 * the corresponding Promise is resolved so the HTTP endpoint can return
 * the actual result to the caller.
 *
 * Flow:
 *   HTTP request arrives
 *     -> commandApi creates a pending entry (returns a Promise)
 *     -> command is sent via WebSocket to the bridge
 *     -> bridge executes, sends { type: "result", command_id, status, data }
 *     -> wsServer receives it, calls pendingCommands.resolve(command_id, ...)
 *     -> the Promise resolves
 *     -> commandApi sends the HTTP response with the actual result
 */

class PendingCommands {
  constructor() {
    // command_id -> { resolve, reject, timer }
    this.pending = new Map();
  }

  /**
   * Register a command and return a Promise that resolves when the bridge responds.
   * @param {string} commandId
   * @param {number} timeoutMs - Max time to wait for the bridge response
   * @returns {Promise<{ status: string, data: object }>}
   */
  wait(commandId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error(`Command ${commandId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(commandId, { resolve, reject, timer });
    });
  }

  /**
   * Called by the WebSocket server when a result message arrives from a bridge.
   * Resolves the waiting Promise so the HTTP response can be sent.
   */
  resolve(commandId, result) {
    const entry = this.pending.get(commandId);
    if (!entry) return false;

    this.pending.delete(commandId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  /**
   * Reject a pending command (e.g. if the agent disconnects mid-command).
   */
  reject(commandId, error) {
    const entry = this.pending.get(commandId);
    if (!entry) return false;

    this.pending.delete(commandId);
    clearTimeout(entry.timer);
    entry.reject(error);
    return true;
  }

  /**
   * Reject all pending commands for an agent that disconnected.
   */
  rejectAll(reason) {
    for (const [commandId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(commandId);
    }
  }

  hasPending(commandId) {
    return this.pending.has(commandId);
  }

  get size() {
    return this.pending.size;
  }
}

module.exports = PendingCommands;
