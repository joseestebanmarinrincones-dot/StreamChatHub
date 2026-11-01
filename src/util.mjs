import { createHash } from "node:crypto";

export const PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];

export const PLATFORM_INFO = {
  twitch: { label: "Twitch", color: "#9146ff" },
  kick: { label: "Kick", color: "#53fc18" },
  youtube: { label: "YouTube", color: "#ff0033" },
  tiktok: { label: "TikTok", color: "#25f4ee" },
};

const USER_COLORS = [
  "#ff8a8a",
  "#ffb86b",
  "#ffe066",
  "#b2f2bb",
  "#63e6be",
  "#74c0fc",
  "#a5b4fc",
  "#b197fc",
  "#f783ac",
  "#e599f7",
  "#ffc9c9",
  "#96f2d7",
];

export function cleanText(value, maxLength = 400) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…" : text;
}

export function validHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function colorFor(name, platform = "twitch", preferred) {
  if (validHexColor(preferred)) return preferred;
  const hash = createHash("sha1").update(`${platform}:${String(name ?? "").toLowerCase()}`).digest();
  return USER_COLORS[hash[0] % USER_COLORS.length];
}

export function normalizeChannel(platform, raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";

  if (platform === "twitch") {
    value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    value = value.replace(/^twitch\.tv\//i, "").replace(/^m\.twitch\.tv\//i, "");
    value = value.split(/[/?#]/)[0].replace(/^@/, "").toLowerCase();
    return /^[a-z0-9_]{1,30}$/.test(value) ? value : "";
  }

  if (platform === "kick") {
    value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    value = value.replace(/^kick\.com\//i, "");
    value = value.split(/[/?#]/)[0].replace(/^@/, "").toLowerCase();
    return /^[a-z0-9_-]{1,60}$/.test(value) ? value : "";
  }

  if (platform === "tiktok") {
    value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    value = value.replace(/^tiktok\.com\//i, "");
    value = value.replace(/^@/, "");
    value = value.split(/[/?#]/)[0].replace(/^@/, "").toLowerCase();
    return /^[a-z0-9._-]{1,80}$/.test(value) ? value : "";
  }

  if (platform === "youtube") {
    value = value.replace(/^@\s+/, "@");
    return value.slice(0, 500);
  }

  return value;
}

export function formatError(error) {
  if (!error) return "Error desconocido";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    const json = JSON.stringify(error);
    return json && json !== "{}" ? json : String(error);
  } catch {
    return String(error);
  }
}

export function isOfflineError(error) {
  const text = `${error?.name ?? ""} ${error?.message ?? ""} ${formatError(error)}`.toLowerCase();
  return (
    text.includes("offline") ||
    text.includes("not live") ||
    text.includes("not online") ||
    text.includes("isn't online") ||
    text.includes("isn’t online") ||
    text.includes("is not online") ||
    text.includes("user is not") ||
    text.includes("isn't live") ||
    text.includes("not currently live")
  );
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = [controller.signal, options.signal].filter(Boolean);
  const signal =
    signals.length > 1 && typeof AbortSignal.any === "function"
      ? AbortSignal.any(signals)
      : signals[signals.length - 1];
  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, options = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  return { text: await response.text(), url: response.url, response };
}

export async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Respuesta no válida (HTTP ${response.status}) en ${url}`);
  }
  if (!response.ok) {
    const message = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`${message} (${url})`);
  }
  return data;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number * 100) / 100));
}

export const sleep = delay;
