import { icon, platformIcon, PLATFORM_META } from "./icons.js";

export { icon, platformIcon, PLATFORM_META };

const BADGE_LABELS = {
  broadcaster: "STREAMER",
  moderator: "MOD",
  vip: "VIP",
  subscriber: "SUB",
  founder: "FOUNDER",
  premium: "PRIME",
  turbo: "TURBO",
  partner: "PARTNER",
  staff: "STAFF",
  verified: "✓",
  member: "MIEMBRO",
  superchat: "SUPERCHAT",
};

const FALLBACK_COLORS = [
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
];

export function badgeLabel(badge) {
  return BADGE_LABELS[badge] || String(badge || "").toUpperCase().slice(0, 12);
}

export function platformLabel(platform) {
  return PLATFORM_META[platform]?.label || platform;
}

export function safeColor(color, fallbackName = "") {
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) return color;
  let hash = 0;
  const text = String(fallbackName);
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export function formatTime(timestamp, locale = "es-ES") {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(".0", "")}k`;
  return String(number);
}

export function stateText(state, live = false) {
  switch (state) {
    case "connected":
      return live ? "En directo" : "Conectado";
    case "connecting":
      return "Conectando";
    case "reconnecting":
      return "Reconectando";
    case "offline":
      return "Sin directo";
    case "error":
      return "Error";
    case "disabled":
      return "Sin canal";
    default:
      return "Inactivo";
  }
}

export function stateTone(state) {
  if (state === "connected") return "ok";
  if (state === "error") return "error";
  if (state === "offline" || state === "disabled") return "idle";
  return "warn";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderParts(target, parts = []) {
  target.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (!part) continue;
    if (part.type === "text") {
      fragment.append(document.createTextNode(part.text || ""));
      continue;
    }
    if (part.type === "emote" && part.url) {
      const image = document.createElement("img");
      image.className = "emote";
      image.src = part.url;
      image.alt = part.alt || "emote";
      image.title = part.alt || "emote";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener(
        "error",
        () => {
          image.replaceWith(document.createTextNode(part.alt || ""));
        },
        { once: true },
      );
      fragment.append(image);
    }
  }
  target.append(fragment);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function toast(message, type = "info", timeout = 3400) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  const names = type === "success" ? "checkCircle" : type === "error" ? "alertCircle" : type === "warning" ? "warning" : "info";
  const element = document.createElement("div");
  element.className = `toast toast-${type}`;
  const iconWrap = document.createElement("span");
  iconWrap.className = "toast-icon";
  iconWrap.innerHTML = icon(names, "icon");
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  element.append(iconWrap, text);
  host.append(element);
  while (host.children.length > 4) host.firstElementChild?.remove();
  requestAnimationFrame(() => element.classList.add("is-visible"));
  setTimeout(() => {
    element.classList.remove("is-visible");
    setTimeout(() => element.remove(), 320);
  }, timeout);
}

export function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function createChatSocket(handlers = {}) {
  let socket = null;
  let stopped = false;
  let retry = 0;
  let retryTimer = null;

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(8000, 500 * 2 ** Math.min(retry, 4));
    retry += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  };

  function connect() {
    if (stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      socket = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
      schedule();
      return;
    }

    socket.addEventListener("open", () => {
      retry = 0;
      handlers.onOpen?.();
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (payload.type) {
        case "snapshot":
          handlers.onSnapshot?.(payload.data);
          break;
        case "message":
          handlers.onMessage?.(payload.message, payload.stats);
          break;
        case "status":
          handlers.onStatus?.(payload.status);
          break;
        case "cleared":
          handlers.onCleared?.();
          break;
        case "settings":
          handlers.onSettings?.(payload.settings);
          break;
        case "stats":
          handlers.onStats?.(payload.stats);
          break;
        case "tunnel":
          handlers.onTunnel?.(payload.tunnel);
          break;
        case "notification":
          handlers.onNotification?.(payload.notification);
          break;
        case "pong":
          handlers.onPong?.(payload);
          break;
        default:
          break;
      }
    });

    socket.addEventListener("close", () => {
      handlers.onClose?.();
      schedule();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // ignorar
      }
    });
  }

  connect();

  return {
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        // ignorar
      }
    },
    get socket() {
      return socket;
    },
  };
}

export function collectionToList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}
