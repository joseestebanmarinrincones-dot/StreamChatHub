import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { TwitchConnector } from "./connectors/twitch.mjs";
import { KickConnector } from "./connectors/kick.mjs";
import { YouTubeConnector } from "./connectors/youtube.mjs";
import { TikTokConnector } from "./connectors/tiktok.mjs";
import { TikFinityConnector } from "./connectors/tikfinity.mjs";
import { effectiveTikTokKey } from "./config.mjs";
import {
  cleanText,
  colorFor,
  PLATFORMS,
  validHexColor,
} from "./util.mjs";

const MAX_HISTORY = 300;
const MAX_SEEN_IDS = 2000;

function normalizeParts(parts, fallbackText) {
  const source = Array.isArray(parts) && parts.length
    ? parts
    : [{ type: "text", text: fallbackText ?? "" }];
  const output = [];
  for (const part of source) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      const text = cleanText(part.text, 2000);
      if (text) output.push({ type: "text", text });
      continue;
    }
    if (part.type === "emote") {
      let url = "";
      try {
        const parsed = new URL(String(part.url));
        if (parsed.protocol === "https:") url = parsed.toString();
      } catch {
        // URL no válida
      }
      if (!url) continue;
      output.push({ type: "emote", url, alt: cleanText(part.alt, 60) || "emote" });
    }
  }
  // Une textos consecutivos para que el render sea más limpio.
  const merged = [];
  for (const part of output) {
    const previous = merged[merged.length - 1];
    if (part.type === "text" && previous?.type === "text") {
      previous.text = `${previous.text} ${part.text}`.trim();
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function textFromParts(parts) {
  return cleanText(
    parts
      .map((part) => (part.type === "text" ? part.text : ` ${part.alt} `))
      .join("")
      .replace(/\s{2,}/g, " "),
    3000,
  );
}

function truncateParts(parts, maxLength) {
  let used = 0;
  const output = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (used >= maxLength) break;
      const room = maxLength - used;
      if (part.text.length <= room) {
        output.push(part);
        used += part.text.length;
      } else {
        output.push({ type: "text", text: part.text.slice(0, Math.max(1, room - 1)).trimEnd() + "…" });
        used = maxLength;
        break;
      }
    } else {
      if (used + 1 > maxLength) break;
      output.push(part);
      used += 1;
    }
  }
  while (output.length && output[output.length - 1].type === "text" && !output[output.length - 1].text.trim()) {
    output.pop();
  }
  return output;
}

function normalizeBadges(badges) {
  if (!Array.isArray(badges)) return [];
  return [...new Set(badges.map((badge) => cleanText(badge, 30).toLowerCase()).filter(Boolean))].slice(0, 8);
}

export class ChatHub extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.settings = store.settings;
    this.port = options.port ?? 3000;
    this.connectors = new Map();
    this.messages = [];
    this.seenIds = new Set();
    this.seenQueue = [];
    this.startedAt = Date.now();
    this.counts = Object.fromEntries(PLATFORMS.map((platform) => [platform, 0]));
    this.total = 0;
    this.uniqueUsers = new Set();
    this.recentTimestamps = [];
    this.lastMessageAt = 0;
    this.statuses = Object.fromEntries(
      PLATFORMS.map((platform) => [
        platform,
        {
          platform,
          channel: this.settings.channels[platform],
          state: "idle",
          message: "Sin iniciar",
          live: false,
          updatedAt: Date.now(),
        },
      ]),
    );
  }

  start() {
    this.restartAll();
  }

  restartAll() {
    for (const platform of PLATFORMS) this._stopConnector(platform);
    for (const platform of PLATFORMS) this._startConnector(platform);
  }

  restartPlatform(platform) {
    if (!PLATFORMS.includes(platform)) return;
    this._stopConnector(platform);
    this._startConnector(platform);
  }

  rememberKickIds(channelId, chatroomId) {
    if (!channelId || !chatroomId) return;
    const current = this.settings.kick;
    if (Number(current.channelId) === Number(channelId) && Number(current.chatroomId) === Number(chatroomId)) {
      return;
    }
    try {
      const saved = this.store.update({ kick: { channelId, chatroomId } });
      this.settings = saved;
      this.emit("settings", saved);
    } catch (error) {
      console.warn("[Kick] No se pudieron guardar los IDs del canal:", error.message);
    }
  }

  applySettings(settings, { restart = true } = {}) {
    this.settings = settings;
    for (const platform of PLATFORMS) {
      this.statuses[platform].channel = settings.channels[platform];
    }
    if (restart) {
      this.restartAll();
    } else {
      this.emit("settings", settings);
    }
  }

  _startConnector(platform) {
    const usingTikFinity =
      platform === "tiktok" && this.settings.tiktok.source === "tikfinity";
    const channel = usingTikFinity ? "TikFinity" : this.settings.channels[platform];
    if (!channel) {
      this.updateStatus(platform, {
        channel: "",
        state: "disabled",
        message: "Sin canal configurado",
        live: false,
        title: "",
        viewers: 0,
      });
      return;
    }

    let connector;
    if (platform === "twitch") connector = new TwitchConnector(channel, this);
    if (platform === "kick") connector = new KickConnector(channel, this, { kick: this.settings.kick });
    if (platform === "youtube") connector = new YouTubeConnector(channel, this);
    if (platform === "tiktok") {
      if (usingTikFinity) {
        connector = new TikFinityConnector(channel, this, {
          tiktok: { events: this.settings.tiktok.events },
          tikfinity: this.settings.tikfinity,
          streamer: this.settings.channels.tiktok,
        });
      } else {
        connector = new TikTokConnector(channel, this, {
          tiktok: {
            signApiKey: effectiveTikTokKey(this.settings),
            events: this.settings.tiktok.events,
          },
        });
      }
    }
    if (!connector) return;

    this.connectors.set(platform, connector);
    this.updateStatus(platform, {
      channel,
      state: "connecting",
      message: "Iniciando conexión...",
      live: false,
      title: "",
      viewers: 0,
    });
    try {
      connector.start();
    } catch (error) {
      this.updateStatus(platform, {
        state: "error",
        message: cleanText(error?.message || "No se pudo iniciar el conector.", 500),
      });
    }
  }

  _stopConnector(platform) {
    const connector = this.connectors.get(platform);
    if (!connector) return;
    try {
      connector.stop();
    } catch {
      // ignorar
    }
    this.connectors.delete(platform);
  }

  updateStatus(platform, patch) {
    const previous = this.statuses[platform];
    if (!previous) return;
    const next = {
      ...previous,
      ...patch,
      platform,
      channel: patch.channel ?? previous.channel,
      updatedAt: Date.now(),
    };
    next.live = Boolean(next.live);
    next.message = cleanText(next.message, 600);
    next.title = cleanText(next.title, 200);
    const changed =
      !previous ||
      previous.state !== next.state ||
      previous.message !== next.message ||
      previous.channel !== next.channel ||
      previous.live !== next.live ||
      previous.title !== next.title ||
      previous.viewers !== next.viewers;
    this.statuses[platform] = next;
    if (changed) this.emit("status", next);
  }

  addMessage(partial) {
    if (!partial) return null;
    const isHost = partial.host === true || partial.platform === "local";
    if (!PLATFORMS.includes(partial.platform) && !isHost) return null;
    const platform = isHost ? "local" : partial.platform;
    const isTest = Boolean(partial.test);
    const name = cleanText(partial.name || partial.user || platform, 120) || platform;
    const user = cleanText(partial.user || name, 120).toLowerCase();

    if (!isTest && !isHost) {
      if (this.settings.filters.ignoreCommands && /^!/.test(cleanText(partial.text, 2000))) {
        return null;
      }
      const blocked = this.settings.filters.blockedUsers;
      const normalizedName = name.toLowerCase().replace(/^@/, "");
      if (
        blocked.includes(user) ||
        blocked.includes(name.toLowerCase()) ||
        blocked.includes(normalizedName)
      ) {
        return null;
      }
    }

    const parts = truncateParts(
      normalizeParts(partial.parts, partial.text),
      this.settings.filters.maxMessageLength,
    );
    if (!parts.length) return null;
    const text = textFromParts(parts).slice(0, this.settings.filters.maxMessageLength);
    if (!text) return null;

    const rawId = partial.id ? cleanText(partial.id, 200) : "";
    const id = rawId ? `${platform}:${rawId}` : crypto.randomUUID();
    if (rawId && this.seenIds.has(id)) return null;

    let timestamp = partial.timestamp;
    if (timestamp instanceof Date) timestamp = timestamp.getTime();
    else if (typeof timestamp === "string") timestamp = Date.parse(timestamp);
    if (!Number.isFinite(timestamp)) timestamp = Date.now();
    timestamp = Math.min(Math.max(timestamp, 1), Date.now() + 60_000);

    const meta = {};
    if (partial.meta?.superchat?.amount) {
      meta.superchat = {
        amount: cleanText(partial.meta.superchat.amount, 40),
        color: validHexColor(partial.meta.superchat.color)
          ? partial.meta.superchat.color
          : "#ffd43b",
      };
    }
    if (partial.meta?.messageRef) meta.messageRef = cleanText(partial.meta.messageRef, 100);

    const message = {
      id,
      platform,
      user,
      name,
      color: colorFor(user, platform, partial.color),
      parts,
      text,
      badges: normalizeBadges(partial.badges),
      action: Boolean(partial.action),
      timestamp,
      meta: Object.keys(meta).length ? meta : undefined,
      test: isTest || undefined,
      host: isHost || undefined,
    };

    if (rawId) {
      this.seenIds.add(id);
      this.seenQueue.push(id);
      while (this.seenQueue.length > MAX_SEEN_IDS) {
        this.seenIds.delete(this.seenQueue.shift());
      }
    }

    this.messages.push(message);
    if (this.messages.length > MAX_HISTORY) this.messages.shift();

    if (!isTest && !isHost) {
      this.total += 1;
      this.counts[platform] += 1;
      this.uniqueUsers.add(`${platform}:${user}`);
      this.lastMessageAt = timestamp;
      this.recentTimestamps.push(Date.now());
      while (this.recentTimestamps.length && this.recentTimestamps[0] < Date.now() - 60_000) {
        this.recentTimestamps.shift();
      }
    }

    this.emit("message", message);
    return message;
  }

  testMessages() {
    const samples = [
      ["twitch", "LunaStream", "#9146ff", "¡Hola! Este es un mensaje de prueba de Twitch."],
      ["kick", "PixelKev", "#53fc18", "Kick también está conectado al chat unificado."],
      ["youtube", "Andrés Live", "#ff0033", "Mensaje de prueba de YouTube. Todo se ve en la misma ventana."],
      ["tiktok", "sofi.live", "#25f4ee", "Y este es TikTok. ¡Listo para tu directo!"],
    ];
    for (const [platform, name, color, text] of samples) {
      this.addMessage({
        platform,
        user: name,
        name,
        color,
        parts: [{ type: "text", text }],
        text,
        badges: platform === "twitch" ? ["moderator"] : [],
        test: true,
      });
    }
  }

  addHostMessage(rawText) {
    const text = cleanText(rawText, this.settings.filters.maxMessageLength);
    if (!text) return null;
    return this.addMessage({
      platform: "local",
      host: true,
      user: "host",
      name: "Anfitrión",
      color: "#c4b5fd",
      parts: [{ type: "text", text }],
      text,
      badges: ["broadcaster"],
      timestamp: Date.now(),
    });
  }

  addNotification(payload) {
    if (!payload || payload.platform !== "tiktok") return null;
    const type = cleanText(payload.type, 30);
    if (!["join", "gift", "share", "follow", "like", "subscribe"].includes(type)) return null;
    const name = cleanText(payload.name || payload.user || "TikTok", 120);
    const notification = {
      id: crypto.randomUUID(),
      platform: "tiktok",
      type,
      user: cleanText(payload.user, 120),
      name,
      text: cleanText(payload.text || `${name}`, 300),
      gift: cleanText(payload.gift, 100) || undefined,
      count: Number(payload.count) || undefined,
      diamonds: Number(payload.diamonds) || undefined,
      timestamp: Date.now(),
    };
    this.emit("notification", notification);
    return notification;
  }

  testNotifications() {
    const samples = [
      { type: "join", user: "luna", name: "Luna", text: "Luna se unió al directo" },
      {
        type: "gift",
        user: "pixel",
        name: "Pixel",
        gift: "Rosa",
        count: 5,
        diamonds: 25,
        text: "Pixel envió Rosa x5",
      },
      { type: "share", user: "andres", name: "Andrés", text: "Andrés compartió el directo" },
      { type: "follow", user: "sofi", name: "Sofi", text: "Sofi empezó a seguirte" },
      { type: "subscribe", user: "ana", name: "Ana", text: "Ana se suscribió" },
    ];
    for (const sample of samples) {
      setTimeout(() => {
        this.addNotification({ platform: "tiktok", ...sample });
      }, 150);
    }
  }

  clear() {
    this.messages = [];
    this.emit("cleared");
  }

  getStats() {
    const now = Date.now();
    this.recentTimestamps = this.recentTimestamps.filter((time) => time >= now - 60_000);
    return {
      total: this.total,
      perPlatform: { ...this.counts },
      uniqueChatters: this.uniqueUsers.size,
      lastMessageAt: this.lastMessageAt,
      startedAt: this.startedAt,
      messagesPerMinute: this.recentTimestamps.length,
    };
  }

  getSnapshot() {
    return {
      messages: [...this.messages],
      statuses: structuredClone(this.statuses),
      stats: this.getStats(),
    };
  }

  destroy() {
    for (const platform of PLATFORMS) this._stopConnector(platform);
  }
}
