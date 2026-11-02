import WebSocket from "ws";
import { BaseConnector } from "./base.mjs";
import {
  cleanText,
  colorFor,
  fetchJson,
  formatError,
  validHexColor,
} from "../util.mjs";

const API_BASE = "https://web.kick.com/api/v1/realtime";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BADGES = new Set(["broadcaster", "moderator", "vip", "subscriber", "founder", "verified", "staff"]);

function apiHeaders(slug) {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    Origin: "https://kick.com",
    Referer: `https://kick.com/${slug}`,
    "x-app-platform": "web",
  };
}

function kickParts(content) {
  const parts = [];
  let cursor = 0;
  const pattern = /\[emote:(\d+):([^\]]+)\]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push({ type: "text", text: content.slice(cursor, match.index) });
    }
    parts.push({
      type: "emote",
      url: `https://files.kick.com/emotes/${match[1]}/fullsize`,
      alt: match[2],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) parts.push({ type: "text", text: content.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text: content }];
}

function kickBadges(sender) {
  const badges = [];
  const push = (name) => {
    if (BADGES.has(name) && !badges.includes(name)) badges.push(name);
  };
  const identity = sender?.identity ?? {};
  if (Array.isArray(identity.badges_v2)) {
    for (const badge of identity.badges_v2) {
      if (typeof badge === "string") push(badge);
      else if (badge?.name) push(badge.name);
    }
  }
  if (Array.isArray(identity.badges)) {
    for (const badge of identity.badges) {
      if (typeof badge === "string") push(badge);
      else if (badge?.type) push(badge.type);
    }
  }
  return badges;
}

export class KickConnector extends BaseConnector {
  constructor(channel, hub, options = {}) {
    super("kick", channel, hub, options);
    this.ws = null;
    this.watchdog = null;
    this.lastFrameAt = 0;
    this.channelId = Number(options.kick?.channelId) || 0;
    this.chatroomId = Number(options.kick?.chatroomId) || 0;
    this.clientId = crypto.randomUUID();
    this.serverConnected = false;
    this.meta = {};
    this.viewerTimer = null;
    this.viewerBusy = false;
  }

  connect() {
    this.clearReconnect();
    this.stopViewerTimer();
    this._connect().catch((error) => {
      const message = formatError(error);
      this.lastError = message;
      this.close();
      const delay = Math.min(60000, 15000 * 2 ** Math.min(this.attempts, 2));
      this.scheduleReconnect(
        `Kick: ${message} Reintentando en ${Math.round(delay / 1000)} s...`,
        delay,
      );
    });
  }

  async _connect() {
    if (!this.running) return;
    this.setStatus("connecting", `Buscando el canal de Kick ${this.channel}...`, { live: false });
    await this.resolveChannel();
    if (!this.running) return;

    const headers = apiHeaders(this.channel);
    const connection = await fetchJson(
      `${API_BASE}/channels/${this.channelId}/chat/connection`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { id: this.clientId, type: "web" },
          capabilities: {
            accepted_providers: [{ provider: "pusher" }, { provider: "centrifugo" }],
          },
        }),
      },
      15000,
    );
    if (!this.running) return;

    const provider = connection?.data?.connections?.[0]?.provider;
    const wsUrl = connection?.data?.connections?.[0]?.credentials?.url;
    if (!wsUrl) throw new Error("Kick no devolvió la URL del chat.");
    if (provider && provider !== "centrifugo") {
      throw new Error(`Kick devolvió un proveedor no soportado (${provider}).`);
    }

    this.setStatus("connecting", "Kick: obteniendo acceso al chat...");
    const auth = await fetchJson(
      `${API_BASE}/auth/connection`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId }),
      },
      15000,
    );
    if (!this.running) return;
    const token = auth?.data?.token;
    if (!token) throw new Error("Kick no devolvió el token del chat.");

    await this.openSocket(wsUrl, token, headers);
  }

  async resolveChannel() {
    const manualChannel = Number(this.options.kick?.channelId) || 0;
    const manualChatroom = Number(this.options.kick?.chatroomId) || 0;

    let channel;
    try {
      channel = await fetchJson(
        `https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}`,
        { headers: apiHeaders(this.channel) },
        15000,
      );
    } catch (error) {
      const message = formatError(error);
      if (manualChannel > 0 && manualChatroom > 0) {
        // Si Cloudflare bloquea la consulta, se usan los IDs guardados.
        this.channelId = manualChannel;
        this.chatroomId = manualChatroom;
        this.meta = { ...this.meta, manualIds: true };
        return;
      }
      if (/403|bloque|forbidden/i.test(message)) {
        throw new Error(
          "Kick bloqueó la consulta del canal. Abre kick.com, copia los IDs y ponlos en Ajustes → Kick (avanzado).",
        );
      }
      throw new Error(`No se pudo encontrar el canal de Kick (${message}).`);
    }

    const id = Number(channel?.id);
    const chatroom = Number(channel?.chatroom?.id);
    if (!id || !chatroom) throw new Error("Kick no devolvió un canal válido.");

    this.channelId = id;
    this.chatroomId = chatroom;
    const live = channel?.livestream;
    this.meta = {
      live: Boolean(live?.is_live),
      title: live?.session_title || "",
      viewers: Number(live?.viewer_count) || 0,
      manualIds: false,
    };
    // Corrige automáticamente IDs antiguos si el canal cambió de nombre.
    if (id !== manualChannel || chatroom !== manualChatroom) {
      this.hub.rememberKickIds?.(id, chatroom);
    }
  }

  async openSocket(url, token, headers) {
    if (!this.running) return;
    this.serverConnected = false;
    const ws = new WebSocket(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Origin: "https://kick.com",
      },
      handshakeTimeout: 15000,
    });
    this.ws = ws;
    this.lastFrameAt = Date.now();

    const connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Kick no respondió al conectar con el chat."));
      }, 20000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.setStatus("connecting", "Kick: conectado al servidor, suscribiendo al chat...");
      this.send({
        connect: { token, name: "streamchat-hub" },
        id: 1,
      });
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      const text = raw.toString("utf8");
      if (text.trim() === "{}") {
        this.sendRaw("{}");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.serverConnected = false;
      this.stopWatchdog();
      if (!this.running) return;
      this.scheduleReconnect("Kick: conexión cerrada. Reintentando...");
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.lastError = formatError(error);
      this.setStatus("error", `Kick: ${this.lastError}`);
    });

    await connectPromise;
    if (!this.running || this.ws !== ws) return;
    this.startWatchdog();
  }

  handleFrame(frame) {
    if (frame?.error) {
      const message = frame.error?.message || frame.error?.code || JSON.stringify(frame.error);
      this.setStatus("error", `Kick: ${message}`);
      try {
        this.ws?.close();
      } catch {
        // ignorar
      }
      return;
    }

    if (frame?.connect) {
      this.serverConnected = true;
      this.send({
        subscribe: { channel: `chatrooms.${this.chatroomId}.v2`, flag: 1 },
        id: 2,
      });
      return;
    }

    if (frame?.subscribe) {
      this.attempts = 0;
      const extra = {
        live: this.meta.live === true,
        title: this.meta.title || "",
        viewers: this.meta.viewers || 0,
      };
      const suffix = this.meta.live === false ? " (canal sin directo)" : "";
      this.setStatus("connected", `Kick #${this.channel} conectado${suffix}`, extra);
      this.startViewerTimer();
      return;
    }

    if (frame?.disconnect) {
      const reason = frame.disconnect?.reason || "desconectado por el servidor";
      this.setStatus("reconnecting", `Kick: ${reason}. Reconectando...`);
      try {
        this.ws?.close();
      } catch {
        // ignorar
      }
      return;
    }

    if (frame?.push) this.handlePush(frame.push);
  }

  handlePush(push) {
    if (!push?.pub?.data) return;
    let payload = push.pub.data;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== "object") return;

    const event = String(payload.event ?? "");
    if (!event.endsWith("ChatMessageEvent")) return;

    let message = payload.data;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!message || typeof message !== "object") return;

    const content = cleanText(message.content, 1000);
    if (!content) return;

    const sender = message.sender ?? {};
    const login = String(sender.username || sender.slug || "kick").toLowerCase();
    const name = sender.username || sender.slug || "Kick";
    const rawColor = sender.identity?.color;
    const color = validHexColor(rawColor) ? rawColor : colorFor(login, "kick");
    const timestamp = Date.parse(message.created_at);

    this.publish({
      id: message.id || message.metadata?.message_ref || undefined,
      user: login,
      name,
      color,
      parts: kickParts(content),
      text: content,
      badges: kickBadges(sender),
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      meta: {
        messageRef: message.metadata?.message_ref,
      },
    });
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.running || !this.ws) return;
      if (Date.now() - this.lastFrameAt > 75_000) {
        this.setStatus("reconnecting", "Kick: el chat dejó de responder. Reconectando...");
        try {
          this.ws.close();
        } catch {
          // ignorar
        }
      }
    }, 20000);
    this.watchdog.unref?.();
  }

  stopWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  send(frame) {
    this.sendRaw(JSON.stringify(frame));
  }

  sendRaw(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(text);
    } catch {
      // el cierre se gestiona en el evento close
    }
  }

  startViewerTimer() {
    this.stopViewerTimer();
    this.viewerTimer = setInterval(() => this.refreshViewers(), 60000);
    this.viewerTimer.unref?.();
  }

  stopViewerTimer() {
    if (!this.viewerTimer) return;
    clearInterval(this.viewerTimer);
    this.viewerTimer = null;
  }

  async refreshViewers() {
    if (!this.running || this.viewerBusy) return;
    this.viewerBusy = true;
    try {
      await this.resolveChannel();
      if (!this.running) return;
      const extra = {
        live: this.meta.live === true,
        title: this.meta.title || "",
        viewers: this.meta.viewers || 0,
      };
      const suffix = this.meta.live === false ? " (canal sin directo)" : "";
      this.setStatus("connected", `Kick #${this.channel} conectado${suffix}`, extra);
    } catch {
      // Se conserva el último número conocido si Kick limita la consulta.
    } finally {
      this.viewerBusy = false;
    }
  }

  close() {
    this.stopWatchdog();
    this.stopViewerTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignorar
      }
    }
  }
}
