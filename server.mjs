import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { ConfigStore, publicSettings } from "./src/config.mjs";
import { ChatHub } from "./src/hub.mjs";
import { TunnelManager } from "./src/tunnel.mjs";
import { clampNumber, PLATFORMS } from "./src/util.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.STREAMCHAT_DATA_DIR
  ? path.resolve(process.env.STREAMCHAT_DATA_DIR)
  : ROOT;
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PORT = clampNumber(process.env.PORT || 3000, 1, 65535, 3000);
const VERSION = "1.1.1";
const HOST = "0.0.0.0";
const IS_MAIN =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const store = new ConfigStore(CONFIG_PATH);
store.load();
const hub = new ChatHub(store, { port: PORT });
const tunnel = new TunnelManager({ port: PORT, binDir: path.join(DATA_DIR, "bin") });
const clients = new Set();
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  const body = Buffer.from(html);
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function isLocalRequest(req) {
  const forwarded =
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.headers["forwarded"];
  if (forwarded) return false;
  const remote = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return remote === "127.0.0.1" || remote === "::1";
}

function getLanUrls() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (!entry.address || entry.address.startsWith("169.254.")) continue;
      addresses.push(entry.address);
    }
  }
  const priority = (address) => {
    if (address.startsWith("192.168.")) return 0;
    if (address.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    if (address.startsWith("100.")) return 3;
    return 4;
  };
  return [...new Set(addresses)]
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    .slice(0, 6)
    .map((address) => `http://${address}:${PORT}`);
}

function buildShare() {
  const lanUrls = getLanUrls();
  return {
    localUrl: `http://localhost:${PORT}`,
    lanUrls,
    primaryLanUrl: lanUrls[0] || "",
    overlayPath: "/overlay",
    overlayUrl: `http://localhost:${PORT}/overlay?obs=1`,
    qrEndpoint: "/api/qr",
    tunnel: tunnel.snapshot(),
  };
}

function buildInfo(canManage) {
  return {
    ok: true,
    app: {
      name: "StreamChat Hub",
      version: VERSION,
      credit:
        "Inspirado en Transparent Twitch Chat Overlay de baffler. Solo lectura y sin credenciales de Twitch/Kick.",
    },
    canManage,
    serverTime: Date.now(),
    settings: publicSettings(store.settings),
    statuses: structuredClone(hub.statuses),
    stats: hub.getStats(),
    share: canManage ? buildShare() : { overlayPath: "/overlay", localUrl: "" },
  };
}

function broadcast(payload) {
  if (!clients.size) return;
  const text = JSON.stringify(payload);
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(text);
      } catch {
        socket.terminate();
        clients.delete(socket);
      }
    }
  }
}

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    socket.terminate();
  }
}

async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "El cuerpo de la petición es demasiado grande.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON no válido.");
  }
}

function safeResolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) return null;
  return filePath;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function serveStatic(req, res, pathname) {
  let file = safeResolveStatic(pathname);
  if (!file) {
    sendJson(res, 400, { ok: false, error: "Ruta no válida." });
    return;
  }
  if (pathname === "/overlay" || pathname === "/overlay/") {
    file = path.join(PUBLIC_DIR, "overlay.html");
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendHtml(
      res,
      404,
      "<!doctype html><meta charset='utf-8'><title>No encontrado</title><body style='font-family:system-ui;background:#0b0c10;color:#e8eaf2;padding:40px'><h1>404</h1><p>Esa página no existe.</p><p><a style='color:#a5b4fc' href='/'>Volver al chat</a></p>",
    );
    return;
  }
  if (stat.isDirectory()) {
    sendHtml(res, 404, "<!doctype html><meta charset='utf-8'><h1>404</h1>");
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";
  res.statusCode = 200;
  applySecurityHeaders(res);
  res.setHeader("Content-Type", type);
  res.setHeader(
    "Cache-Control",
    [".html", ".css", ".js", ".mjs"].includes(ext) ? "no-cache" : "public, max-age=3600",
  );
  if (ext === ".html") {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self'; media-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
  }
  res.setHeader("Content-Length", stat.size);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "No se pudo leer el archivo." });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const canManage = isLocalRequest(req);
  const route = url.pathname;

  if (route === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      app: "StreamChat Hub",
      version: VERSION,
      uptime: Math.round(process.uptime()),
      platformStates: Object.fromEntries(
        PLATFORMS.map((platform) => [platform, hub.statuses[platform].state]),
      ),
      canManage,
    });
    return;
  }

  if (route === "/api/info" && req.method === "GET") {
    sendJson(res, 200, buildInfo(canManage));
    return;
  }

  if (!canManage) {
    sendJson(res, 403, {
      ok: false,
      error: "Esta acción solo está disponible desde el PC que ejecuta StreamChat Hub.",
    });
    return;
  }

  if (route === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      settings: publicSettings(store.settings),
      tiktokKeySet: Boolean(store.settings.tiktok.signApiKey || process.env.TIKTOK_SIGN_API_KEY),
      envKey: Boolean(process.env.TIKTOK_SIGN_API_KEY),
      canManage,
    });
    return;
  }

  if (route === "/api/settings" && req.method === "POST") {
    const body = await readJson(req);
    const current = store.settings;
    const patch = {
      channels: body.channels,
      kick: body.kick,
      filters: body.filters,
      overlay: body.overlay,
      ui: body.ui,
      tikfinity: body.tikfinity,
    };
    const tiktokPatch = { ...(body.tiktok ?? {}) };
    const incomingKey = typeof tiktokPatch.signApiKey === "string" ? tiktokPatch.signApiKey.trim() : "";
    if (body.clearTikTokKey) {
      tiktokPatch.signApiKey = "";
    } else if (!incomingKey) {
      delete tiktokPatch.signApiKey;
    }
    patch.tiktok = tiktokPatch;

    const saved = store.update(patch);
    const connectionChanged =
      PLATFORMS.some((platform) => saved.channels[platform] !== current.channels[platform]) ||
      saved.kick.channelId !== current.kick.channelId ||
      saved.kick.chatroomId !== current.kick.chatroomId ||
      saved.tiktok.signApiKey !== current.tiktok.signApiKey ||
      saved.tiktok.source !== current.tiktok.source ||
      saved.tikfinity.url !== current.tikfinity.url ||
      JSON.stringify(saved.tiktok.events) !== JSON.stringify(current.tiktok.events);

    hub.applySettings(saved, { restart: connectionChanged });
    broadcast({ type: "settings", settings: publicSettings(saved) });
    sendJson(res, 200, {
      ok: true,
      settings: publicSettings(saved),
      restarted: connectionChanged,
    });
    return;
  }

  if (route === "/api/host-message" && req.method === "POST") {
    const body = await readJson(req);
    const message = hub.addHostMessage(body.text);
    if (!message) throw new HttpError(400, "El mensaje está vacío.");
    sendJson(res, 200, { ok: true, message });
    return;
  }

  if (route === "/api/action" && req.method === "POST") {    const body = await readJson(req);
    const action = String(body.action || "");

    if (action === "reconnect") {
      const platform = String(body.platform || "");
      if (!PLATFORMS.includes(platform)) throw new HttpError(400, "Plataforma no válida.");
      hub.restartPlatform(platform);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "reconnectAll") {
      hub.restartAll();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "clear") {
      hub.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "test") {
      hub.testMessages();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "testNotifications") {
      hub.testNotifications();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === "tunnelStart") {
      const state = await tunnel.start();
      sendJson(res, 200, { ok: true, tunnel: state });
      return;
    }
    if (action === "tunnelStop") {
      const state = tunnel.stop();
      sendJson(res, 200, { ok: true, tunnel: state });
      return;
    }
    throw new HttpError(400, "Acción no válida.");
  }

  throw new HttpError(404, "API no encontrada.");
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/qr" && req.method === "GET") {
      const text = String(url.searchParams.get("url") || "").trim();
      if (!/^https?:\/\//i.test(text) || text.length > 500) {
        throw new HttpError(400, "URL no válida para el código QR.");
      }
      const size = Math.round(clampNumber(url.searchParams.get("size"), 120, 600, 240));
      const { default: QRCode } = await import("qrcode");
      const png = await QRCode.toBuffer(text, {
        type: "png",
        width: size,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#0b0c10", light: "#ffffff" },
      });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(png);
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "POST") {
        throw new HttpError(405, "Método no permitido.");
      }
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      throw new HttpError(405, "Método no permitido.");
    }
    if (pathname === "/ws") {
      sendJson(res, 426, { ok: false, error: "Se requiere WebSocket." });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignorar
      }
      return;
    }
    const status = error instanceof HttpError ? error.statusCode : 500;
    if (status >= 500) console.error("[HTTP]", error);
    sendJson(res, status, {
      ok: false,
      error: error?.message || "Error interno del servidor.",
    });
  }
}

const server = http.createServer(handleRequest);

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (socket, req) => {
  socket.isAlive = true;
  socket.canManage = isLocalRequest(req);
  clients.add(socket);

  const snapshot = {
    type: "snapshot",
    data: {
      ...hub.getSnapshot(),
      settings: publicSettings(store.settings),
      share: socket.canManage
        ? buildShare()
        : { overlayPath: "/overlay", localUrl: "" },
      app: { name: "StreamChat Hub", version: VERSION },
      canManage: socket.canManage,
      serverTime: Date.now(),
    },
  };
  send(socket, snapshot);

  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (raw) => {
    if (raw.length > 2000) return;
    const text = raw.toString("utf8");
    if (text === "ping") send(socket, { type: "pong", at: Date.now() });
  });
  socket.on("error", () => {
    clients.delete(socket);
  });
  socket.on("close", () => {
    clients.delete(socket);
  });
});

const heartbeat = setInterval(() => {
  for (const socket of clients) {
    if (socket.isAlive === false) {
      clients.delete(socket);
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // ignore
    }
  }
}, 30000);
heartbeat.unref?.();

const statsTimer = setInterval(() => {
  if (clients.size) broadcast({ type: "stats", stats: hub.getStats() });
}, 10000);
statsTimer.unref?.();

hub.on("message", (message) => {
  broadcast({ type: "message", message, stats: hub.getStats() });
});
hub.on("status", (status) => {
  broadcast({ type: "status", status });
});
hub.on("cleared", () => {
  broadcast({ type: "cleared" });
});
hub.on("settings", (settings) => {
  broadcast({ type: "settings", settings: publicSettings(settings) });
});
hub.on("notification", (notification) => {
  broadcast({ type: "notification", notification });
});
tunnel.on("state", (state) => {
  broadcast({ type: "tunnel", tunnel: state });
});

function printBanner() {
  const lanUrls = getLanUrls();
  const lines = [
    "",
    "============================================================",
    "  StreamChat Hub " + VERSION + "  ·  Twitch + Kick + YouTube + TikTok",
    "============================================================",
    `  Chat local:      http://localhost:${PORT}`,
    `  Amigos (Wi-Fi):  ${lanUrls[0] || "No se detectó una red local"}`,
    `  Overlay OBS:     http://localhost:${PORT}/overlay?obs=1`,
    "",
    "  Configura tus canales en el botón Ajustes.",
    "  Deja esta ventana abierta mientras estás en directo.",
    "============================================================",
    "",
  ];
  console.log(lines.join("\n"));
  for (const platform of PLATFORMS) {
    const channel = store.settings.channels[platform];
    console.log(`  ${platform.padEnd(8)} ${channel || "(sin canal)"}`);
  }
  console.log("");
}

let started = false;
let closing = null;
let hubStarted = false;

server.on("error", (error) => {
  if (!started) return;
  if (error.code === "EADDRINUSE") {
    console.error(`\nEl puerto ${PORT} ya está en uso. Cierra la otra instancia de StreamChat Hub o define otro puerto con PORT=3001.\n`);
  } else {
    console.error("[Servidor]", error);
  }
});

function openBrowserWindow() {
  if (process.env.NO_OPEN === "1" || process.platform !== "win32") return;
  try {
    spawn("cmd.exe", ["/c", "start", "", `http://localhost:${PORT}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    // abrir manualmente
  }
}

export function startConnections() {
  if (hubStarted) return;
  hubStarted = true;
  hub.start();
}

export function startServer({ openBrowser = true, startHub = true } = {}) {
  if (started) {
    if (startHub) startConnections();
    return Promise.resolve({ port: PORT, url: `http://localhost:${PORT}` });
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      started = true;
      printBanner();
      if (startHub) startConnections();
      if (openBrowser) openBrowserWindow();
      resolve({ port: PORT, url: `http://localhost:${PORT}` });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(PORT, HOST);
  });
}

export async function closeServer() {
  if (closing) return closing;
  if (!started && !server.listening) return;
  started = false;
  hubStarted = false;
  closing = (async () => {
    clearInterval(heartbeat);
    clearInterval(statsTimer);
    hub.destroy();
    tunnel.destroy();
    for (const socket of clients) {
      try {
        socket.close(1001, "servidor cerrado");
      } catch {
        // ignorar
      }
    }
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    closing = null;
  })();
  return closing;
}

export function getServerPort() {
  return PORT;
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[StreamChat] Cerrando (${signal})...`);
  await closeServer();
  process.exit(0);
}

if (IS_MAIN) {
  startServer().catch((error) => {
    console.error("[StreamChat] No se pudo iniciar el servidor:", error.message);
    process.exit(1);
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[Promise rechazada]", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[Error no controlado]", error);
});

