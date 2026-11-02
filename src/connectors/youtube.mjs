import { LiveChat } from "youtube-chat";
import { BaseConnector } from "./base.mjs";
import {
  cleanText,
  colorFor,
  fetchText,
  formatError,
  validHexColor,
} from "../util.mjs";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractVideoId(input) {
  const value = input.trim();
  if (VIDEO_ID_RE.test(value) && !value.startsWith("UC")) return value;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function pageTitle(html) {
  const meta =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ||
    html.match(/<meta\s+name="title"\s+content="([^"]*)"/i);
  if (meta) return decodeEntities(meta[1]);
  const title = html.match(/<title>([^<]*)<\/title>/i);
  return title ? decodeEntities(title[1]).replace(/\s*-\s*YouTube\s*$/i, "") : "";
}

function extractChannelId(html) {
  const match =
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  return match?.[1] ?? "";
}

function extractViewerCount(html) {
  // YouTube muestra los espectadores simultáneos en originalViewCount.
  const original = html.match(/"originalViewCount"\s*:\s*"(\d+)"/);
  if (original) return Number(original[1]) || 0;
  const runs = html.match(
    /"viewCount"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"\s*\}\s*,\s*\{\s*"text"\s*:\s*"[^"]*watching[^"]*"/i,
  );
  if (runs) {
    const digits = runs[1].replace(/[^\d]/g, "");
    return Number(digits) || 0;
  }
  return 0;
}

function partsFromYouTube(item) {
  const parts = [];
  for (const part of item.message ?? []) {
    if (part?.url && (part.isCustomEmoji || !part.emojiText)) {
      let url = String(part.url);
      if (url.startsWith("https://")) {
        // YouTube entrega los emojis a 24 px; se piden a 48 px para que no se vean borrosos.
        url = url.replace(/=w\d+-h\d+/, "=w48-h48");
        parts.push({ type: "emote", url, alt: part.alt || part.emojiText || "emoji" });
        continue;
      }
    }
    const text = part?.emojiText ?? part?.text ?? part?.alt ?? "";
    if (text) parts.push({ type: "text", text });
  }
  return parts;
}

function youtubeBadges(item) {
  const badges = [];
  if (item.isOwner) badges.push("broadcaster");
  if (item.isModerator) badges.push("moderator");
  if (item.isMembership) badges.push("member");
  if (item.isVerified) badges.push("verified");
  if (item.superchat) badges.push("superchat");
  return badges;
}

export class YouTubeConnector extends BaseConnector {
  constructor(channel, hub) {
    super("youtube", channel, hub);
    this.chat = null;
    this.videoId = "";
    this.inputKind = "channel";
    this.title = "";
    this.channelId = "";
    this.initialViewers = 0;
    this.viewerTimer = null;
    this.viewerBusy = false;
  }

  connect() {
    this.clearReconnect();
    this._connect().catch((error) => {
      const message = formatError(error);
      this.lastError = message;
      this.scheduleReconnect(`YouTube: ${message} Reintentando en 30 s...`, 30000);
    });
  }

  async _connect() {
    if (!this.running) return;
    this.setStatus("connecting", `YouTube: buscando el directo de ${this.channel}...`, {
      live: false,
    });
    const resolved = await this.resolveInput();
    if (!this.running) return;
    this.inputKind = resolved.kind;
    this.videoId = resolved.videoId || "";
    this.title = resolved.title || "";
    this.channelId = resolved.channelId || this.channelId;
    this.initialViewers = resolved.viewers || 0;

    if (!resolved.videoId) {
      this.setStatus(
        "offline",
        `YouTube: ${this.channel} no está en directo. Se comprobará otra vez en 60 s.`,
        { live: false },
      );
      this.scheduleRetry(60000, "offline", `YouTube: ${this.channel} no está en directo. Se comprobará otra vez en 60 s.`);
      return;
    }

    await this.startChat(resolved.videoId);
  }

  async resolveInput() {
    const input = this.channel.trim();
    const directVideo = extractVideoId(input);

    if (directVideo) {
      let title = "";
      let viewers = 0;
      try {
        const watch = await fetchText(
          `https://www.youtube.com/watch?v=${directVideo}`,
          {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "en-US,en;q=0.9",
              Cookie: "CONSENT=YES+cb; SOCS=CAI",
            },
          },
          15000,
        );
        title = pageTitle(watch.text).slice(0, 160);
        viewers = extractViewerCount(watch.text);
      } catch {
        // El chat puede funcionar aunque no se pueda leer la portada.
      }
      return {
        kind: "video",
        videoId: directVideo,
        title,
        channelId: "",
        live: true,
        viewers,
      };
    }

    let targetUrl = "";
    if (input.startsWith("@")) {
      targetUrl = `https://www.youtube.com/${input.replace(/\/+$/, "")}/live`;
    } else if (CHANNEL_ID_RE.test(input)) {
      targetUrl = `https://www.youtube.com/channel/${input}/live`;
    } else if (/^https?:\/\//i.test(input)) {
      try {
        const url = new URL(input);
        if (url.hostname.endsWith("youtube.com") || url.hostname === "youtu.be") {
          url.hash = "";
          url.search = "";
          url.pathname = url.pathname.replace(/\/+$/, "");
          if (!/\/live$/i.test(url.pathname)) url.pathname += "/live";
          targetUrl = url.toString();
        }
      } catch {
        // se gestiona abajo
      }
    } else if (!/\s/.test(input)) {
      targetUrl = `https://www.youtube.com/@${input.replace(/^@/, "")}/live`;
    }

    if (!targetUrl) {
      throw new Error(
        "Canal de YouTube no válido. Usa @tuCanal, la URL del canal/directo o el ID del vídeo.",
      );
    }

    const page = await fetchText(
      targetUrl,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: "CONSENT=YES+cb; SOCS=CAI",
        },
      },
      15000,
    );

    const html = page.text;
    const finalUrl = page.url || targetUrl;
    const channelId = extractChannelId(html);
    const canonical = html.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/i,
    );
    let videoId = canonical?.[1] || "";
    if (!videoId && /"isLiveNow":true/.test(html)) {
      const match = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
      if (match) videoId = match[1];
    }
    if (!videoId && /[?&]v=([A-Za-z0-9_-]{11})/.test(finalUrl)) {
      videoId = finalUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/)[1];
    }

    return {
      kind: "channel",
      videoId,
      channelId,
      title: videoId ? pageTitle(html).slice(0, 160) : "",
      live: Boolean(videoId),
      viewers: videoId ? extractViewerCount(html) : 0,
    };
  }

  async startChat(videoId) {
    if (!this.running) return;
    const chat = new LiveChat({ liveId: videoId });
    this.chat = chat;
    this.setStatus("connecting", `YouTube: conectando al chat de ${this.title || videoId}...`, {
      live: true,
      title: this.title,
    });

    let started = false;
    chat.on("start", (id) => {
      if (this.chat !== chat) return;
      started = true;
      this.attempts = 0;
      this.setStatus(
        "connected",
        this.title ? `YouTube conectado: ${this.title}` : "YouTube conectado",
        {
          live: true,
          title: this.title,
          videoId: id || videoId,
          viewers: this.initialViewers || 0,
        },
      );
      this.startViewerTimer(id || videoId);
    });

    chat.on("chat", (item) => {
      if (this.chat !== chat) return;
      this.handleChatItem(item);
    });

    chat.on("error", (error) => {
      if (this.chat !== chat || !this.running) return;
      const message = formatError(error);
      this.lastError = message;
      const offline = /not live|offline|live chat.*(not|no)|chat.*not.*found|video.*not.*found/i.test(message);
      if (offline) {
        this.handleOffline(`YouTube: ${message}`);
      } else {
        this.setStatus("error", `YouTube: ${message}`);
        this.scheduleReconnect(`YouTube: ${message} Reintentando en 30 s...`, 30000);
      }
    });

    chat.on("end", (reason) => {
      if (this.chat !== chat || !this.running) return;
      const extra = reason ? ` (${cleanText(reason, 120)})` : "";
      this.handleOffline(`YouTube: el directo terminó${extra}.`);
    });

    try {
      if (!this.running || this.chat !== chat) return;
      const ok = await chat.start();
      if (!ok && this.chat === chat && this.running && !started) {
        this.handleOffline("YouTube no pudo abrir el chat del directo.");
      }
    } catch (error) {
      if (this.chat !== chat || !this.running) return;
      this.handleOffline(`YouTube: ${formatError(error)}`, true);
    }
  }

  handleOffline(message, isError = false) {
    this.stopViewerTimer();
    if (this.inputKind === "channel") {
      this.setStatus("offline", `${message} Se comprobará otra vez en 60 s.`, { live: false });
      this.scheduleRetry(
        60000,
        "offline",
        `${message} Se comprobará otra vez en 60 s.`,
      );
    } else {
      this.setStatus(isError ? "error" : "offline", `${message} Pulsa reconectar o cambia el vídeo en Ajustes.`, {
        live: false,
      });
    }
  }

  handleChatItem(item) {
    const parts = partsFromYouTube(item);
    const text = cleanText(parts.map((part) => part.text ?? part.alt ?? "").join(""), 1000);
    if (!text) return;

    const name = cleanText(item.author?.name || "youtube", 120);
    const user = item.author?.channelId || name;
    const timestamp = item.timestamp instanceof Date ? item.timestamp.getTime() : Date.now();
    const superchat = item.superchat;
    this.publish({
      user,
      name,
      color: colorFor(name, "youtube"),
      parts,
      text,
      badges: youtubeBadges(item),
      timestamp,
      meta: superchat
        ? {
            superchat: {
              amount: cleanText(superchat.amount, 40),
              color: validHexColor(superchat.color) ? superchat.color : "#ffd43b",
            },
          }
        : undefined,
    });
  }

  startViewerTimer(videoId) {
    this.stopViewerTimer();
    if (!videoId) return;
    this.viewerTimer = setInterval(() => this.refreshViewers(videoId), 60000);
    this.viewerTimer.unref?.();
  }

  stopViewerTimer() {
    if (!this.viewerTimer) return;
    clearInterval(this.viewerTimer);
    this.viewerTimer = null;
  }

  async refreshViewers(videoId) {
    if (!this.running || this.viewerBusy || this.state !== "connected") return;
    this.viewerBusy = true;
    try {
      const page = await fetchText(
        `https://www.youtube.com/watch?v=${videoId}`,
        {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            Cookie: "CONSENT=YES+cb; SOCS=CAI",
          },
        },
        15000,
      );
      if (!this.running || this.videoId !== videoId || this.state !== "connected") return;
      this.setStatus(
        "connected",
        this.title ? `YouTube conectado: ${this.title}` : "YouTube conectado",
        {
          live: true,
          title: this.title,
          videoId,
          viewers: extractViewerCount(page.text),
        },
      );
    } catch {
      // Si YouTube limita la consulta, se conserva el último número.
    } finally {
      this.viewerBusy = false;
    }
  }

  close() {
    this.stopViewerTimer();
    const chat = this.chat;
    this.chat = null;
    if (chat) {
      try {
        chat.stop();
      } catch {
        // ignorar
      }
    }
  }
}
