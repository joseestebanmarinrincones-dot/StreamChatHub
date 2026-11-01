import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { BaseConnector } from "./base.mjs";
import {
  cleanText,
  colorFor,
  formatError,
  isOfflineError,
} from "../util.mjs";

function tiktokParts(data) {
  const comment = cleanText(data.content ?? data.comment, 1000);
  const parts = [];
  if (comment) parts.push({ type: "text", text: comment });

  if (Array.isArray(data.emotes)) {
    for (const emote of data.emotes) {
      const url =
        emote?.image?.imageUrl ||
        emote?.imageUrl ||
        emote?.emoteImageUrl ||
        emote?.url ||
        emote?.image?.urlList?.[0] ||
        "";
      if (typeof url === "string" && url.startsWith("https://")) {
        parts.push({
          type: "emote",
          url,
          alt: cleanText(emote?.emoteId || emote?.name || "emoticono", 40),
        });
      }
    }
  }

  if (!parts.length) parts.push({ type: "text", text: comment || "emoticono" });
  return parts;
}

function tiktokBadges(data) {
  const badges = [];
  const attr = data.user?.userAttr ?? {};
  if (attr.isSuperAdmin || attr.isChannelAdmin) badges.push("broadcaster");
  else if (attr.isAdmin) badges.push("moderator");
  if (data.user?.verified) badges.push("verified");
  return badges;
}

function tiktokViewers(state) {
  const candidates = [
    state?.roomInfo?.liveRoom?.user_count,
    state?.roomInfo?.room?.user_count,
    state?.roomInfo?.liveRoom?.userCount,
    state?.roomInfo?.room?.userCount,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function tiktokUser(user) {
  const login = String(user?.uniqueId || user?.displayId || user?.id || "tiktok").toLowerCase();
  const name = cleanText(
    user?.nickname || user?.displayId || user?.uniqueId || "TikTok",
    120,
  ) || "TikTok";
  return { login, name };
}

function eventTimestamp(data) {
  const value = Number(data?.common?.createTime || data?.createTime);
  if (!Number.isFinite(value) || value <= 1_000_000_000) return Date.now();
  return value * (value < 10_000_000_000 ? 1000 : 1);
}

export class TikTokConnector extends BaseConnector {
  constructor(channel, hub, options = {}) {
    super("tiktok", channel, hub, options);
    this.conn = null;
    this.signApiKey = options.tiktok?.signApiKey || "";
    this.events = {
      joins: true,
      gifts: true,
      shares: true,
      follows: true,
      likes: false,
      ...(options.tiktok?.events ?? {}),
    };
    this.connectedAt = 0;
  }

  notify(payload) {
    return this.hub.addNotification({
      platform: "tiktok",
      ...payload,
    });
  }

  isFresh(data) {
    if (!this.connectedAt) return true;
    return eventTimestamp(data) >= this.connectedAt - 30000;
  }

  connect() {
    this.clearReconnect();
    this._connect().catch((error) => {
      const message = formatError(error);
      this.lastError = message;
      if (isOfflineError(error)) {
        this.scheduleRetry(
          60000,
          "offline",
          `TikTok @${this.channel} no está en directo. Se comprobará otra vez en 60 s.`,
        );
      } else {
        this.scheduleRetry(
          30000,
          "reconnecting",
          `TikTok: ${message} Reintentando en 30 s...`,
        );
      }
    });
  }

  async _connect() {
    if (!this.running) return;
    this.setStatus("connecting", `Conectando a TikTok @${this.channel}...`, { live: false });
    const conn = new TikTokLiveConnection(this.channel, {
      signApiKey: this.signApiKey || undefined,
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: false,
    });
    this.conn = conn;

    conn.on(WebcastEvent.CHAT, (data) => {
      if (this.conn !== conn) return;
      const comment = cleanText(data.content ?? data.comment, 1000);
      if (!comment && !(Array.isArray(data.emotes) && data.emotes.length)) return;

      const user = tiktokUser(data.user);
      const timestamp = eventTimestamp(data);

      // TikTok puede reenviar mensajes antiguos al conectar; no los mostramos en el overlay.
      if (this.connectedAt && timestamp < this.connectedAt - 30000) return;

      this.publish({
        id: data.common?.msgId || data.msgId || undefined,
        user: user.login,
        name: user.name,
        color: colorFor(user.login, "tiktok"),
        parts: tiktokParts(data),
        text: comment || "emoticono",
        badges: tiktokBadges(data),
        timestamp: Math.min(timestamp, Date.now() + 60_000),
      });
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
      if (this.conn !== conn || !this.events.joins || !this.isFresh(data)) return;
      const user = tiktokUser(data.user);
      this.notify({
        type: "join",
        user: user.login,
        name: user.name,
        text: `${user.name} se unió al directo`,
      });
      const viewers = Number(data.memberCount);
      if (Number.isFinite(viewers) && viewers > 0 && this.state === "connected") {
        this.setStatus("connected", `TikTok @${this.channel} conectado`, {
          live: true,
          viewers,
        });
      }
    });

    conn.on(WebcastEvent.GIFT, (data) => {
      if (this.conn !== conn || !this.events.gifts || !this.isFresh(data)) return;
      const giftType = Number(data.giftDetails?.giftType ?? data.giftType);
      if (giftType === 1 && !data.repeatEnd) return;
      const user = tiktokUser(data.user);
      const gift = cleanText(
        data.giftDetails?.giftName || data.gift?.name || data.giftName || "un regalo",
        100,
      );
      const count = Number(data.repeatCount) || 1;
      const diamonds = Number(
        data.giftDetails?.diamondCount ??
        data.giftDetails?.diamond_count ??
        data.diamondCount ??
        data.gift?.diamond_count,
      ) || 0;
      const suffix = count > 1 ? ` x${count}` : "";
      this.notify({
        type: "gift",
        user: user.login,
        name: user.name,
        gift,
        count: count > 1 ? count : undefined,
        diamonds: diamonds > 0 ? diamonds : undefined,
        text: `${user.name} envió ${gift}${suffix}`,
      });
    });

    conn.on(WebcastEvent.SHARE, (data) => {
      if (this.conn !== conn || !this.events.shares || !this.isFresh(data)) return;
      const user = tiktokUser(data.user);
      this.notify({
        type: "share",
        user: user.login,
        name: user.name,
        text: `${user.name} compartió el directo`,
      });
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      if (this.conn !== conn || !this.events.follows || !this.isFresh(data)) return;
      const user = tiktokUser(data.user);
      this.notify({
        type: "follow",
        user: user.login,
        name: user.name,
        text: `${user.name} empezó a seguirte`,
      });
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      if (this.conn !== conn || !this.events.likes || !this.isFresh(data)) return;
      const user = tiktokUser(data.user);
      const likes = Number(data.likeCount) || 1;
      this.notify({
        type: "like",
        user: user.login,
        name: user.name,
        count: likes,
        text: `${user.name} envió ${likes} me gusta${likes === 1 ? "" : "s"}`,
      });
    });

    conn.on(WebcastEvent.ROOM_USER, (data) => {
      if (this.conn !== conn) return;
      const viewers = Number(data.viewerCount);
      if (Number.isFinite(viewers) && viewers >= 0 && this.state === "connected") {
        this.setStatus("connected", `TikTok @${this.channel} conectado`, {
          live: true,
          viewers,
        });
      }
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      if (this.conn !== conn || !this.running) return;
      this.scheduleRetry(
        60000,
        "offline",
        `TikTok @${this.channel} terminó el directo. Se comprobará otra vez en 60 s.`,
      );
    });

    conn.on("disconnected", () => {
      if (this.conn !== conn || !this.running) return;
      this.scheduleReconnect("TikTok: conexión cerrada. Reintentando en 20 s...", 20000);
    });

    conn.on("error", (error) => {
      if (this.conn !== conn) return;
      const message = formatError(error);
      this.lastError = message;
      // El error de conexión se informa desde connect(); no conviene tapar el estado.
      if (this.state === "connected") {
        this.setStatus("error", `TikTok: ${message}`);
      }
    });

    try {
      this.connectedAt = Date.now();
      const state = await conn.connect();
      if (this.conn !== conn || !this.running) return;
      this.attempts = 0;
      const viewers = tiktokViewers(state);
      const extra = {
        live: true,
        roomId: state?.roomId,
        viewers: viewers || undefined,
      };
      this.setStatus("connected", `TikTok @${this.channel} conectado`, extra);
    } catch (error) {
      if (this.conn !== conn) return;
      const message = formatError(error);
      this.lastError = message;
      try {
        await conn.disconnect();
      } catch {
        // ignorar
      }
      if (this.conn === conn) this.conn = null;

      if (isOfflineError(error)) {
        this.scheduleRetry(
          60000,
          "offline",
          `TikTok @${this.channel} no está en directo. Se comprobará otra vez en 60 s.`,
        );
        return;
      }

      if (/room id|not online|offline|user.*not found|isn't online/i.test(message)) {
        this.scheduleRetry(
          60000,
          "offline",
          `TikTok @${this.channel} no está en directo o el usuario no existe. Se comprobará otra vez en 60 s.`,
        );
        return;
      }

      const hint = /sign|signature|euler|rate limit|api key/i.test(message)
        ? " Añade una clave de Euler Stream en Ajustes → TikTok si se repite."
        : "";
      this.scheduleRetry(
        30000,
        "error",
        `TikTok: ${message}${hint} Reintentando en 30 s...`,
      );
    }
  }

  close() {
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        Promise.resolve(conn.disconnect()).catch(() => {});
      } catch {
        // ignorar
      }
    }
  }
}
