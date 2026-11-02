import {
  badgeLabel,
  collectionToList,
  copyText,
  createChatSocket,
  debounce,
  escapeHtml,
  formatNumber,
  formatTime,
  icon,
  platformIcon,
  PLATFORM_META,
  renderParts,
  safeColor,
  stateText,
  stateTone,
  toast,
} from "./common.js";

const PLATFORM_ORDER = ["twitch", "kick", "youtube", "tiktok"];
const MAX_MESSAGES = 300;

const state = {
  messages: [],
  statuses: {},
  stats: { total: 0, perPlatform: {}, uniqueChatters: 0, messagesPerMinute: 0 },
  settings: null,
  share: null,
  canManage: false,
  filter: "all",
  search: "",
  paused: false,
  buffer: [],
  newCount: 0,
  visibleCount: 0,
  socketOnline: false,
  sound: localStorage.getItem("streamchat:sound") === "1",
  audio: null,
  lastSoundAt: 0,
  emptyAction: "settings",
  initialized: false,
  sawSocketSnapshot: false,
  tunnelToast: "",
  panelOpened: false,
};

let socket = null;
let saveBusy = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const el = {};

function cacheElements() {
  const ids = [
    "sidebar", "sidebarScrim", "sidebarClose", "brandMark", "livePill", "livePillText",
    "connectionList", "reconnectAllBtn", "statMessages", "statChatters", "statRate",
    "roleBadge", "roleFlag", "menuBtn", "searchInput", "searchClear", "pauseBtn", "soundBtn",
    "pinBtn", "settingsBtn", "navSettings", "navShare", "navPip", "navChat", "statusLights", "statusCopy",
    "filterChips", "visibleCounter", "testBtn", "clearBtn", "chatPanel", "chatScroll", "chatList",
    "emptyState", "emptyIcon", "emptyTitle", "emptyText", "emptyActionBtn", "newMessagesBtn",
    "newMessagesText", "socketState", "settingsLayer", "settingsBody", "saveSettingsBtn",
    "shareLayer", "shareBody", "previewLayer", "previewFrame", "previewOpenLink", "previewTestBtn",
    "previewStage", "toastHost", "updateBanner", "updateTitle", "updateText", "updateDownloadBtn", "updateDismissBtn",
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

function fillStaticIcons() {
  $$("[data-icon]").forEach((node) => {
    node.innerHTML = icon(node.dataset.icon, "icon");
  });
  if (el.brandMark) el.brandMark.innerHTML = icon("chat", "icon");
  if (el.emptyIcon) el.emptyIcon.innerHTML = icon("chat", "icon");
  if (el.sidebarClose) el.sidebarClose.innerHTML = icon("close", "icon");
}

function applyRoleUI() {
  const canManage = state.canManage;
  document.body.classList.toggle("is-guest", !canManage);

  for (const node of [el.navSettings, el.settingsBtn, el.navShare, el.testBtn, el.clearBtn, el.reconnectAllBtn]) {
    if (node) node.hidden = !canManage;
  }

  if (el.roleFlag) el.roleFlag.textContent = canManage ? "LOCAL" : "INVITADO";
  if (el.roleBadge) {
    el.roleBadge.innerHTML = `${icon("lock", "icon")} ${canManage ? "Anfitrión · solo lectura" : "Invitado · solo lectura"}`;
  }
  updateEmptyState();
}

function applySettingsUI() {
  const settings = state.settings;
  if (!settings) return;
  document.body.classList.toggle("hide-times", !settings.ui?.showTimestamps);
  updateEmptyState();
}

function channelText(platform, channel) {
  if (!channel) return "Sin canal";
  if (platform === "tiktok") return channel.toLowerCase() === "tikfinity" ? "TikFinity" : `@${channel}`;
  if (platform === "youtube") return channel.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "");
  return channel;
}

function statusFor(platform) {
  return state.statuses?.[platform] || {
    platform,
    state: "idle",
    message: "Sin iniciar",
    channel: "",
    live: false,
    viewers: 0,
  };
}

function renderConnections() {
  if (!el.connectionList) return;
  const fragment = document.createDocumentFragment();
  for (const platform of PLATFORM_ORDER) {
    const meta = PLATFORM_META[platform];
    const status = statusFor(platform);
    const tone = stateTone(status.state);
    const card = document.createElement("article");
    card.className = `connection-card tone-${tone}`;
    card.style.setProperty("--platform-color", meta.color);
    card.title = status.message || "";

    const avatar = document.createElement("span");
    avatar.className = "platform-avatar";
    avatar.innerHTML = platformIcon(platform, "icon");

    const info = document.createElement("div");
    info.className = "connection-info";

    const top = document.createElement("div");
    top.className = "connection-top";
    const name = document.createElement("span");
    name.className = "connection-name";
    name.textContent = meta.label;
    const channel = document.createElement("span");
    channel.className = "connection-channel";
    channel.textContent = channelText(platform, status.channel);
    top.append(name, channel);

    const bottom = document.createElement("div");
    bottom.className = "connection-bottom";
    const dot = document.createElement("span");
    dot.className = "state-dot";
    const stateLabel = document.createElement("span");
    stateLabel.className = "connection-state";
    stateLabel.textContent = stateText(status.state, status.live);
    bottom.append(dot, stateLabel);

    if (Number(status.viewers) > 0) {
      const viewers = document.createElement("span");
      viewers.className = "connection-viewers";
      viewers.textContent = formatNumber(status.viewers);
      viewers.title = "Espectadores";
      bottom.append(viewers);
    }

    info.append(top, bottom);
    card.append(avatar, info);

    if (state.canManage) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "connection-reconnect";
      button.dataset.platform = platform;
      button.title = `Reconectar ${meta.label}`;
      button.setAttribute("aria-label", `Reconectar ${meta.label}`);
      button.innerHTML = icon("refresh", "icon");
      card.append(button);
    }

    fragment.append(card);
  }
  el.connectionList.replaceChildren(fragment);
}

function renderStatusBar() {
  if (!el.statusLights || !el.statusCopy) return;
  const fragment = document.createDocumentFragment();
  const parts = [];
  let connected = 0;
  let live = 0;
  let waiting = 0;
  let configured = 0;

  for (const platform of PLATFORM_ORDER) {
    const meta = PLATFORM_META[platform];
    const status = statusFor(platform);
    const light = document.createElement("span");
    light.className = "status-light";
    light.style.setProperty("--platform-color", meta.color);
    light.title = `${meta.label}: ${stateText(status.state, status.live)}`;
    if (status.state === "connected") {
      light.classList.add("is-on");
      connected += 1;
      if (status.live) live += 1;
      configured += 1;
    } else if (["connecting", "reconnecting"].includes(status.state)) {
      light.classList.add("is-waiting");
      waiting += 1;
      configured += 1;
    } else if (status.state !== "disabled") {
      configured += 1;
    }
    fragment.append(light);

    if (status.state === "disabled") continue;
    if (status.state === "connected") {
      parts.push(status.live ? `${meta.label} en directo` : `${meta.label} conectado`);
    } else if (status.state === "connecting" || status.state === "reconnecting") {
      parts.push(`${meta.label} ${status.state === "connecting" ? "conectando" : "reconectando"}`);
    } else if (status.state === "error") {
      parts.push(`${meta.label} con error`);
    } else if (status.state === "offline") {
      parts.push(`${meta.label} sin directo`);
    }
  }

  el.statusLights.replaceChildren(fragment);
  el.statusCopy.textContent = parts.length
    ? parts.join(" · ")
    : configured === 0
      ? "Configura tus canales para empezar"
      : "Esperando conexiones…";

  if (el.livePill && el.livePillText) {
    el.livePill.classList.toggle("is-live", live > 0);
    el.livePillText.textContent =
      live > 0
        ? `${live} plataforma${live === 1 ? "" : "s"} en directo`
        : connected > 0
          ? `${connected} plataforma${connected === 1 ? "" : "s"} conectada${connected === 1 ? "" : "s"}`
          : waiting > 0
            ? "Conectando…"
            : configured > 0
              ? "Sin conexiones activas"
              : "Sin canales configurados";
  }
}

function renderFilterChips() {
  if (!el.filterChips) return;
  const stats = state.stats || {};
  const chips = [
    { key: "all", label: "Todos", color: "#8b5cf6", icon: "activity", count: stats.total || 0 },
    ...PLATFORM_ORDER.map((platform) => ({
      key: platform,
      label: PLATFORM_META[platform].label,
      color: PLATFORM_META[platform].color,
      icon: PLATFORM_META[platform].icon,
      count: stats.perPlatform?.[platform] || 0,
    })),
  ];
  const fragment = document.createDocumentFragment();
  for (const chip of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${state.filter === chip.key ? " is-active" : ""}`;
    button.dataset.filter = chip.key;
    button.style.setProperty("--platform-color", chip.color);
    const mark = chip.key === "all" ? icon(chip.icon, "icon") : platformIcon(chip.key, "icon");
    button.innerHTML = `${mark}<span>${chip.label}</span><span class="chip-count">${formatNumber(chip.count)}</span>`;
    fragment.append(button);
  }
  el.filterChips.replaceChildren(fragment);
}

function updateChipCounts() {
  if (!el.filterChips) return;
  const stats = state.stats || {};
  $$(".chip[data-filter]", el.filterChips).forEach((chip) => {
    const key = chip.dataset.filter;
    const count = key === "all" ? stats.total || 0 : stats.perPlatform?.[key] || 0;
    const target = $(".chip-count", chip);
    if (target) target.textContent = formatNumber(count);
  });
}

function updateStats(stats) {
  if (stats) state.stats = stats;
  const current = state.stats || {};
  if (el.statMessages) el.statMessages.textContent = formatNumber(current.total || 0);
  if (el.statChatters) el.statChatters.textContent = formatNumber(current.uniqueChatters || 0);
  if (el.statRate) el.statRate.textContent = formatNumber(current.messagesPerMinute || 0);
  updateChipCounts();
}

function normalizeForSearch(value) {
  return String(value ?? "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function messageMatches(message) {
  if (state.filter !== "all" && message.platform !== state.filter) return false;
  const term = normalizeForSearch(state.search.trim());
  if (!term) return true;
  return normalizeForSearch(`${message.name} ${message.user} ${message.text} ${message.platform}`).includes(term);
}

function createMessageNode(message, { instant = false } = {}) {
  const meta = PLATFORM_META[message.platform] || PLATFORM_META.twitch;
  const article = document.createElement("article");
  article.className = "message";
  if (instant) article.classList.add("is-instant");
  if (message.action) article.classList.add("is-action");
  if (message.meta?.superchat) article.classList.add("has-superchat");
  if (message.host) article.classList.add("is-host");
  article.dataset.id = message.id;
  article.dataset.platform = message.platform;
  article.style.setProperty("--platform-color", meta.color);
  article.style.setProperty("--user-color", safeColor(message.color, message.user || message.name));

  const rail = document.createElement("span");
  rail.className = "message-rail";
  rail.setAttribute("aria-hidden", "true");

  const main = document.createElement("div");
  main.className = "message-main";

  const metaRow = document.createElement("div");
  metaRow.className = "message-meta";

  const platformMark = document.createElement("span");
  platformMark.className = "platform-mark";
  platformMark.title = meta.label;
  platformMark.setAttribute("aria-label", meta.label);
  platformMark.innerHTML = platformIcon(message.platform, "icon");
  metaRow.append(platformMark);

  const name = document.createElement("span");
  name.className = "message-name";
  name.textContent = message.name;
  metaRow.append(name);

  if (Array.isArray(message.badges) && message.badges.length) {
    const badges = document.createElement("span");
    badges.className = "badges";
    for (const badge of message.badges) {
      const badgeEl = document.createElement("span");
      badgeEl.className = `badge badge-${badge}`;
      badgeEl.textContent = badgeLabel(badge);
      badgeEl.title = badge;
      badges.append(badgeEl);
    }
    metaRow.append(badges);
  }

  if (message.test) {
    const testBadge = document.createElement("span");
    testBadge.className = "badge badge-test";
    testBadge.textContent = "PRUEBA";
    metaRow.append(testBadge);
  }

  if (message.host) {
    const hostBadge = document.createElement("span");
    hostBadge.className = "badge badge-local";
    hostBadge.textContent = "LOCAL";
    metaRow.append(hostBadge);
  }

  if (message.meta?.superchat?.amount) {
    const amount = document.createElement("span");
    amount.className = "superchat-amount";
    amount.textContent = message.meta.superchat.amount;
    metaRow.append(amount);
  }

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.timestamp);
  metaRow.append(time);

  const text = document.createElement("div");
  text.className = "message-text";
  renderParts(text, message.parts);

  main.append(metaRow, text);
  article.append(rail, main);
  return article;
}

function appendMessage(message, options = {}) {
  const node = createMessageNode(message, options);
  el.chatList.append(node);
  while (el.chatList.children.length > MAX_MESSAGES) {
    el.chatList.firstElementChild?.remove();
  }
  state.visibleCount = el.chatList.children.length;
}

function updateVisibleCounter() {
  if (el.visibleCounter) {
    el.visibleCounter.textContent = `${state.visibleCount} mensaje${state.visibleCount === 1 ? "" : "s"}`;
  }
}

function renderAllMessages({ instant = true, scroll = true } = {}) {
  if (!el.chatList) return;
  el.chatList.replaceChildren();
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const message of state.messages) {
    if (!messageMatches(message)) continue;
    fragment.append(createMessageNode(message, { instant }));
    count += 1;
  }
  el.chatList.append(fragment);
  state.visibleCount = count;
  updateVisibleCounter();
  updateEmptyState();
  if (scroll && !state.paused) {
    requestAnimationFrame(() => {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    });
  }
}

function isNearBottom() {
  if (!el.chatScroll) return true;
  return el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 140;
}

function scrollToBottom(behavior = "smooth") {
  if (!el.chatScroll) return;
  el.chatScroll.scrollTo({ top: el.chatScroll.scrollHeight, behavior });
  state.newCount = 0;
  updateNewButton();
}

function updateEmptyState() {
  if (!el.emptyState) return;
  const hasMessages = state.visibleCount > 0;
  el.emptyState.hidden = hasMessages;
  if (hasMessages) return;

  const hasChannels = Object.values(state.settings?.channels || {}).some(Boolean);
  const hasFilter = state.filter !== "all" || Boolean(state.search.trim());
  const hasAnyMessages = state.messages.length > 0;

  let action = "settings";
  let title = "El chat está esperando";
  let text = "Configura tus canales para empezar. Los mensajes de Twitch, Kick, YouTube y TikTok aparecerán aquí, en orden.";
  let actionLabel = "Configurar canales";

  if (state.paused) {
    const pending = state.buffer.filter(messageMatches).length;
    action = "resume";
    actionLabel = "Reanudar chat";
    title = "Chat en pausa";
    text = pending
      ? `${pending} mensaje${pending === 1 ? "" : "s"} esperando. Reanuda para verlos.`
      : "El chat está pausado. Los mensajes nuevos se guardarán aquí.";
  } else if (hasFilter && hasAnyMessages) {
    action = "filters";
    actionLabel = "Quitar filtros";
    title = "Sin coincidencias";
    text = "Prueba con otro término de búsqueda o quita los filtros de plataforma.";
  } else if (!hasChannels) {
    action = state.canManage ? "settings" : "none";
    actionLabel = "Configurar canales";
    title = "El chat está esperando";
    text = state.canManage
      ? "Configura tus canales para empezar. Los mensajes de Twitch, Kick, YouTube y TikTok aparecerán aquí, en orden."
      : "El anfitrión todavía no ha configurado canales. Este enlace es de solo lectura.";
  } else {
    action = state.canManage ? "test" : "none";
    actionLabel = "Enviar mensajes de prueba";
    title = "Todo listo por aquí";
    text = "No hay mensajes todavía. En cuanto alguien escriba en Twitch, Kick, YouTube o TikTok aparecerá aquí.";
  }

  state.emptyAction = action;
  el.emptyTitle.textContent = title;
  el.emptyText.textContent = text;
  el.emptyActionBtn.textContent = actionLabel;
  el.emptyActionBtn.hidden = action === "none";
}

function updateNewButton() {
  if (!el.newMessagesBtn || !el.newMessagesText) return;
  el.newMessagesBtn.hidden = state.newCount <= 0;
  el.newMessagesText.textContent =
    state.newCount === 1 ? "1 mensaje nuevo" : `${state.newCount} mensajes nuevos`;
}

function flushBuffer() {
  if (!state.buffer.length) return;
  const buffered = state.buffer;
  state.buffer = [];
  for (const message of buffered) {
    state.messages.push(message);
    if (state.messages.length > MAX_MESSAGES) state.messages.shift();
    if (messageMatches(message)) appendMessage(message);
  }
  state.newCount = 0;
  updateNewButton();
  updateVisibleCounter();
  updateEmptyState();
  scrollToBottom("smooth");
}

function updatePauseButton() {
  if (!el.pauseBtn) return;
  el.pauseBtn.classList.toggle("is-active", state.paused);
  el.pauseBtn.innerHTML = icon(state.paused ? "play" : "pause", "icon");
  el.pauseBtn.title = state.paused ? "Reanudar el chat" : "Pausar el chat";
  el.pauseBtn.setAttribute("aria-label", el.pauseBtn.title);
  el.pauseBtn.setAttribute("aria-pressed", String(state.paused));
}

function updateSoundButton() {
  if (!el.soundBtn) return;
  el.soundBtn.classList.toggle("is-active", state.sound);
  el.soundBtn.innerHTML = icon(state.sound ? "volume" : "mute", "icon");
  el.soundBtn.title = state.sound ? "Silenciar notificaciones" : "Activar sonido";
  el.soundBtn.setAttribute("aria-label", el.soundBtn.title);
  el.soundBtn.setAttribute("aria-pressed", String(state.sound));
}

function updatePinButton(pinned) {
  if (!el.pinBtn) return;
  el.pinBtn.classList.toggle("is-active", Boolean(pinned));
  el.pinBtn.setAttribute("aria-pressed", String(Boolean(pinned)));
  el.pinBtn.title = pinned ? "Quitar siempre encima" : "Mantener la app encima de otras ventanas";
  el.pinBtn.setAttribute("aria-label", el.pinBtn.title);
}

function ensureAudio() {
  if (state.audio) {
    if (state.audio.state === "suspended") state.audio.resume().catch(() => {});
    return state.audio;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    state.audio = new AudioContextClass();
    return state.audio;
  } catch {
    return null;
  }
}

function playNotification() {
  const nowMs = Date.now();
  if (nowMs - state.lastSoundAt < 160) return;
  state.lastSoundAt = nowMs;
  const audio = ensureAudio();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(640, now);
    oscillator.frequency.exponentialRampToValueAtTime(860, now + 0.055);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.028, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.18);
  } catch {
    // sin sonido
  }
}

function handleIncomingMessage(message, stats) {
  if (!message) return;
  if (stats) updateStats(stats);

  if (state.paused) {
    state.buffer.push(message);
    if (state.buffer.length > MAX_MESSAGES) state.buffer.shift();
    if (messageMatches(message)) {
      state.newCount += 1;
      updateNewButton();
    }
    updateEmptyState();
    return;
  }

  state.messages.push(message);
  if (state.messages.length > MAX_MESSAGES) state.messages.shift();

  if (!messageMatches(message)) return;

  const nearBottom = isNearBottom();
  appendMessage(message);
  updateVisibleCounter();
  updateEmptyState();

  if (nearBottom) {
    scrollToBottom("auto");
  } else {
    state.newCount += 1;
    updateNewButton();
  }

  if (state.sound && document.visibilityState === "visible") playNotification();
}

function applySnapshot(data) {
  if (!data) return;
  state.sawSocketSnapshot = true;
  state.messages = Array.isArray(data.messages) ? data.messages.slice(-MAX_MESSAGES) : [];
  state.statuses = data.statuses || state.statuses;
  state.stats = data.stats || state.stats;
  state.settings = data.settings || state.settings;
  state.share = data.share || state.share;
  state.canManage = Boolean(data.canManage);
  state.buffer = [];
  state.newCount = 0;
  state.initialized = true;
  applyRoleUI();
  applySettingsUI();
  renderConnections();
  renderStatusBar();
  renderFilterChips();
  updateStats();
  renderAllMessages({ instant: true, scroll: !state.paused });
  updatePauseButton();
  setSocketOnline(true);
  openRequestedPanel();
}

function applyInfo(data) {
  if (!data?.ok) return;
  state.canManage = Boolean(data.canManage);
  state.settings = data.settings || state.settings;
  state.share = data.share || state.share;
  state.statuses = data.statuses || state.statuses;
  state.stats = data.stats || state.stats;
  applyRoleUI();
  applySettingsUI();
  renderConnections();
  renderStatusBar();
  renderFilterChips();
  updateStats();
  updateEmptyState();
  if (!state.initialized) renderAllMessages({ instant: true });
  openRequestedPanel();
}

function setSocketOnline(online) {
  state.socketOnline = online;
  if (!el.socketState) return;
  el.socketState.classList.toggle("is-offline", !online);
  el.socketState.innerHTML = `<span class="dot"></span> ${online ? "Conectado al servidor" : "Reconectando al servidor…"}`;
}

function openRequestedPanel() {
  if (state.panelOpened) return;
  const panel = new URLSearchParams(location.search).get("panel");
  if (!panel) return;
  if (panel === "preview") {
    state.panelOpened = true;
    openPreview();
    return;
  }
  if (!state.canManage) return;
  state.panelOpened = true;
  if (panel === "settings") openSettings();
  else if (panel === "share") openShare();
}

function setShareTunnel(tunnel) {
  if (!tunnel) return;
  if (!state.share) state.share = {};
  const previous = state.share.tunnel?.status;
  state.share.tunnel = tunnel;

  if (state.canManage) {
    if (tunnel.status === "running" && previous !== "running" && state.tunnelToast !== tunnel.url) {
      state.tunnelToast = tunnel.url;
      toast("Enlace público listo. Cualquiera con el enlace puede leer el chat.", "success", 5000);
    }
    if (tunnel.status === "error" && previous !== "error") {
      toast(tunnel.error || "No se pudo crear el enlace público.", "error", 6000);
    }
  }

  if (!el.shareLayer?.hidden) renderShare();
}

function renderShare() {
  if (!el.shareBody) return;
  const share = state.share || {};
  const overlayUrl = share.overlayUrl || `${location.origin}/overlay`;
  const localUrl = share.localUrl || `${location.origin}/`;
  const lanUrl = share.primaryLanUrl || "";
  const tunnel = share.tunnel || { status: "idle", message: "Túnel desactivado" };
  const running = tunnel.status === "running" && tunnel.url;
  const working = ["preparing", "downloading", "starting"].includes(tunnel.status);
  const errored = tunnel.status === "error";

  const qr = (url, label) =>
    url
      ? `<div class="share-qr" title="${escapeHtml(label)}"><img src="/api/qr?url=${encodeURIComponent(url)}&size=190" alt="Código QR para ${escapeHtml(label)}" loading="lazy" /></div>`
      : "";

  const copyButton = (id, label) => `
    <button class="copy-btn" type="button" data-action="copy" data-copy="${id}" title="Copiar" aria-label="Copiar ${escapeHtml(label)}">
      ${icon("copy", "icon")}
    </button>`;

  const tunnelStatus = (() => {
    if (running) {
      return `<div class="tunnel-status is-running"><span class="state-dot"></span><span>Enlace público activo. Es de solo lectura: tus amigos no pueden cambiar ajustes.</span></div>`;
    }
    if (errored) {
      return `<div class="tunnel-status is-error"><span class="state-dot"></span><span><strong>No se pudo crear el enlace.</strong> ${escapeHtml(tunnel.error || tunnel.message || "")}</span></div>`;
    }
    if (working) {
      const percent = Number(tunnel.progress);
      return `<div class="tunnel-status"><span class="state-dot"></span><span>${escapeHtml(tunnel.message || "Preparando enlace…")}</span></div>
        ${Number.isFinite(percent) ? `<div class="progress-track"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>` : ""}`;
    }
    return `<div class="tunnel-status"><span class="state-dot"></span><span>${escapeHtml(tunnel.message || "Sin enlace público.")}</span></div>`;
  })();

  const tunnelButtons = (() => {
    if (running) {
      return `<div class="share-actions">
        <a class="btn btn-ghost" href="${escapeHtml(tunnel.url)}" target="_blank" rel="noopener">${icon("external", "icon")} Abrir</a>
        <button class="btn btn-danger" type="button" data-action="tunnel-stop">${icon("close", "icon")} Cerrar enlace</button>
      </div>`;
    }
    if (working) {
      return `<div class="share-actions"><button class="btn btn-ghost" type="button" data-action="tunnel-stop">${icon("close", "icon")} Cancelar</button></div>`;
    }
    return `<div class="share-actions"><button class="btn btn-primary" type="button" data-action="tunnel-start">${icon("cloud", "icon")} ${errored ? "Reintentar" : "Crear enlace público"}</button></div>`;
  })();

  el.shareBody.innerHTML = `
    <div class="share-grid">
      <section class="share-card">
        <div class="share-head">
          <span class="share-head-icon">${icon("wifi", "icon")}</span>
          <div><h3>Misma Wi-Fi</h3><p>Ideal si tus amigos están en casa o en la misma red.</p></div>
        </div>
        ${
          lanUrl
            ? `<div class="qr-layout">
                ${qr(lanUrl, "enlace Wi-Fi")}
                <div class="qr-copy">
                  <div class="link-row"><code id="copy-lan">${escapeHtml(lanUrl)}</code>${copyButton("copy-lan", "enlace Wi-Fi")}</div>
                  <div class="share-note">Escanea el QR o comparte el enlace. Permite abrir el chat desde el móvil.</div>
                </div>
              </div>`
            : `<div class="share-note">No se detectó una red local. Conecta este PC a Wi-Fi o Ethernet y reinicia la app.</div>`
        }
        <div class="link-row"><code id="copy-local">${escapeHtml(localUrl)}</code>${copyButton("copy-local", "enlace local")}</div>
        <div class="share-note">Tu PC debe seguir encendido y con StreamChat Hub abierto.</div>
      </section>

      <section class="share-card">
        <div class="share-head">
          <span class="share-head-icon cyan">${icon("monitor", "icon")}</span>
          <div><h3>Overlay para OBS</h3><p>Fondo transparente, pensado para Browser Source.</p></div>
        </div>
        <div class="link-row"><code id="copy-overlay">${escapeHtml(overlayUrl)}</code>${copyButton("copy-overlay", "URL del overlay")}</div>
        <div class="share-actions">
          <button class="btn btn-primary" type="button" data-action="copy-obs">${icon("copy", "icon")} Copiar URL para OBS</button>
          <a class="btn btn-ghost" href="/overlay" target="_blank" rel="noopener">${icon("external", "icon")} Abrir</a>
          <button class="btn btn-ghost" type="button" data-action="preview">${icon("eye", "icon")} Vista previa</button>
        </div>
        <div class="share-note">En OBS: <strong>Fuentes → Navegador</strong>, 1920×1080, marca “Cerrar navegador al cerrar la fuente”.</div>
      </section>

      <section class="share-card full">
        <div class="share-head">
          <span class="share-head-icon green">${icon("globe", "icon")}</span>
          <div><h3>Amigos en cualquier lugar</h3><p>Crea un enlace público temporal con Cloudflare Tunnel, sin abrir puertos ni tocar el router.</p></div>
        </div>
        ${tunnelStatus}
        ${running ? `<div class="qr-layout"><div class="qr-copy"><div class="link-row"><code id="copy-tunnel">${escapeHtml(tunnel.url)}</code>${copyButton("copy-tunnel", "enlace público")}</div><div class="share-note">Comparte este enlace con quien quieras. Es público mientras el túnel esté activo.</div></div>${qr(tunnel.url, "enlace público")}</div>` : ""}
        ${tunnelButtons}
        <div class="share-note">El túnel solo expone este chat en modo lectura. La configuración sigue bloqueada para invitados.</div>
      </section>

      <section class="share-card">
        <div class="share-head">
          <span class="share-head-icon amber">${icon("pip", "icon")}</span>
          <div><h3>Overlay flotante</h3><p>Para leer el chat mientras juegas en una sola pantalla.</p></div>
        </div>
        <div class="share-note">Abre el chat en una capa flotante encima de otras ventanas. <strong>Ctrl+Alt+O</strong> lo muestra u oculta; <strong>Ctrl+Alt+E</strong> permite moverlo y cambiar su tamaño. <strong>F8</strong> escribe un mensaje local.</div>
        <div class="share-actions">
          <button class="btn btn-primary" type="button" data-action="pip">${icon("pip", "icon")} Abrir overlay flotante</button>
        </div>
      </section>

      <section class="share-card">
        <div class="share-head">
          <span class="share-head-icon">${icon("monitor", "icon")}</span>
          <div><h3>Overlay sobre el juego</h3><p>Usa la app de referencia Transparent Twitch Chat Overlay con URL personalizada.</p></div>
        </div>
        <div class="share-note">Añade una ventana <strong>Custom URL</strong> en TTC Overlay y pega:</div>
        <div class="link-row"><code id="copy-ttc">${escapeHtml(overlayUrl)}</code>${copyButton("copy-ttc", "URL para TTC Overlay")}</div>
        <div class="share-actions">
          <a class="btn btn-ghost" href="https://github.com/baffler/Transparent-Twitch-Chat-Overlay/releases/latest" target="_blank" rel="noopener noreferrer">${icon("download", "icon")} Descargar TTC Overlay</a>
        </div>
      </section>
    </div>`;

  el.shareBody.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      copyText(target.textContent).then((ok) => {
        toast(ok ? "Enlace copiado." : "No se pudo copiar. Selecciona el enlace manualmente.", ok ? "success" : "error");
      });
    });
  });
}

async function startTunnel() {
  if (!state.canManage) return;
  if (!state.share) state.share = {};
  state.share.tunnel = { status: "preparing", message: "Preparando enlace público…" };
  renderShare();
  try {
    const data = await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "tunnelStart" }),
    });
    if (data.tunnel) setShareTunnel(data.tunnel);
  } catch (error) {
    toast(error.message, "error");
    state.share.tunnel = { status: "error", error: error.message, message: "No se pudo iniciar." };
    renderShare();
  }
}

async function stopTunnel() {
  if (!state.canManage) return;
  try {
    const data = await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "tunnelStop" }),
    });
    if (data.tunnel) setShareTunnel(data.tunnel);
    toast("Enlace público cerrado.", "info");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openShare() {
  if (!state.canManage) {
    toast("Solo el anfitrión puede gestionar los enlaces para compartir.", "warning");
    return;
  }
  if (!state.share) {
    api("/api/info")
      .then((data) => {
        state.share = data.share || null;
        renderShare();
      })
      .catch(() => {});
  }
  renderShare();
  showLayer(el.shareLayer);
}

function renderSettings() {
  if (!el.settingsBody) return;
  const settings = state.settings || {};
  const channels = settings.channels || {};
  const overlay = settings.overlay || {};
  const filters = settings.filters || {};
  const kick = settings.kick || {};
  const ui = settings.ui || {};
  const events = settings.tiktok?.events || {};

  const section = (platform) => {
    const meta = PLATFORM_META[platform];
    const status = statusFor(platform);
    const value = channels[platform] || "";
    const isTikFinity = settings.tiktok?.source === "tikfinity";
    let extra = "";

    if (platform === "kick") {
      extra = `
        <details class="advanced">
          <summary>IDs manuales (solo si Kick bloquea la detección)</summary>
          <div class="form-grid">
            <div class="field">
              <label for="kick-channel-id">Channel ID</label>
              <input id="kick-channel-id" type="number" min="0" step="1" value="${Number(kick.channelId) || 0}" />
            </div>
            <div class="field">
              <label for="kick-chatroom-id">Chatroom ID</label>
              <input id="kick-chatroom-id" type="number" min="0" step="1" value="${Number(kick.chatroomId) || 0}" />
            </div>
          </div>
          <p class="hint">Déjalos en 0 para detectarlos automáticamente. Solo hacen falta si la API de Kick responde 403.</p>
          <div class="share-actions">
            <button class="btn btn-ghost" type="button" data-action="open-kick-api">${icon("external", "icon")} Ver IDs de este canal</button>
          </div>
          <p class="hint">Abre la API en el navegador, resuelve el reto de Cloudflare si aparece y copia <code>id</code> y <code>chatroom.id</code>.</p>
        </details>`;
    }

    if (platform === "tiktok") {
      extra = `
        <details class="advanced">
          <summary>Clave de firma de Euler Stream (opcional)</summary>
          <div class="field full">
            <label for="tiktok-key">Sign API key</label>
            <input id="tiktok-key" type="password" autocomplete="off" placeholder="${settings.tiktokKeySet ? "Ya hay una clave guardada · deja vacío para mantenerla" : "Opcional · ayuda si TikTok limita la conexión"}" />
            <span class="hint">Se guarda solo en este PC. Si se repite un error de firma o límite, crea una clave en eulerstream.com.</span>
          </div>
          <label class="check-line"><input id="clear-tiktok-key" type="checkbox" /> Borrar la clave guardada</label>
        </details>`;
    }

    const descriptions = {
      twitch: "Lectura anónima del IRC, sin iniciar sesión.",
      kick: "Se detecta el canal automáticamente. Solo lectura.",
      youtube: "Acepta @handle, URL del directo o ID del vídeo.",
      tiktok: "Conexión directa o a través de TikFinity. Solo lectura.",
    };
    const placeholders = {
      twitch: "ej. lofigirl",
      kick: "ej. xqc",
      youtube: "ej. @LofiGirl o https://youtube.com/watch?v=…",
      tiktok: "ej. tuusuario (sin @)",
    };

    const sourceFields = platform === "tiktok" ? `
      <div class="field">
        <label for="tiktok-source">Fuente de TikTok</label>
        <select id="tiktok-source">
          <option value="direct" ${!isTikFinity ? "selected" : ""}>Conexión directa</option>
          <option value="tikfinity" ${isTikFinity ? "selected" : ""}>TikFinity (API local)</option>
        </select>
        <span class="hint">Usa TikFinity si ya lo tienes abierto y conectado a tu directo.</span>
      </div>
      <div class="field">
        <label for="tikfinity-url">URL de TikFinity</label>
        <input id="tikfinity-url" type="text" value="${escapeHtml(settings.tikfinity?.url || "ws://localhost:21213/")}" placeholder="ws://localhost:21213/" spellcheck="false" />
        <span class="hint">Por defecto, la API local de TikFinity Desktop.</span>
      </div>` : "";

    return `
      <section class="settings-section">
        <div class="section-head">
          <div class="platform-avatar" style="--platform-color:${meta.color}">${platformIcon(platform, "icon")}</div>
          <div class="section-title"><h3>${meta.label}</h3><p>${descriptions[platform]}</p></div>
          <span class="section-status"><span class="state-pill tone-${stateTone(status.state)}" title="${escapeHtml(status.message || "")}"><span class="state-dot"></span>${stateText(status.state, status.live)}</span></span>
        </div>
        <div class="form-grid">
          ${sourceFields}
          <div class="field full">
            <label for="channel-${platform}">${platform === "tiktok" ? "Canal de TikTok (solo conexión directa)" : "Canal"}</label>
            <input id="channel-${platform}" data-channel="${platform}" type="text" value="${escapeHtml(value)}" placeholder="${placeholders[platform]}" spellcheck="false" />
            <span class="hint">${platform === "youtube" ? "Si pones @canal se busca el directo actual y se actualiza solo." : platform === "tiktok" ? "Si usas TikFinity, este campo no es necesario." : "Puedes pegar la URL completa; se limpia automáticamente."}</span>
          </div>
        </div>
        ${platform === "tiktok" ? `<div class="settings-note">${icon("link", "icon")}<span>Abre <strong>TikFinity Desktop</strong> en este PC, conecta tu directo y deja activa su API local. La URL por defecto es <code>ws://localhost:21213/</code>. Si TikFinity usa otro puerto, cámbiala aquí.</span></div>` : ""}
        ${extra}
      </section>`;
  };

  el.settingsBody.innerHTML = `
    <div class="settings-note">
      ${icon("info", "icon")}
      <span>StreamChat Hub nunca envía mensajes ni pide contraseñas. Twitch y Kick se leen de forma anónima; YouTube y TikTok usan sus APIs internas.</span>
    </div>

    ${PLATFORM_ORDER.map(section).join("")}

    <section class="settings-section">
      <div class="section-head">
        <div class="platform-avatar" style="--platform-color:#25f4ee">${platformIcon("tiktok", "icon")}</div>
        <div class="section-title"><h3>Avisos de TikTok</h3><p>Eventos simples en el overlay flotante y en el overlay de OBS.</p></div>
      </div>
      <div class="switch-grid">
        <label class="switch-field">
          <span><strong>Entradas al directo</strong><small>Cuando alguien se une</small></span>
          <input id="tiktok-event-joins" type="checkbox" ${events.joins !== false ? "checked" : ""} />
          <span class="switch"></span>
        </label>
        <label class="switch-field">
          <span><strong>Regalos y donaciones</strong><small>Cuando alguien envía un regalo</small></span>
          <input id="tiktok-event-gifts" type="checkbox" ${events.gifts !== false ? "checked" : ""} />
          <span class="switch"></span>
        </label>
        <label class="switch-field">
          <span><strong>Compartidos</strong><small>Cuando comparten tu directo</small></span>
          <input id="tiktok-event-shares" type="checkbox" ${events.shares !== false ? "checked" : ""} />
          <span class="switch"></span>
        </label>
        <label class="switch-field">
          <span><strong>Nuevos seguidores</strong><small>Cuando empiezan a seguirte</small></span>
          <input id="tiktok-event-follows" type="checkbox" ${events.follows !== false ? "checked" : ""} />
          <span class="switch"></span>
        </label>
        <label class="switch-field">
          <span><strong>Suscripciones</strong><small>Cuando alguien se suscribe</small></span>
          <input id="tiktok-event-subscribes" type="checkbox" ${events.subscribes !== false ? "checked" : ""} />
          <span class="switch"></span>
        </label>
        <label class="switch-field">
          <span><strong>Me gusta</strong><small>Puede ser muy frecuente</small></span>
          <input id="tiktok-event-likes" type="checkbox" ${events.likes === true ? "checked" : ""} />
          <span class="switch"></span>
        </label>
      </div>
      <div class="settings-note">
        ${icon("info", "icon")}
        <span>Los avisos aparecen como tarjetas simples encima del chat. Desactiva los que no quieras ver. No modifican el chat ni envían nada a TikTok.</span>
      </div>
      <div class="share-actions">
        <button class="btn btn-ghost" type="button" data-action="test-notifications">${icon("sparkles", "icon")} Probar avisos</button>
      </div>
    </section>

    <section class="settings-section">
      <div class="section-head">
        <div class="platform-avatar" style="--platform-color:#8b5cf6">${icon("settings", "icon")}</div>
        <div class="section-title"><h3>Filtros y comportamiento</h3><p>Controla lo que aparece en el chat unificado.</p></div>
      </div>
      <div class="form-grid">
        <div class="field full">
          <label for="blocked-users">Usuarios bloqueados</label>
          <textarea id="blocked-users" placeholder="Nombre1, Nombre2…">${escapeHtml((filters.blockedUsers || []).join(", "))}</textarea>
          <span class="hint">Separa los nombres con comas. Se ocultan sus mensajes en todas las plataformas.</span>
        </div>
        <div class="field">
          <label for="max-message-length">Largo máximo del mensaje</label>
          <input id="max-message-length" type="number" min="50" max="1000" step="10" value="${Number(filters.maxMessageLength) || 300}" />
        </div>
        <div class="switch-grid">
          <label class="switch-field">
            <span><strong>Ocultar comandos</strong><small>Ignora mensajes que empiezan por !</small></span>
            <input id="ignore-commands" type="checkbox" ${filters.ignoreCommands !== false ? "checked" : ""} />
            <span class="switch"></span>
          </label>
          <label class="switch-field">
            <span><strong>Mostrar hora</strong><small>Hora de cada mensaje en el chat</small></span>
            <input id="show-timestamps" type="checkbox" ${ui.showTimestamps !== false ? "checked" : ""} />
            <span class="switch"></span>
          </label>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div class="section-head">
        <div class="platform-avatar" style="--platform-color:#22d3ee">${icon("monitor", "icon")}</div>
        <div class="section-title"><h3>Overlay y OBS</h3><p>El estilo se aplica a /overlay y a la vista previa.</p></div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="overlay-max-messages">Máx. mensajes</label>
          <input id="overlay-max-messages" type="number" min="1" max="50" step="1" value="${Number(overlay.maxMessages) || 12}" />
          <span class="hint">OBS usa 50 por defecto para no borrar el historial.</span>
        </div>
        <div class="field">
          <label for="overlay-font-size">Tamaño de letra (px)</label>
          <input id="overlay-font-size" type="number" min="10" max="48" step="1" value="${Number(overlay.fontSize) || 18}" />
        </div>
        <div class="field">
          <label for="overlay-width">Ancho máximo (px)</label>
          <input id="overlay-width" type="number" min="240" max="900" step="10" value="${Number(overlay.width) || 440}" />
        </div>
        <div class="field">
          <label for="overlay-lifetime">Duración en pantalla (s)</label>
          <input id="overlay-lifetime" type="number" min="5" max="300" step="5" value="${Number(overlay.lifetimeSeconds) || 30}" />
          <span class="hint">Solo afecta a la ventana flotante. El overlay de OBS no se desvanece.</span>
        </div>
        <div class="field">
          <label for="overlay-anchor">Posición</label>
          <select id="overlay-anchor">
            <option value="bottom-left" ${overlay.anchor === "bottom-left" ? "selected" : ""}>Abajo izquierda</option>
            <option value="bottom-right" ${overlay.anchor === "bottom-right" ? "selected" : ""}>Abajo derecha</option>
            <option value="top-left" ${overlay.anchor === "top-left" ? "selected" : ""}>Arriba izquierda</option>
            <option value="top-right" ${overlay.anchor === "top-right" ? "selected" : ""}>Arriba derecha</option>
          </select>
        </div>
        <div class="range-field">
          <div class="range-head"><span>Fondo de los mensajes</span><output id="overlay-opacity-value">${Math.round((Number(overlay.backgroundOpacity) || 0) * 100)}%</output></div>
          <input id="overlay-opacity" type="range" min="0" max="1" step="0.02" value="${Number(overlay.backgroundOpacity) || 0}" />
        </div>
        <div class="switch-grid full">
          <label class="switch-field">
            <span><strong>Icono de plataforma</strong><small>Muestra el logo junto al nombre</small></span>
            <input id="overlay-platform" type="checkbox" ${overlay.showPlatform !== false ? "checked" : ""} />
            <span class="switch"></span>
          </label>
          <label class="switch-field">
            <span><strong>Insignias</strong><small>MOD, SUB, VIP, etc.</small></span>
            <input id="overlay-badges" type="checkbox" ${overlay.showBadges !== false ? "checked" : ""} />
            <span class="switch"></span>
          </label>
          <label class="switch-field">
            <span><strong>Espectadores totales</strong><small>Suma los espectadores de todas las plataformas conectadas</small></span>
            <input id="overlay-viewers" type="checkbox" ${overlay.showViewers !== false ? "checked" : ""} />
            <span class="switch"></span>
          </label>
        </div>
      </div>
      <div class="share-actions">
        <button class="btn btn-ghost" type="button" data-action="open-preview">${icon("eye", "icon")} Vista previa del overlay</button>
      </div>
    </section>

    <section class="settings-section subtle">
      <div class="settings-note warn">
        ${icon("warning", "icon")}
        <span>TikTok es un protocolo no oficial y puede cambiar. Si falla, comprueba que el usuario está en directo. La clave de Euler Stream es opcional y solo se guarda en este PC.</span>
      </div>
      <div class="settings-note">
        ${icon("lock", "icon")}
        <span>La app es de solo lectura. Para escribir en el chat usa la plataforma original. Si compartes el enlace público, tus amigos tampoco podrán tocar la configuración.</span>
      </div>
    </section>`;

  el.settingsBody.querySelectorAll("[data-action='open-preview']").forEach((button) => {
    button.addEventListener("click", () => openPreview());
  });

  el.settingsBody.querySelectorAll("[data-action='open-kick-api']").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = document.getElementById("channel-kick")?.value?.trim() || "";
      const channel = raw
        .replace(/^(https?:\/\/)?(www\.)?kick\.com\//i, "")
        .replace(/^@/, "")
        .split(/[/?#]/)[0]
        .trim();
      if (!channel) {
        toast("Escribe primero el canal de Kick para abrir sus IDs.", "warning");
        return;
      }
      window.open(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, "_blank", "noopener");
    });
  });

  el.settingsBody.querySelectorAll("[data-action='test-notifications']").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api("/api/action", {
          method: "POST",
          body: JSON.stringify({ action: "testNotifications" }),
        });
        toast("Avisos de prueba enviados al overlay.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}

function collectSettings() {
  const value = (id) => document.getElementById(id)?.value ?? "";
  const checked = (id) => Boolean(document.getElementById(id)?.checked);
  return {
    channels: {
      twitch: value("channel-twitch"),
      kick: value("channel-kick"),
      youtube: value("channel-youtube"),
      tiktok: value("channel-tiktok"),
    },
    kick: {
      channelId: Number(value("kick-channel-id")) || 0,
      chatroomId: Number(value("kick-chatroom-id")) || 0,
    },
    tiktok: {
      source: value("tiktok-source") === "tikfinity" ? "tikfinity" : "direct",
      signApiKey: value("tiktok-key").trim(),
      events: {
        joins: checked("tiktok-event-joins"),
        gifts: checked("tiktok-event-gifts"),
        shares: checked("tiktok-event-shares"),
        follows: checked("tiktok-event-follows"),
        subscribes: checked("tiktok-event-subscribes"),
        likes: checked("tiktok-event-likes"),
      },
    },
    tikfinity: {
      url: value("tikfinity-url").trim(),
    },
    clearTikTokKey: checked("clear-tiktok-key"),
    filters: {
      blockedUsers: collectionToList(value("blocked-users")),
      ignoreCommands: checked("ignore-commands"),
      maxMessageLength: Number(value("max-message-length")) || 300,
    },
    overlay: {
      maxMessages: Number(value("overlay-max-messages")) || 12,
      fontSize: Number(value("overlay-font-size")) || 18,
      width: Number(value("overlay-width")) || 440,
      lifetimeSeconds: Number(value("overlay-lifetime")) || 30,
      anchor: value("overlay-anchor") || "bottom-left",
      backgroundOpacity: Number(value("overlay-opacity")) || 0,
      showPlatform: checked("overlay-platform"),
      showBadges: checked("overlay-badges"),
      showViewers: checked("overlay-viewers"),
    },
    ui: {
      showTimestamps: checked("show-timestamps"),
    },
  };
}

async function saveSettings() {
  if (!state.canManage || saveBusy) return;
  saveBusy = true;
  const button = el.saveSettingsBtn;
  const previous = button ? button.innerHTML : "";
  if (button) {
    button.disabled = true;
    button.innerHTML = `${icon("refresh", "icon")} Guardando…`;
  }
  try {
    const data = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(collectSettings()),
    });
    state.settings = data.settings || state.settings;
    applySettingsUI();
    renderConnections();
    renderStatusBar();
    renderFilterChips();
    updateEmptyState();
    closeSettings();
    toast(data.restarted ? "Ajustes guardados. Reconectando plataformas…" : "Ajustes del overlay guardados.", "success");
    if (!el.previewLayer?.hidden) refreshPreview();
  } catch (error) {
    toast(error.message, "error", 5000);
    if (button) button.innerHTML = `${icon("alertCircle", "icon")} Error al guardar`;
    setTimeout(() => {
      if (button) button.innerHTML = previous;
    }, 1600);
  } finally {
    saveBusy = false;
    if (button) {
      button.disabled = false;
      if (button.innerHTML.includes("Guardando") || button.innerHTML.includes("Error")) button.innerHTML = previous;
    }
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // respuesta sin JSON
  }
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}

function showLayer(layer) {
  if (!layer) return;
  layer.hidden = false;
  const firstFocusable = layer.querySelector("input, select, textarea, button, a[href]");
  setTimeout(() => firstFocusable?.focus?.({ preventScroll: true }), 30);
}

function hideLayer(layer) {
  if (!layer) return;
  layer.hidden = true;
}

function closeSettings() {
  hideLayer(el.settingsLayer);
}

function closeShare() {
  hideLayer(el.shareLayer);
}

function openPreview() {
  closeSettings();
  closeShare();
  if (el.previewFrame) {
    el.previewFrame.src = `/overlay?demo=1&bg=0.34&max=8&font=17&width=400&lifetime=0`;
  }
  showLayer(el.previewLayer);
}

function refreshPreview() {
  if (!el.previewFrame) return;
  el.previewFrame.src = `/overlay?demo=1&bg=0.34&max=8&font=17&width=400&lifetime=0&refresh=${Date.now()}`;
}

function closePreview() {
  hideLayer(el.previewLayer);
  if (el.previewFrame) el.previewFrame.src = "about:blank";
}

function openSettings() {
  if (!state.canManage) {
    toast("Solo el anfitrión puede cambiar los ajustes de este chat.", "warning");
    return;
  }
  renderSettings();
  showLayer(el.settingsLayer);
}

async function openPip() {
  if (window.streamChatApp?.isDesktop) {
    try {
      await window.streamChatApp.openOverlay();
      toast("Overlay flotante abierto. Usa Ctrl+Alt+O para mostrarlo u ocultarlo.", "success", 5000);
    } catch (error) {
      toast(`No se pudo abrir el overlay flotante: ${error.message}`, "error");
    }
    return;
  }

  if (!("documentPictureInPicture" in window)) {
    const popup = window.open("/overlay?pip=1", "streamchat-pip", "popup=yes,width=380,height=620");
    if (popup) {
      toast("Ventana abierta. Para que quede siempre encima, usa un Edge/Chrome actualizado.", "info", 5000);
    } else {
      toast("El navegador bloqueó la ventana. Permite las ventanas emergentes e inténtalo otra vez.", "warning", 5000);
    }
    return;
  }
  try {
    const pip = await documentPictureInPicture.requestWindow({ width: 380, height: 620 });
    const doc = pip.document;
    doc.title = "StreamChat Hub · Chat";
    const style = doc.createElement("style");
    style.textContent = "html,body{margin:0;width:100%;height:100%;background:#0b0d13;overflow:hidden}iframe{display:block;width:100vw;height:100vh;border:0;background:#0b0d13}";
    doc.head.append(style);
    const frame = doc.createElement("iframe");
    frame.src = `/overlay?pip=1&max=10&font=15&width=360&lifetime=45`;
    frame.title = "Chat flotante de StreamChat Hub";
    doc.body.append(frame);
    toast("Ventana flotante abierta. Arrástrala y redimensiónala como quieras.", "success");
  } catch (error) {
    toast(`No se pudo abrir la ventana flotante: ${error.message}`, "error");
  }
}

async function action(payload, successMessage = "") {
  try {
    await api("/api/action", { method: "POST", body: JSON.stringify(payload) });
    if (successMessage) toast(successMessage, "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function togglePause() {
  state.paused = !state.paused;
  updatePauseButton();
  if (state.paused) {
    updateEmptyState();
    updateNewButton();
    return;
  }
  flushBuffer();
  updateEmptyState();
}

function resumeFromEmpty() {
  if (!state.paused) return;
  togglePause();
}

function clearFilters() {
  state.filter = "all";
  state.search = "";
  if (el.searchInput) el.searchInput.value = "";
  if (el.searchClear) el.searchClear.hidden = true;
  renderFilterChips();
  renderAllMessages({ instant: true });
  if (state.paused) {
    state.newCount = state.buffer.filter(messageMatches).length;
    updateNewButton();
  }
  updateEmptyState();
}

function bindUI() {
  el.settingsBtn?.addEventListener("click", openSettings);
  el.navSettings?.addEventListener("click", () => {
    closeSidebar();
    openSettings();
  });
  el.navShare?.addEventListener("click", () => {
    closeSidebar();
    openShare();
  });
  el.navPip?.addEventListener("click", () => {
    closeSidebar();
    openPip();
  });
  el.navChat?.addEventListener("click", closeSidebar);

  el.menuBtn?.addEventListener("click", () => {
    el.sidebar.classList.add("is-open");
    el.sidebarScrim.hidden = false;
  });
  el.sidebarClose?.addEventListener("click", closeSidebar);
  el.sidebarScrim?.addEventListener("click", closeSidebar);

  el.pauseBtn?.addEventListener("click", togglePause);
  el.soundBtn?.addEventListener("click", () => {
    state.sound = !state.sound;
    localStorage.setItem("streamchat:sound", state.sound ? "1" : "0");
    updateSoundButton();
    if (state.sound) {
      ensureAudio();
      playNotification();
      toast("Sonido activado.", "success");
    }
  });

  if (window.streamChatApp?.isDesktop) {
    if (el.pinBtn) el.pinBtn.hidden = false;
    el.pinBtn?.addEventListener("click", async () => {
      try {
        const pinned = await window.streamChatApp.toggleAlwaysOnTop();
        updatePinButton(pinned);
        toast(
          pinned ? "La app se mantendrá encima de otras ventanas." : "La app ya no estará siempre encima.",
          pinned ? "success" : "info",
        );
      } catch (error) {
        toast(`No se pudo cambiar el modo siempre encima: ${error.message}`, "error");
      }
    });
    window.streamChatApp
      .getAlwaysOnTop?.()
      .then(updatePinButton)
      .catch(() => {});
  }

  el.searchInput?.addEventListener(
    "input",
    debounce(() => {
      state.search = el.searchInput.value;
      el.searchClear.hidden = !state.search;
      renderAllMessages({ instant: true });
      if (state.paused) {
        state.newCount = state.buffer.filter(messageMatches).length;
        updateNewButton();
      }
    }, 110),
  );
  el.searchClear?.addEventListener("click", () => {
    el.searchInput.value = "";
    el.searchClear.hidden = true;
    state.search = "";
    renderAllMessages({ instant: true });
    el.searchInput.focus();
  });

  el.filterChips?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderFilterChips();
    renderAllMessages({ instant: true });
    if (state.paused) {
      state.newCount = state.buffer.filter(messageMatches).length;
      updateNewButton();
    }
  });

  el.connectionList?.addEventListener("click", (event) => {
    const button = event.target.closest(".connection-reconnect");
    if (!button || !state.canManage) return;
    action({ action: "reconnect", platform: button.dataset.platform }, `Reconectando ${PLATFORM_META[button.dataset.platform]?.label || "plataforma"}…`);
  });

  el.reconnectAllBtn?.addEventListener("click", () => {
    if (!state.canManage) return;
    action({ action: "reconnectAll" }, "Reconectando todas las plataformas…");
  });

  el.clearBtn?.addEventListener("click", () => {
    if (!state.canManage) return;
    if (!window.confirm("¿Limpiar los mensajes de esta pantalla? La configuración no se toca.")) return;
    state.messages = [];
    state.buffer = [];
    state.newCount = 0;
    renderAllMessages({ instant: true, scroll: false });
    updateNewButton();
    action({ action: "clear" });
  });

  el.testBtn?.addEventListener("click", () => {
    if (!state.canManage) return;
    action({ action: "test" }, "Mensajes de prueba enviados.");
  });

  el.emptyActionBtn?.addEventListener("click", () => {
    if (state.emptyAction === "settings") openSettings();
    else if (state.emptyAction === "filters") clearFilters();
    else if (state.emptyAction === "resume") resumeFromEmpty();
    else if (state.emptyAction === "test" && state.canManage) action({ action: "test" }, "Mensajes de prueba enviados.");
  });

  el.chatScroll?.addEventListener("scroll", () => {
    if (state.paused) return;
    if (isNearBottom() && state.newCount > 0) {
      state.newCount = 0;
      updateNewButton();
    }
  });

  el.newMessagesBtn?.addEventListener("click", () => {
    if (state.paused) {
      state.paused = false;
      updatePauseButton();
      flushBuffer();
    } else {
      scrollToBottom("smooth");
    }
    state.newCount = 0;
    updateNewButton();
  });

  el.saveSettingsBtn?.addEventListener("click", saveSettings);

  el.shareBody?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const actionName = button.dataset.action;
    if (actionName === "tunnel-start") startTunnel();
    else if (actionName === "tunnel-stop") stopTunnel();
    else if (actionName === "preview") openPreview();
    else if (actionName === "pip") openPip();
    else if (actionName === "copy-obs") {
      const target = document.getElementById("copy-overlay");
      if (target) {
        copyText(target.textContent).then((ok) =>
          toast(ok ? "URL del overlay copiada. Pégala en OBS." : "No se pudo copiar la URL.", ok ? "success" : "error"),
        );
      }
    } else if (actionName === "copy") {
      // Los botones de copia se enlazan al renderizar; este caso queda como respaldo.
      const target = document.getElementById(button.dataset.copy);
      if (target) copyText(target.textContent).then((ok) => toast(ok ? "Enlace copiado." : "No se pudo copiar.", ok ? "success" : "error"));
    }
  });

  el.previewTestBtn?.addEventListener("click", () => {
    if (!state.canManage) return;
    action({ action: "test" }, "Mensajes de prueba enviados al overlay.");
  });

  $$("[data-close-settings]").forEach((node) => node.addEventListener("click", closeSettings));
  $$("[data-close-share]").forEach((node) => node.addEventListener("click", closeShare));
  $$("[data-close-preview]").forEach((node) => node.addEventListener("click", closePreview));

  el.settingsBody?.addEventListener("input", (event) => {
    if (event.target.id === "overlay-opacity") {
      const output = document.getElementById("overlay-opacity-value");
      if (output) output.textContent = `${Math.round(Number(event.target.value) * 100)}%`;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!el.previewLayer?.hidden) closePreview();
      else if (!el.shareLayer?.hidden) closeShare();
      else if (!el.settingsLayer?.hidden) closeSettings();
      else if (document.activeElement === el.searchInput && el.searchInput.value) {
        el.searchInput.value = "";
        state.search = "";
        el.searchClear.hidden = true;
        renderAllMessages({ instant: true });
      }
      closeSidebar();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      el.searchInput?.focus();
    }
  });
}

function closeSidebar() {
  if (!el.sidebar) return;
  el.sidebar.classList.remove("is-open");
  if (el.sidebarScrim) el.sidebarScrim.hidden = true;
}

function updateDismissKey(tag) {
  return `streamchat:update-dismissed:${tag}`;
}

function hideUpdateBanner() {
  if (el.updateBanner) el.updateBanner.hidden = true;
}

function showUpdateBanner(status) {
  if (!el.updateBanner || !status?.available) return;
  if (el.updateTitle) {
    el.updateTitle.textContent = `StreamChat Hub ${status.latestVersion} disponible`;
  }
  if (el.updateText) {
    el.updateText.textContent = `Tienes la ${status.currentVersion}. Descarga la nueva versión cuando quieras; no se actualiza sola.`;
  }
  el.updateBanner.hidden = false;
}

function setupUpdates() {
  if (!window.streamChatApp?.isDesktop) {
    hideUpdateBanner();
    return;
  }

  const present = (status) => {
    if (!status?.available || !status.tag) return;
    let dismissed = "";
    try {
      dismissed = localStorage.getItem(updateDismissKey(status.tag)) || "";
    } catch {
      // sin almacenamiento: se muestra igualmente
    }
    if (!dismissed) showUpdateBanner(status);
  };

  el.updateDownloadBtn?.addEventListener("click", async () => {
    try {
      await window.streamChatApp.openUpdatePage();
      hideUpdateBanner();
    } catch (error) {
      toast(`No se pudo abrir la descarga: ${error.message}`, "error");
    }
  });

  el.updateDismissBtn?.addEventListener("click", () => {
    const tag = el.updateBanner?.dataset.tag || "";
    if (tag) {
      try {
        localStorage.setItem(updateDismissKey(tag), "1");
      } catch {
        // ignorar
      }
    }
    hideUpdateBanner();
  });

  window.streamChatApp.onUpdate?.((status) => {
    if (el.updateBanner && status?.tag) el.updateBanner.dataset.tag = status.tag;
    present(status);
  });

  window.streamChatApp
    .getUpdateStatus?.()
    .then((status) => {
      if (el.updateBanner && status?.tag) el.updateBanner.dataset.tag = status.tag;
      present(status);
    })
    .catch(() => {
      // sin conexión con GitHub: no molestar
    });
}

async function init() {
  cacheElements();
  fillStaticIcons();
  bindUI();
  setupUpdates();
  updatePauseButton();
  updateSoundButton();
  renderFilterChips();
  updateEmptyState();

  try {
    const info = await api("/api/info");
    applyInfo(info);
  } catch {
    // El WebSocket puede seguir funcionando o reconectar.
  }

  socket = createChatSocket({
    onOpen: () => {
      setSocketOnline(true);
    },
    onClose: () => {
      setSocketOnline(false);
    },
    onSnapshot: (data) => {
      applySnapshot(data);
    },
    onMessage: (message, stats) => {
      handleIncomingMessage(message, stats);
    },
    onStatus: (status) => {
      if (!status?.platform) return;
      state.statuses[status.platform] = status;
      renderConnections();
      renderStatusBar();
      if (!el.settingsLayer?.hidden && state.canManage) {
        // No se re-renderiza el formulario para no perder lo que se está editando.
      }
    },
    onStats: (stats) => {
      updateStats(stats);
    },
    onCleared: () => {
      state.messages = [];
      state.buffer = [];
      state.newCount = 0;
      renderAllMessages({ instant: true, scroll: false });
      updateNewButton();
      updateEmptyState();
    },
    onSettings: (settings) => {
      state.settings = settings;
      applySettingsUI();
      updateEmptyState();
      if (!el.previewLayer?.hidden) refreshPreview();
    },
    onTunnel: (tunnel) => {
      setShareTunnel(tunnel);
    },
  });
}

init();
