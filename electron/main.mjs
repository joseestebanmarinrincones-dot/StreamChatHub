import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, screen, session, shell } from "electron";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, "..");
const DEV_ICON = path.join(APP_ROOT, "build", "icon.png");
const APP_ICON = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : DEV_ICON;
const SMOKE_OVERLAY = process.argv.includes("--smoke-overlay") || process.env.STREAMCHAT_SMOKE_OVERLAY === "1";
const SMOKE = process.argv.includes("--smoke") || process.env.STREAMCHAT_SMOKE === "1" || SMOKE_OVERLAY;

app.setName("StreamChat Hub");
app.setAppUserModelId("com.streamchathub.app");
const dataDir = path.join(app.getPath("appData"), "StreamChatHub");
fs.mkdirSync(dataDir, { recursive: true });
app.setPath("userData", dataDir);
const OVERLAY_STATE_FILE = path.join(dataDir, "overlay-bounds.json");
const OVERLAY_SIZES = {
  compact: { width: 340, height: 560 },
  medium: { width: 430, height: 720 },
  large: { width: 560, height: 860 },
};

let mainWindow = null;
let overlayWindow = null;
let previewWindow = null;
let tray = null;
let serverModule = null;
let baseOrigin = "";
let quitting = false;
let closeStarted = false;
let overlayEditing = false;
let overlayComposerOpen = false;
let overlaySaveTimer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function pickPort() {
  for (let port = 3000; port <= 3100; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("No hay ningún puerto libre entre 3000 y 3100.");
}

function trayIcon() {
  const image = nativeImage.createFromPath(APP_ICON);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function windowOptions(extra = {}) {
  return {
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: "#07080c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    ...extra,
  };
}

function secureWebContents(win, { allowOverlayPreview = true } = {}) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const base = new URL(baseOrigin);
      if (target.origin === base.origin) {
        if (allowOverlayPreview && target.pathname.startsWith("/overlay")) {
          openPreviewWindow();
        }
        return { action: "deny" };
      }
      if (["https:", "http:", "mailto:"].includes(target.protocol)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      // URL no válida
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      const base = new URL(baseOrigin);
      if (target.origin === base.origin) return;
      event.preventDefault();
      if (["https:", "http:", "mailto:"].includes(target.protocol)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      event.preventDefault();
    }
  });
}

function createMainWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow(
    windowOptions({
      width: Math.min(1440, Math.max(980, workArea.width - 40)),
      height: Math.min(900, Math.max(640, workArea.height - 40)),
      minWidth: 980,
      minHeight: 640,
      show: false,
      title: "StreamChat Hub",
    }),
  );
  mainWindow.removeMenu();
  secureWebContents(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (SMOKE) captureAndQuit();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });

  mainWindow.loadURL(`${baseOrigin}/`).catch((error) => {
    dialog.showErrorBox("StreamChat Hub", `No se pudo abrir la ventana principal.\n\n${error.message}`);
    app.quit();
  });
}

function overlayBounds() {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(430, Math.max(320, display.workArea.width - 40));
  const height = Math.min(720, Math.max(420, display.workArea.height - 40));
  return {
    width,
    height,
    x: display.workArea.x + 22,
    y: display.workArea.y + display.workArea.height - height - 22,
  };
}

function boundsVisible(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width - 60 &&
      bounds.x + bounds.width > area.x + 60 &&
      bounds.y < area.y + area.height - 40 &&
      bounds.y + bounds.height > area.y + 40
    );
  });
}

function loadOverlayBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(OVERLAY_STATE_FILE, "utf8"));
    const bounds = {
      x: Math.round(Number(saved.x)),
      y: Math.round(Number(saved.y)),
      width: Math.round(Number(saved.width)),
      height: Math.round(Number(saved.height)),
    };
    if (
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      bounds.width >= 280 &&
      bounds.height >= 360 &&
      bounds.width <= 1200 &&
      bounds.height <= 1200 &&
      boundsVisible(bounds)
    ) {
      return bounds;
    }
  } catch {
    // sin estado guardado
  }
  return overlayBounds();
}

function saveOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(OVERLAY_STATE_FILE, JSON.stringify(overlayWindow.getBounds(), null, 2));
  } catch {
    // no bloquear el cierre
  }
}

function scheduleOverlayBoundsSave() {
  clearTimeout(overlaySaveTimer);
  overlaySaveTimer = setTimeout(saveOverlayBounds, 350);
}

function overlayUrl(edit = overlayEditing) {
  return `${baseOrigin}/overlay?desktop=1${edit ? "&edit=1" : ""}`;
}

function setOverlayInteractive(interactive) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: !interactive });
  overlayWindow.setFocusable(interactive);
  if (interactive) {
    if (!overlayWindow.isVisible()) overlayWindow.show();
    overlayWindow.focus();
  }
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const bounds = loadOverlayBounds();
  overlayWindow = new BrowserWindow(
    windowOptions({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      title: "StreamChat Hub · Overlay",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    }),
  );
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  secureWebContents(overlayWindow, { allowOverlayPreview: false });
  overlayWindow.on("move", scheduleOverlayBoundsSave);
  overlayWindow.on("resize", scheduleOverlayBoundsSave);

  overlayWindow.once("ready-to-show", () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (overlayEditing || overlayComposerOpen) {
      overlayWindow.show();
      overlayWindow.focus();
      setOverlayInteractive(true);
    } else {
      overlayWindow.showInactive();
    }
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    updateTrayMenu();
  });
  overlayWindow.on("closed", () => {
    saveOverlayBounds();
    overlayWindow = null;
    overlayEditing = false;
    overlayComposerOpen = false;
    updateTrayMenu();
  });
  overlayWindow.loadURL(overlayUrl()).catch(() => {});
  return overlayWindow;
}

function setOverlaySize(size) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const preset = OVERLAY_SIZES[size] || OVERLAY_SIZES.medium;
  const display = screen.getDisplayMatching(overlayWindow.getBounds());
  const area = display.workArea;
  const width = Math.min(preset.width, area.width - 20);
  const height = Math.min(preset.height, area.height - 20);
  const current = overlayWindow.getBounds();
  const bottom = current.y + current.height;
  const x = Math.min(Math.max(current.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bottom - height, area.y), area.y + area.height - height);
  overlayWindow.setBounds({ x, y, width, height });
  saveOverlayBounds();
  return true;
}

function enterOverlayEdit() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  if (!overlayWindow) return;
  overlayComposerOpen = false;
  overlayEditing = true;
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.setFocusable(true);
  if (!overlayWindow.isVisible()) overlayWindow.show();
  overlayWindow.webContents.once("did-finish-load", () => {
    if (!overlayEditing || !overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.show();
    overlayWindow.focus();
  });
  overlayWindow.loadURL(overlayUrl(true)).catch(() => {});
  overlayWindow.focus();
  updateTrayMenu();
}

function finishOverlayEdit() {
  overlayEditing = false;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    saveOverlayBounds();
    overlayWindow.setFocusable(false);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadURL(overlayUrl(false)).catch(() => {});
    overlayWindow.showInactive();
  }
  updateTrayMenu();
}

function toggleOverlayEdit() {
  if (overlayEditing) finishOverlayEdit();
  else enterOverlayEdit();
}

function openOverlayComposer() {
  if (overlayEditing) finishOverlayEdit();
  let target = overlayWindow;
  if (!target || target.isDestroyed()) target = createOverlayWindow();
  if (!target) return;
  overlayComposerOpen = true;
  target.setIgnoreMouseEvents(false);
  target.setFocusable(true);
  if (!target.isVisible()) target.show();
  target.focus();
  const send = () => {
    if (!target || target.isDestroyed()) return;
    target.webContents.send("overlay:composer");
    target.focus();
  };
  if (target.webContents.isLoading()) target.webContents.once("did-finish-load", send);
  else send();
  updateTrayMenu();
}

function endOverlayComposer() {
  overlayComposerOpen = false;
  if (!overlayEditing) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setFocusable(false);
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }
  updateTrayMenu();
}

function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
  updateTrayMenu();
}

function openPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (previewWindow.isMinimized()) previewWindow.restore();
    previewWindow.show();
    previewWindow.focus();
    return previewWindow;
  }
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  previewWindow = new BrowserWindow(
    windowOptions({
      width: 480,
      height: Math.min(780, Math.max(520, workArea.height - 40)),
      minWidth: 380,
      minHeight: 480,
      title: "Overlay · StreamChat Hub",
      backgroundColor: "#0b0d13",
      show: false,
      autoHideMenuBar: true,
    }),
  );
  previewWindow.removeMenu();
  secureWebContents(previewWindow, { allowOverlayPreview: false });
  previewWindow.once("ready-to-show", () => previewWindow?.show());
  previewWindow.on("closed", () => {
    previewWindow = null;
  });
  previewWindow
    .loadURL(`${baseOrigin}/overlay?pip=1`)
    .catch(() => {});
  return previewWindow;
}

function updateTrayMenu() {
  if (!tray) return;
  const overlayVisible = Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Abrir StreamChat Hub",
        click: () => {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: overlayVisible ? "Ocultar overlay flotante" : "Mostrar overlay flotante",
        accelerator: "Ctrl+Alt+O",
        click: toggleOverlayWindow,
      },
      {
        label: "Escribir mensaje local",
        accelerator: "F8",
        click: openOverlayComposer,
      },
      {
        label: overlayEditing ? "Terminar de mover overlay" : "Mover / redimensionar overlay",
        accelerator: "Ctrl+Alt+E",
        click: toggleOverlayEdit,
      },
      { type: "separator" },
      {
        label: "Copiar URL del overlay para OBS",
        click: () => {
          const port = serverModule?.getServerPort?.();
          if (port) clipboard.writeText(`http://localhost:${port}/overlay?obs=1`);
        },
      },
      {
        label: "Abrir carpeta de datos",
        click: () => shell.openPath(dataDir).catch(() => {}),
      },
      { type: "separator" },
      {
        label: "Salir",
        click: () => app.quit(),
      },
    ]),
  );
}

function createTray() {
  const image = trayIcon();
  tray = new Tray(image);
  tray.setToolTip("StreamChat Hub");
  tray.on("double-click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
  updateTrayMenu();
}

async function captureAndQuit() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const image = await mainWindow.webContents.capturePage();
    const file = path.join(app.getPath("temp"), "streamchat-smoke.png");
    fs.writeFileSync(file, image.toPNG());
    console.log(`[SMOKE] ${file}`);

    if (SMOKE_OVERLAY) {
      const overlay = createOverlayWindow();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      console.log(
        "[SMOKE] overlay",
        JSON.stringify({
          visible: overlay.isVisible(),
          alwaysOnTop: overlay.isAlwaysOnTop(),
          bounds: overlay.getBounds(),
        }),
      );
      const overlayImage = await overlay.webContents.capturePage();
      const overlayFile = path.join(app.getPath("temp"), "streamchat-overlay-smoke.png");
      fs.writeFileSync(overlayFile, overlayImage.toPNG());
      console.log(`[SMOKE] ${overlayFile}`);
    }
  } catch (error) {
    console.error("[SMOKE]", error);
  }
  app.quit();
}

async function bootstrap() {
  try {
    const port = await pickPort();
    baseOrigin = `http://127.0.0.1:${port}`;
    process.env.PORT = String(port);
    process.env.STREAMCHAT_DATA_DIR = dataDir;
    process.env.NO_OPEN = "1";

    serverModule = await import(pathToFileURL(path.join(APP_ROOT, "server.mjs")).href);
    await serverModule.startServer({ openBrowser: false });

    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    createTray();
    createMainWindow();
    ipcMain.handle("overlay:open", () => {
      const window = createOverlayWindow();
      if (window && !window.isVisible()) window.showInactive();
      updateTrayMenu();
      return true;
    });
    ipcMain.handle("overlay:close", () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
      return true;
    });
    ipcMain.handle("overlay:set-size", (_event, size) => setOverlaySize(String(size)));
    ipcMain.handle("overlay:finish-edit", () => {
      finishOverlayEdit();
      return true;
    });
    ipcMain.handle("overlay:copy-obs", () => {
      const port = serverModule?.getServerPort?.();
      if (!port) return false;
      clipboard.writeText(`http://localhost:${port}/overlay?obs=1`);
      return true;
    });
    ipcMain.on("overlay:composer-end", () => {
      endOverlayComposer();
    });
    ipcMain.handle("window:toggle-always-on-top", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const next = !mainWindow.isAlwaysOnTop();
      mainWindow.setAlwaysOnTop(next, "floating");
      return next;
    });
    ipcMain.handle("window:get-always-on-top", () => {
      return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop());
    });

    const shortcuts = [
      ["CommandOrControl+Alt+O", toggleOverlayWindow],
      ["F8", openOverlayComposer],
      ["CommandOrControl+Alt+M", openOverlayComposer],
      ["CommandOrControl+Alt+E", toggleOverlayEdit],
    ];
    for (const [accelerator, handler] of shortcuts) {
      if (!globalShortcut.register(accelerator, handler)) {
        console.warn(`No se pudo registrar el atajo ${accelerator}`);
      }
    }
  } catch (error) {
    dialog.showErrorBox(
      "StreamChat Hub",
      `No se pudo iniciar la aplicación.\n\n${error?.message || error}`,
    );
    app.quit();
  }
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (closeStarted) return;
  closeStarted = true;
  clearTimeout(overlaySaveTimer);
  saveOverlayBounds();
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignorar
  }
  const finish = () => {
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
      if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
      if (tray) tray.destroy();
    } catch {
      // ignorar
    }
    app.exit(0);
  };
  if (serverModule?.closeServer) {
    Promise.race([
      Promise.resolve(serverModule.closeServer()),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]).finally(finish);
  } else {
    finish();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
});
