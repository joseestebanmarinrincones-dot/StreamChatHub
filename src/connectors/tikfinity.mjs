import WebSocket from "ws";
import { BaseConnector } from "./base.mjs";
import { cleanText, colorFor, formatError } from "../util.mjs";

export class TikFinityConnector extends BaseConnector {
  constructor(channel, hub, options = {}) {
    super("tiktok", channel || "TikFinity", hub, options);
    this.url = options.tikfinity?.url || "ws://localhost:21213/";
    this.events = {
      joins: true,
      gifts: true,
      shares: true,
      follows: true,
      subscribes: true,
      likes: false,
      ...(options.tiktok?.events ?? {}),
    };
    this.streamer = String(options.streamer || "").toLowerCase();
    this.ws = null;
    this.seen = new Set();
    this.seenQueue = [];
  }

  connect() {
    this.clearReconnect();
    this.setStatus("connecting", `Conectando con TikFinity (${this.url})...`, { live: false });
    let ws;
    try {
      ws = new WebSocket(this.url, {
        handshakeTimeout: 7000,
        headers: { "User-Agent": "StreamChatHub/1.0" },
      });
    } catch (error) {
      this.scheduleReconnect(
        `TikFinity: ${formatError(error)}. Comprueba la URL en Ajustes → TikTok.`,
        10000,
      );
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.setStatus("connected", "TikFinity conectado", { live: false });
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      this.handleMessage(raw);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.running) return;
      this.scheduleReconnect(
        "TikFinity se desconectó. Abre TikFinity Desktop y deja su Event API activa. Reintentando en 8 s...",
        8000,
      );
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.lastError = formatError(error);
      this.setStatus(
        "error",
        `TikFinity: ${this.lastError}. Asegúrate de que TikFinity Desktop está abierto y su API local activa en ${this.url}.`,
      );
    });
  }

  handleMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!envelope || typeof envelope !== "object") return;
    const event = String(envelope.event || "").toLowerCase();
    const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
    if (!event) return;
    if (this.seenKey(event, data)) return;

    if (
      ["chat", "member", "join", "gift", "share", "follow", "subscribe", "like", "roomuser"].includes(event)
    ) {
      this.markLive(event === "roomuser" ? Number(data.viewerCount) : null);
    }

    switch (event) {
      case "chat":
        this.handleChat(data);
        break;
      case "member":
      case "join":
        if (this.events.joins) {
          const user = this.user(data);
          this.notify("join", `${user.name} se unió al directo`, data, user);
        }
        break;
      case "gift":
        if (this.events.gifts) this.handleGift(data);
        break;
      case "share":
        if (this.events.shares) {
          const user = this.user(data);
          this.notify("share", `${user.name} compartió el directo`, data, user);
        }
        break;
      case "follow":
        if (this.events.follows) {
          const user = this.user(data);
          this.notify("follow", `${user.name} empezó a seguirte`, data, user);
        }
        break;
      case "subscribe":
        if (this.events.subscribes) {
          const user = this.user(data);
          this.notify("subscribe", `${user.name} se suscribió`, data, user);
        }
        break;
      case "like":
        if (this.events.likes) {
          const user = this.user(data);
          const count = Number(data.likeCount) || 1;
          this.notify(
            "like",
            `${user.name} envió ${count} me gusta${count === 1 ? "" : "s"}`,
            data,
            user,
            { count },
          );
        }
        break;
      case "roomuser":
        this.handleRoomUser(data);
        break;
      default:
        break;
    }
  }

  markLive(viewers = null) {
    if (this.state !== "connected") return;
    const extra = { live: true };
    if (Number.isFinite(viewers) && viewers >= 0) extra.viewers = viewers;
    this.setStatus("connected", "TikFinity conectado", extra);
  }

  handleChat(data) {
    const text = cleanText(data.comment, 1000);
    if (!text) return;
    const user = this.user(data);
    const badges = [];
    if (data.isModerator) badges.push("moderator");
    if (data.isSubscriber) badges.push("subscriber");
    if (this.streamer && user.login === this.streamer) badges.push("broadcaster");
    const timestamp = this.timestamp(data);

    this.publish({
      id: data.msgId || undefined,
      user: user.login,
      name: user.name,
      color: colorFor(user.login, "tiktok"),
      parts: [{ type: "text", text }],
      text,
      badges,
      timestamp,
    });
  }

  handleGift(data) {
    if (Number(data.giftType) === 1 && !data.repeatEnd) return;
    const user = this.user(data);
    const gift = cleanText(data.giftName || "un regalo", 100);
    const count = Math.max(1, Number(data.repeatCount) || 1);
    const diamonds = (Number(data.diamondCount) || 0) * count;
    const suffix = count > 1 ? ` x${count}` : "";
    this.notify("gift", `${user.name} envió ${gift}${suffix}`, data, user, {
      gift,
      count: count > 1 ? count : undefined,
      diamonds: diamonds > 0 ? diamonds : undefined,
    });
  }

  handleRoomUser(data) {
    const viewers = Number(data.viewerCount);
    if (Number.isFinite(viewers) && viewers >= 0 && this.state === "connected") {
      this.setStatus("connected", "TikFinity conectado", { live: true, viewers });
    }
  }

  user(data) {
    const login = String(
      data.uniqueId || data.userId || data.nickname || "tiktok",
    ).toLowerCase();
    const name = cleanText(data.nickname || data.uniqueId || "TikTok", 120) || "TikTok";
    return { login, name };
  }

  timestamp(data) {
    const value = Number(data.createTime || data.timestamp);
    if (!Number.isFinite(value) || value <= 1_000_000_000) return Date.now();
    return value * (value < 10_000_000_000 ? 1000 : 1);
  }

  notify(type, text, data, user, extra = {}) {
    this.hub.addNotification({
      platform: "tiktok",
      type,
      user: user.login,
      name: user.name,
      text,
      ...extra,
    });
  }

  seenKey(event, data) {
    const id = data.msgId || data.id || data.messageId;
    if (!id) return false;
    const key = `${event}:${id}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.seenQueue.push(key);
    while (this.seenQueue.length > 1000) {
      this.seen.delete(this.seenQueue.shift());
    }
    return false;
  }

  close() {
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
