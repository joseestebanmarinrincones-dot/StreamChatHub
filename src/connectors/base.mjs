import { PLATFORM_INFO } from "../util.mjs";

export class BaseConnector {
  constructor(platform, channel, hub, options = {}) {
    this.platform = platform;
    this.channel = channel;
    this.hub = hub;
    this.options = options;
    this.running = false;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.lastError = "";
    this.state = "idle";
  }

  get label() {
    return PLATFORM_INFO[this.platform]?.label ?? this.platform;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    this.clearReconnect();
    this.close();
    this.state = "idle";
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  setStatus(state, message, extra = {}) {
    this.state = state;
    this.hub.updateStatus(this.platform, {
      channel: this.channel,
      state,
      message,
      ...extra,
    });
  }

  publish(message) {
    this.hub.addMessage({
      platform: this.platform,
      ...message,
    });
  }

  scheduleReconnect(message, delayMs = null) {
    if (!this.running) return;
    this.clearReconnect();
    this.attempts += 1;
    const delay = delayMs ?? Math.min(60_000, 3_000 * 2 ** Math.min(this.attempts - 1, 4));
    const seconds = Math.max(1, Math.round(delay / 1000));
    this.setStatus("reconnecting", message ?? `Reconectando en ${seconds} s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.connect();
    }, delay);
  }

  scheduleRetry(delayMs, state, message) {
    if (!this.running) return;
    this.clearReconnect();
    this.setStatus(state, message);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.connect();
    }, delayMs);
  }

  connect() {
    this.setStatus("error", "Conector no implementado.");
  }

  close() {
    // Los conectores sobrescriben este método.
  }
}
