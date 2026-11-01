import WebSocket from "ws";
import { BaseConnector } from "./base.mjs";
import {
  cleanText,
  colorFor,
  fetchJson,
  formatError,
} from "../util.mjs";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const USER_AGENT = "StreamChatHub/1.0 (overlay local de solo lectura)";
const TWITCH_GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const BADGE_NAMES = new Set([
  "broadcaster",
  "moderator",
  "vip",
  "subscriber",
  "founder",
  "premium",
  "turbo",
  "partner",
  "staff",
  "verified",
]);

function unescapeTag(value) {
  return String(value ?? "")
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function parseTags(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const entry of raw.split(";")) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    tags[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return tags;
}

function buildEmoteParts(text, emotesTag) {
  if (!emotesTag) return [{ type: "text", text }];
  const ranges = [];
  for (const group of emotesTag.split("/")) {
    const [id, positions] = group.split(":");
    if (!id || !positions) continue;
    for (const position of positions.split(",")) {
      const [startRaw, endRaw] = position.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end < text.length &&
        /^\d+$/.test(id)
      ) {
        ranges.push({ id, start, end });
      }
    }
  }
  if (!ranges.length) return [{ type: "text", text }];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const parts = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push({ type: "text", text: text.slice(cursor, range.start) });
    }
    parts.push({
      type: "emote",
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${range.id}/default/dark/2.0`,
      alt: text.slice(range.start, range.end + 1),
    });
    cursor = range.end + 1;
  }
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

function parseBadges(tags) {
  const badges = [];
  const raw = tags.badges || "";
  for (const entry of raw.split(",")) {
    const name = entry.split("/")[0];
    if (BADGE_NAMES.has(name) && !badges.includes(name)) badges.push(name);
  }
  if (tags.mod === "1" && !badges.includes("moderator")) badges.push("moderator");
  if (tags.subscriber === "1" && !badges.includes("subscriber")) badges.push("subscriber");
  return badges;
}

export class TwitchConnector extends BaseConnector {
  constructor(channel, hub) {
    super("twitch", channel, hub);
    this.ws = null;
    this.buffer = "";
    this.connectTimer = null;
    this.joined = false;
    this.nickname = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    this.liveTimer = null;
    this.liveCheckBusy = false;
  }

  connect() {
    this.clearReconnect();
    this.joined = false;
    this.setStatus("connecting", `Conectando a Twitch #${this.channel}...`, { live: false });
    const ws = new WebSocket(IRC_URL, {
      headers: { "User-Agent": USER_AGENT },
      handshakeTimeout: 15000,
    });
    this.ws = ws;
    this.buffer = "";

    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.joined) return;
      this.setStatus("error", "Twitch no confirmó la entrada al canal. Reintentando...");
      try {
        ws.close();
      } catch {
        // ignorar
      }
    }, 20000);

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.send("PASS SCHMOOPIIE");
      this.send(`NICK ${this.nickname}`);
      setTimeout(() => {
        if (this.ws === ws && this.running) this.send(`JOIN #${this.channel}`);
      }, 250);
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.buffer += data.toString("utf8");
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectTimer();
      if (!this.running) return;
      this.scheduleReconnect(`Twitch: conexión cerrada. Reintentando...`);
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.lastError = formatError(error);
      this.setStatus("error", `Twitch: ${this.lastError}`);
    });
  }

  send(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(text);
    } catch {
      // el evento close se encarga de reconectar
    }
  }

  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) return;

    if (line === "PING" || line.startsWith("PING ")) {
      this.send(`PONG :tmi.twitch.tv`);
      return;
    }

    if (line === "RECONNECT") {
      this.setStatus("reconnecting", "Twitch pidió reconectar. Reconectando...");
      try {
        this.ws?.close();
      } catch {
        // ignorar
      }
      return;
    }

    let tagsRaw = "";
    let rest = line;
    if (line.startsWith("@")) {
      const space = line.indexOf(" ");
      if (space > 0) {
        tagsRaw = line.slice(1, space);
        rest = line.slice(space + 1);
      }
    }
    const tags = parseTags(tagsRaw);

    if (rest.includes(" PRIVMSG ")) {
      this.handlePrivmsg(tags, rest);
      return;
    }

    if (rest.includes(" JOIN #")) {
      this.joined = true;
      this.attempts = 0;
      this.clearConnectTimer();
      this.setStatus("connected", `Twitch #${this.channel} conectado`, { live: false });
      this.refreshLiveStatus();
      this.stopLiveTimer();
      this.liveTimer = setInterval(() => this.refreshLiveStatus(), 60000);
      this.liveTimer.unref?.();
      return;
    }

    if (rest.startsWith("NOTICE ")) {
      const notice = rest.slice(rest.indexOf(" :") + 2);
      const msgId = tags["msg-id"] ?? "";
      if (
        msgId === "msg_channel_suspended" ||
        msgId === "msg_banned" ||
        msgId === "msg_room_not_found" ||
        /suspended|banned|not found|no such channel/i.test(notice)
      ) {
        this.setStatus("error", `Twitch: ${notice}`);
      } else if (/error|failed|could not/i.test(notice)) {
        this.setStatus("error", `Twitch: ${notice}`);
      }
    }
  }

  handlePrivmsg(tags, rest) {
    const privmsgIndex = rest.indexOf(" PRIVMSG ");
    const colonIndex = rest.indexOf(" :", privmsgIndex);
    if (privmsgIndex < 0 || colonIndex < 0) return;

    const prefix = rest.slice(0, privmsgIndex);
    const userMatch = prefix.match(/^:([^!]+)!/);
    const login = (userMatch?.[1] || tags.login || "twitch").toLowerCase();
    const displayName = unescapeTag(tags["display-name"]) || login;
    let text = rest.slice(colonIndex + 2);
    let action = false;

    if (text.startsWith("\u0001ACTION ") && text.endsWith("\u0001")) {
      text = text.slice(8, -1);
      action = true;
    }

    text = cleanText(text, 1000);
    if (!text) return;

    const parts = buildEmoteParts(text, tags.emotes);
    const timestamp = Number(tags["tmi-sent-ts"]);
    this.publish({
      id: tags.id || undefined,
      user: login,
      name: displayName,
      color: colorFor(login, "twitch", tags.color),
      parts,
      text,
      badges: parseBadges(tags),
      action,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
  }

  async refreshLiveStatus() {
    if (!this.running || !this.joined || this.liveCheckBusy) return;
    this.liveCheckBusy = true;
    try {
      const data = await fetchJson(
        "https://gql.twitch.tv/gql",
        {
          method: "POST",
          headers: {
            "Client-ID": TWITCH_GQL_CLIENT_ID,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            query:
              "query($login:String!){ user(login:$login){ login displayName stream { id viewersCount } } }",
            variables: { login: this.channel },
          }),
        },
        10000,
      );
      if (!this.running || !this.joined) return;
      const stream = data?.data?.user?.stream;
      const viewers = Number(stream?.viewersCount) || 0;
      this.setStatus("connected", `Twitch #${this.channel} conectado`, {
        live: Boolean(stream),
        viewers,
      });
    } catch {
      // Si Twitch limita la consulta, el chat sigue funcionando.
    } finally {
      this.liveCheckBusy = false;
    }
  }

  stopLiveTimer() {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  close() {
    this.stopLiveTimer();
    this.clearConnectTimer();
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
