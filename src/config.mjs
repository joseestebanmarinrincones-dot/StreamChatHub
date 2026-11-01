import fs from "node:fs";
import path from "node:path";
import { cleanText, clampNumber, normalizeChannel, PLATFORMS } from "./util.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  channels: {
    twitch: "",
    kick: "",
    youtube: "",
    tiktok: "",
  },
  kick: {
    channelId: 0,
    chatroomId: 0,
  },
  tiktok: {
    source: "direct",
    signApiKey: "",
    events: {
      joins: true,
      gifts: true,
      shares: true,
      follows: true,
      subscribes: true,
      likes: false,
    },
  },
  tikfinity: {
    url: "ws://localhost:21213/",
  },
  filters: {
    blockedUsers: [],
    ignoreCommands: true,
    maxMessageLength: 300,
  },
  overlay: {
    maxMessages: 12,
    fontSize: 18,
    backgroundOpacity: 0.28,
    showPlatform: true,
    showBadges: true,
    lifetimeSeconds: 30,
    width: 440,
    anchor: "bottom-left",
  },
  ui: {
    showTimestamps: true,
  },
});

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(max, Math.floor(number));
}

export function normalizeSettings(input = {}) {
  const defaults = DEFAULT_SETTINGS;
  const channels = input.channels ?? {};
  const kick = input.kick ?? {};
  const tiktok = input.tiktok ?? {};
  const tiktokEvents = tiktok.events ?? {};
  const tikfinity = input.tikfinity ?? {};
  const filters = input.filters ?? {};
  const overlay = input.overlay ?? {};
  const ui = input.ui ?? {};

  const tikfinityUrl = cleanText(tikfinity.url || DEFAULT_SETTINGS.tikfinity.url, 300);
  const validTikfinityUrl = /^wss?:\/\//i.test(tikfinityUrl)
    ? tikfinityUrl
    : DEFAULT_SETTINGS.tikfinity.url;

  const blockedUsers = Array.isArray(filters.blockedUsers)
    ? [...new Set(
        filters.blockedUsers
          .map((name) => cleanText(name, 80).replace(/^@/, "").toLowerCase())
          .filter(Boolean),
      )].slice(0, 200)
    : [];

  const anchor = ["bottom-left", "bottom-right", "top-left", "top-right"].includes(overlay.anchor)
    ? overlay.anchor
    : "bottom-left";

  return {
    channels: {
      twitch: normalizeChannel("twitch", channels.twitch),
      kick: normalizeChannel("kick", channels.kick),
      youtube: normalizeChannel("youtube", channels.youtube),
      tiktok: normalizeChannel("tiktok", channels.tiktok),
    },
    kick: {
      channelId: positiveInteger(kick.channelId, 0, 999999999999),
      chatroomId: positiveInteger(kick.chatroomId, 0, 999999999999),
    },
    tiktok: {
      source: tiktok.source === "tikfinity" ? "tikfinity" : "direct",
      signApiKey: cleanText(tiktok.signApiKey, 500),
      events: {
        joins: asBoolean(tiktokEvents.joins, true),
        gifts: asBoolean(tiktokEvents.gifts, true),
        shares: asBoolean(tiktokEvents.shares, true),
        follows: asBoolean(tiktokEvents.follows, true),
        subscribes: asBoolean(tiktokEvents.subscribes, true),
        likes: asBoolean(tiktokEvents.likes, false),
      },
    },
    tikfinity: {
      url: validTikfinityUrl,
    },
    filters: {
      blockedUsers,
      ignoreCommands: asBoolean(filters.ignoreCommands, true),
      maxMessageLength: Math.round(clampNumber(filters.maxMessageLength, 50, 1000, 300)),
    },
    overlay: {
      maxMessages: Math.round(clampNumber(overlay.maxMessages, 1, 50, 12)),
      fontSize: Math.round(clampNumber(overlay.fontSize, 10, 48, 18)),
      backgroundOpacity: clampNumber(overlay.backgroundOpacity, 0, 1, 0.28),
      showPlatform: asBoolean(overlay.showPlatform, true),
      showBadges: asBoolean(overlay.showBadges, true),
      lifetimeSeconds: Math.round(clampNumber(overlay.lifetimeSeconds, 5, 300, 30)),
      width: Math.round(clampNumber(overlay.width, 240, 900, 440)),
      anchor,
    },
    ui: {
      showTimestamps: asBoolean(ui.showTimestamps, true),
    },
  };
}

function mergeWithDefaults(raw) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...raw,
    channels: { ...DEFAULT_SETTINGS.channels, ...(raw?.channels ?? {}) },
    kick: { ...DEFAULT_SETTINGS.kick, ...(raw?.kick ?? {}) },
    tiktok: {
      ...DEFAULT_SETTINGS.tiktok,
      ...(raw?.tiktok ?? {}),
      events: { ...DEFAULT_SETTINGS.tiktok.events, ...(raw?.tiktok?.events ?? {}) },
    },
    tikfinity: { ...DEFAULT_SETTINGS.tikfinity, ...(raw?.tikfinity ?? {}) },
    filters: { ...DEFAULT_SETTINGS.filters, ...(raw?.filters ?? {}) },
    overlay: { ...DEFAULT_SETTINGS.overlay, ...(raw?.overlay ?? {}) },
    ui: { ...DEFAULT_SETTINGS.ui, ...(raw?.ui ?? {}) },
  };
}

function mergeSettings(base, patch) {
  return {
    ...base,
    ...patch,
    channels: { ...base.channels, ...(patch?.channels ?? {}) },
    kick: { ...base.kick, ...(patch?.kick ?? {}) },
    tiktok: {
      ...base.tiktok,
      ...(patch?.tiktok ?? {}),
      events: { ...base.tiktok.events, ...(patch?.tiktok?.events ?? {}) },
    },
    tikfinity: { ...base.tikfinity, ...(patch?.tikfinity ?? {}) },
    filters: { ...base.filters, ...(patch?.filters ?? {}) },
    overlay: { ...base.overlay, ...(patch?.overlay ?? {}) },
    ui: { ...base.ui, ...(patch?.ui ?? {}) },
  };
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save(this.settings);
      return this.settings;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.settings = normalizeSettings(mergeWithDefaults(raw));
    } catch (error) {
      const backup = `${this.filePath}.roto-${Date.now()}`;
      console.warn(`[Config] No se pudo leer config.json (${error.message}). Se guardó una copia en ${backup}`);
      try {
        fs.copyFileSync(this.filePath, backup);
      } catch {
        // sin copia de seguridad
      }
      this.settings = structuredClone(DEFAULT_SETTINGS);
      this.save(this.settings);
    }
    return this.settings;
  }

  save(settings) {
    this.settings = normalizeSettings(settings);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.settings, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.filePath);
    return this.settings;
  }

  update(patch) {
    return this.save(mergeSettings(this.settings, patch));
  }
}

export function publicSettings(settings) {
  const copy = structuredClone(settings);
  delete copy.tiktok.signApiKey;
  return {
    ...copy,
    tiktokKeySet: Boolean(settings.tiktok.signApiKey || process.env.TIKTOK_SIGN_API_KEY),
  };
}

export function effectiveTikTokKey(settings) {
  return process.env.TIKTOK_SIGN_API_KEY || settings.tiktok.signApiKey || "";
}

export function channelSummary(settings) {
  return PLATFORMS.map((platform) => ({
    platform,
    channel: settings.channels[platform],
  }));
}
