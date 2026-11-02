import {
  badgeLabel,
  createChatSocket,
  icon,
  PLATFORM_META,
  platformIcon,
  renderParts,
  safeColor,
} from "./common.js";

const overlay = document.getElementById("overlay");
const list = document.getElementById("overlayList");
const statusEl = document.getElementById("overlayStatus");
const viewersEl = document.getElementById("overlayViewers");
const viewersIcon = document.getElementById("overlayViewersIcon");
const viewersCount = document.getElementById("overlayViewersCount");
const notificationsEl = document.getElementById("overlayNotifications");
const composerEl = document.getElementById("overlayComposer");
const composerInput = document.getElementById("overlayComposerInput");
const composerSend = document.getElementById("overlayComposerSend");
const composerError = document.getElementById("overlayComposerError");
const editbar = document.getElementById("overlayEditbar");

const params = new URLSearchParams(location.search);
const isDemo = params.get("demo") === "1";
const isPip = params.get("pip") === "1";
const isEditing = params.get("edit") === "1";
const showStatus = params.get("status") === "1";

const queryOverrides = {};
function numberParam(name, min, max) {
  if (!params.has(name)) return undefined;
  const value = Number(params.get(name));
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}
function boolParam(name) {
  if (!params.has(name)) return undefined;
  return params.get(name) !== "0" && params.get(name) !== "false";
}

const maxOverride = numberParam("max", 1, 100);
const fontOverride = numberParam("font", 10, 48);
const bgOverride = numberParam("bg", 0, 1);
const widthOverride = numberParam("width", 240, 900);
const lifetimeOverride = numberParam("lifetime", 0, 300);
const platformOverride = boolParam("platform");
const badgesOverride = boolParam("badges");
const viewersOverride = boolParam("viewers");
const anchorOverride = ["bottom-left", "bottom-right", "top-left", "top-right"].includes(params.get("anchor"))
  ? params.get("anchor")
  : undefined;

if (maxOverride !== undefined) queryOverrides.maxMessages = Math.round(maxOverride);
if (fontOverride !== undefined) queryOverrides.fontSize = Math.round(fontOverride);
if (bgOverride !== undefined) queryOverrides.backgroundOpacity = bgOverride;
if (widthOverride !== undefined) queryOverrides.width = Math.round(widthOverride);
if (lifetimeOverride !== undefined) queryOverrides.lifetimeSeconds = Math.round(lifetimeOverride);
if (platformOverride !== undefined) queryOverrides.showPlatform = platformOverride;
if (badgesOverride !== undefined) queryOverrides.showBadges = badgesOverride;
if (viewersOverride !== undefined) queryOverrides.showViewers = viewersOverride;
if (anchorOverride !== undefined) queryOverrides.anchor = anchorOverride;

// El overlay de OBS se queda permanente. La ventana flotante conserva la duración normal.
const isObsSource = params.get("obs") === "1" || /OBS/i.test(navigator.userAgent);
if (isObsSource) {
  queryOverrides.lifetimeSeconds = 0;
  if (!params.has("max")) queryOverrides.maxMessages = 50;
}

const DEFAULTS = {
  maxMessages: 12,
  fontSize: 18,
  backgroundOpacity: 0.28,
  showPlatform: true,
  showBadges: true,
  showViewers: true,
  lifetimeSeconds: 30,
  width: 440,
  anchor: "bottom-left",
};

let config = { ...DEFAULTS, ...queryOverrides };
let demoOnly = false;
let statuses = {};
const viewerNumberFormat = new Intl.NumberFormat("es-ES");

if (viewersIcon) viewersIcon.innerHTML = icon("eye", "icon");
if (isPip) document.body.classList.add("pip-mode");

function applyConfig(overlaySettings = {}) {
  config = {
    ...DEFAULTS,
    ...(overlaySettings || {}),
    ...queryOverrides,
  };
  document.documentElement.style.setProperty("--overlay-width", `${config.width}px`);
  document.documentElement.style.setProperty("--overlay-font", `${config.fontSize}px`);
  document.documentElement.style.setProperty("--overlay-bg", String(config.backgroundOpacity));
  overlay.className = `overlay anchor-${config.anchor}`;
  document.body.classList.toggle("hide-platform", config.showPlatform === false);
  document.body.classList.toggle("hide-badges", config.showBadges === false);
  document.body.classList.toggle("hide-viewers", config.showViewers === false);
  statusEl.hidden = !showStatus;
  document.body.classList.toggle("show-status", showStatus);
  trimMessages();
  updateViewers();
}

function trimMessages() {
  while (list.children.length > config.maxMessages) {
    const first = list.firstElementChild;
    if (!first) break;
    clearTimeout(first._fadeTimer);
    clearTimeout(first._removeTimer);
    first.remove();
  }
}

function formatViewerTotal(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  if (total >= 1_000_000) return `${Math.floor(total / 1_000_000)}m`;
  if (total >= 1_000) return `${Math.floor(total / 1_000)}k`;
  return String(total);
}

function updateViewers() {
  if (!viewersEl) return;
  if (config.showViewers === false) {
    viewersEl.hidden = true;
    return;
  }
  let total = 0;
  const breakdown = [];
  for (const platform of ["twitch", "kick", "youtube", "tiktok"]) {
    const status = statuses[platform];
    if (!status || status.state !== "connected") continue;
    const viewers = Math.max(0, Math.round(Number(status.viewers) || 0));
    total += viewers;
    if (viewers > 0) {
      breakdown.push(`${PLATFORM_META[platform]?.label || platform}: ${viewerNumberFormat.format(viewers)}`);
    }
  }
  if (isDemo && total === 0) total = 1248;
  viewersEl.hidden = false;
  viewersEl.classList.toggle("is-zero", total === 0);
  if (viewersCount) viewersCount.textContent = formatViewerTotal(total);
  viewersEl.title = breakdown.length
    ? `Espectadores conectados · ${breakdown.join(" · ")}`
    : "Espectadores en todas las plataformas";
}

function updateStatus() {
  if (!showStatus) {
    statusEl.hidden = true;
    return;
  }
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const platform of ["twitch", "kick", "youtube", "tiktok"]) {
    const status = statuses[platform];
    if (!status || status.state === "disabled") continue;
    const meta = PLATFORM_META[platform];
    const item = document.createElement("span");
    item.className = "ol-status-item";
    if (status.state === "connected") item.classList.add("is-on");
    else if (["connecting", "reconnecting"].includes(status.state)) item.classList.add("is-waiting");
    item.style.setProperty("--platform-color", meta.color);
    item.title = `${meta.label}: ${status.message || status.state}`;
    const dot = document.createElement("span");
    dot.className = "ol-status-dot";
    const label = document.createElement("span");
    label.textContent = meta.label;
    item.append(dot, label);
    fragment.append(item);
    count += 1;
  }
  statusEl.replaceChildren(fragment);
  statusEl.hidden = count === 0;
}

function createOverlayMessage(message, { demo = false } = {}) {
  const meta = PLATFORM_META[message.platform] || PLATFORM_META.twitch;
  const article = document.createElement("div");
  article.className = "ol-message";
  if (demo) article.classList.add("is-demo");
  if (message.meta?.superchat) article.classList.add("has-superchat");
  if (message.action) article.classList.add("is-action");
  if (message.host) article.classList.add("is-host");
  article.dataset.platform = message.platform;
  article.style.setProperty("--platform-color", meta.color);
  article.style.setProperty("--user-color", safeColor(message.color, message.user || message.name));

  const metaRow = document.createElement("div");
  metaRow.className = "ol-meta";

  const platform = document.createElement("span");
  platform.className = "ol-platform";
  platform.title = meta.label;
  platform.innerHTML = platformIcon(message.platform, "icon");
  metaRow.append(platform);

  const name = document.createElement("span");
  name.className = "ol-name";
  name.textContent = message.name || message.user || meta.label;
  metaRow.append(name);

  if (Array.isArray(message.badges) && message.badges.length) {
    const badges = document.createElement("span");
    badges.className = "ol-badges";
    for (const badge of message.badges.slice(0, 5)) {
      const badgeEl = document.createElement("span");
      badgeEl.className = `ol-badge badge-${badge}`;
      badgeEl.textContent = badgeLabel(badge);
      badges.append(badgeEl);
    }
    if (message.host) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "ol-badge badge-local";
      hostBadge.textContent = "LOCAL";
      badges.append(hostBadge);
    }
    metaRow.append(badges);
  } else if (message.host) {
    const badges = document.createElement("span");
    badges.className = "ol-badges";
    const hostBadge = document.createElement("span");
    hostBadge.className = "ol-badge badge-local";
    hostBadge.textContent = "LOCAL";
    badges.append(hostBadge);
    metaRow.append(badges);
  }

  if (message.meta?.superchat?.amount) {
    const amount = document.createElement("span");
    amount.className = "ol-superchat";
    amount.textContent = message.meta.superchat.amount;
    metaRow.append(amount);
  }

  const text = document.createElement("div");
  text.className = "ol-text";
  renderParts(text, message.parts);

  article.append(metaRow, text);

  if (!demo && config.lifetimeSeconds > 0) {
    article._fadeTimer = setTimeout(() => {
      article.classList.add("fading");
      article._removeTimer = setTimeout(() => article.remove(), 600);
    }, config.lifetimeSeconds * 1000);
  }

  return article;
}

function appendMessage(message, { demo = false } = {}) {
  if (demoOnly && !demo) {
    demoOnly = false;
    list.replaceChildren();
  }
  list.append(createOverlayMessage(message, { demo }));
  trimMessages();
}

function clearMessages() {
  for (const child of [...list.children]) {
    clearTimeout(child._fadeTimer);
    clearTimeout(child._removeTimer);
    child.remove();
  }
}

function renderHistory(messages) {
  demoOnly = false;
  clearMessages();
  for (const message of messages || []) {
    list.append(createOverlayMessage(message, { demo: false }));
  }
  trimMessages();
}

function renderDemo() {
  demoOnly = true;
  clearMessages();
  const now = Date.now();
  const demos = [
    {
      platform: "twitch",
      name: "LunaStream",
      user: "lunastream",
      color: "#c4b5fd",
      badges: ["moderator"],
      text: "¡Hola! Así se verá el chat unificado en tu overlay.",
      parts: [{ type: "text", text: "¡Hola! Así se verá el chat unificado en tu overlay." }],
    },
    {
      platform: "kick",
      name: "PixelKev",
      user: "pixelkev",
      color: "#53fc18",
      badges: [],
      text: "Twitch, Kick, YouTube y TikTok en una sola lista.",
      parts: [{ type: "text", text: "Twitch, Kick, YouTube y TikTok en una sola lista." }],
    },
    {
      platform: "youtube",
      name: "Andrés Live",
      user: "andreslive",
      color: "#ff8a8a",
      badges: ["member"],
      text: "Mensaje de YouTube con una insignia de miembro.",
      parts: [{ type: "text", text: "Mensaje de YouTube con una insignia de miembro." }],
      meta: { superchat: { amount: "5,00 €", color: "#ffd43b" } },
    },
    {
      platform: "tiktok",
      name: "sofi.live",
      user: "sofi.live",
      color: "#25f4ee",
      badges: [],
      text: "TikTok también aparece aquí, en tiempo real.",
      parts: [{ type: "text", text: "TikTok también aparece aquí, en tiempo real." }],
    },
    {
      platform: "twitch",
      name: "mod_carla",
      user: "mod_carla",
      color: "#ffd43b",
      badges: ["broadcaster"],
      text: "Cambia tamaño, fondo y posición desde Ajustes.",
      parts: [{ type: "text", text: "Cambia tamaño, fondo y posición desde Ajustes." }],
    },
  ];
  for (const item of demos.slice(0, config.maxMessages)) {
    list.append(
      createOverlayMessage(
        {
          ...item,
          timestamp: now,
        },
        { demo: true },
      ),
    );
  }
}

function showNotification(notification) {
  if (!notificationsEl || !notification) return;
  const meta = {
    join: { title: "Nueva entrada", icon: "userPlus" },
    gift: { title: "Regalo / donación", icon: "gift" },
    share: { title: "Compartido", icon: "share" },
    follow: { title: "Nuevo seguidor", icon: "heart" },
    subscribe: { title: "Suscripción", icon: "star" },
    like: { title: "Me gusta", icon: "heart" },
  }[notification.type];
  if (!meta) return;

  const card = document.createElement("div");
  card.className = "ol-notification";
  card.dataset.type = notification.type;

  const iconEl = document.createElement("span");
  iconEl.className = "ol-notification-icon";
  iconEl.innerHTML = icon(meta.icon, "icon");

  const copy = document.createElement("div");
  copy.className = "ol-notification-copy";
  const title = document.createElement("span");
  title.className = "ol-notification-title";
  title.textContent = meta.title;
  const text = document.createElement("span");
  text.className = "ol-notification-text";
  text.textContent = notification.text;
  copy.append(title, text);

  card.append(iconEl, copy);
  if (notification.diamonds) {
    const amount = document.createElement("span");
    amount.className = "ol-notification-amount";
    amount.textContent = `${notification.diamonds} 💎`;
    card.append(amount);
  } else if (notification.count && notification.type === "gift") {
    const amount = document.createElement("span");
    amount.className = "ol-notification-amount";
    amount.textContent = `x${notification.count}`;
    card.append(amount);
  }

  notificationsEl.append(card);
  while (notificationsEl.children.length > 4) {
    notificationsEl.firstElementChild?.remove();
  }

  setTimeout(() => {
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 380);
  }, 6200);
}

let composerBusy = false;

function openComposer() {
  if (!composerEl || !composerInput) return;
  composerEl.hidden = false;
  composerError.hidden = true;
  composerError.textContent = "";
  composerInput.value = "";
  requestAnimationFrame(() => composerInput.focus());
}

function closeComposer(notifyMain = true) {
  if (!composerEl) return;
  composerEl.hidden = true;
  composerInput?.blur();
  if (notifyMain) window.streamChatApp?.endComposer?.();
}

async function sendComposerMessage() {
  if (composerBusy || !composerInput) return;
  const text = composerInput.value.trim();
  if (!text) {
    composerInput.focus();
    return;
  }
  composerBusy = true;
  if (composerSend) composerSend.disabled = true;
  try {
    const response = await fetch("/api/host-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "No se pudo enviar el mensaje.");
    closeComposer(true);
  } catch (error) {
    if (composerError) {
      composerError.hidden = false;
      composerError.textContent = error.message;
    }
  } finally {
    composerBusy = false;
    if (composerSend) composerSend.disabled = false;
  }
}

function setupComposer() {
  composerSend?.addEventListener("click", sendComposerMessage);
  composerInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendComposerMessage();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeComposer(true);
    }
  });
  window.streamChatApp?.onComposer?.(() => openComposer());
}

function setupEditbar() {
  if (!isEditing || !editbar) return;
  document.body.classList.add("overlay-editing");
  editbar.hidden = false;
  editbar.innerHTML = `
    <div class="overlay-editbar-title">${icon("pin", "icon")} Mover overlay</div>
    <div class="overlay-editbar-hint">Arrastra esta barra para colocarlo donde quieras. Pulsa Listo al terminar.</div>
    <div class="overlay-editbar-actions">
      <button type="button" data-size="compact">Pequeño</button>
      <button type="button" data-size="medium">Mediano</button>
      <button type="button" data-size="large">Grande</button>
      <button type="button" data-action="copy-obs">Copiar URL OBS</button>
      <button type="button" class="is-primary" data-action="finish">Listo</button>
    </div>`;
  editbar.addEventListener("click", (event) => {
    const sizeButton = event.target.closest("[data-size]");
    if (sizeButton) {
      window.streamChatApp?.setOverlaySize?.(sizeButton.dataset.size);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    if (actionButton.dataset.action === "finish") {
      window.streamChatApp?.finishOverlayEdit?.();
    } else if (actionButton.dataset.action === "copy-obs") {
      const original = actionButton.textContent;
      Promise.resolve(window.streamChatApp?.copyObsUrl?.())
        .then((ok) => {
          actionButton.textContent = ok ? "URL copiada" : "No se pudo copiar";
          setTimeout(() => {
            actionButton.textContent = original;
          }, 1600);
        })
        .catch(() => {
          actionButton.textContent = "No se pudo copiar";
        });
    }
  });
}

applyConfig();
document.body.classList.toggle("pip-mode", isPip);
setupComposer();
setupEditbar();

const socket = createChatSocket({
  onSnapshot: (data) => {
    statuses = data.statuses || {};
    applyConfig(data.settings?.overlay || {});
    updateStatus();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (isDemo && messages.length === 0) {
      if (!list.children.length) renderDemo();
      return;
    }
    renderHistory(messages);
  },
  onMessage: (message) => {
    if (demoOnly) {
      demoOnly = false;
      clearMessages();
    }
    appendMessage(message);
  },
  onStatus: (status) => {
    if (!status?.platform) return;
    statuses[status.platform] = status;
    updateStatus();
    updateViewers();
  },
  onCleared: () => {
    clearMessages();
    demoOnly = false;
    if (isDemo) renderDemo();
  },
  onSettings: (settings) => {
    applyConfig(settings?.overlay || {});
    updateStatus();
  },
  onNotification: (notification) => {
    showNotification(notification);
  },
});

if (isDemo) {
  renderDemo();
  setTimeout(() => {
    showNotification({ type: "join", text: "Luna se unió al directo" });
  }, 650);
  setTimeout(() => {
    showNotification({
      type: "gift",
      text: "Pixel envió Rosa x5",
      diamonds: 25,
      count: 5,
    });
  }, 1450);
}
updateStatus();

window.addEventListener("pagehide", () => socket.close());
