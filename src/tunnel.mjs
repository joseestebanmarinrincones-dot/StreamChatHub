import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchWithTimeout } from "./util.mjs";

const DOWNLOAD_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

export class TunnelManager extends EventEmitter {
  constructor({ port, binDir }) {
    super();
    this.port = port;
    this.binDir = binDir;
    this.binaryPath = path.join(binDir, "cloudflared.exe");
    this.process = null;
    this.output = "";
    this.abortController = null;
    this.state = {
      status: "idle",
      url: "",
      message: "Túnel desactivado",
      progress: null,
      error: "",
      startedAt: 0,
    };
  }

  snapshot() {
    return { ...this.state };
  }

  _set(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: Date.now(),
    };
    this.emit("state", this.snapshot());
  }

  async start() {
    if (["preparing", "downloading", "starting", "running"].includes(this.state.status)) {
      return this.snapshot();
    }
    this.output = "";
    this._set({
      status: "preparing",
      url: "",
      error: "",
      progress: null,
      message: "Preparando Cloudflare Tunnel...",
      startedAt: Date.now(),
    });
    this._run().catch((error) => {
      if (this.state.status === "stopped" || this.state.status === "idle") return;
      this._set({
        status: "error",
        url: "",
        progress: null,
        message: "No se pudo iniciar el enlace público.",
        error: error?.message || String(error),
      });
    });
    return this.snapshot();
  }

  async _run() {
    await this.ensureBinary();
    this._spawnTunnel();
  }

  async ensureBinary() {
    try {
      const stat = fs.statSync(this.binaryPath);
      if (stat.size > 1_000_000) return;
    } catch {
      // hay que descargarlo
    }

    fs.mkdirSync(this.binDir, { recursive: true });
    const temp = `${this.binaryPath}.download`;
    this._set({
      status: "downloading",
      message: "Descargando Cloudflare Tunnel (solo la primera vez)...",
      progress: 0,
    });

    this.abortController = new AbortController();
    let response;
    try {
      response = await fetchWithTimeout(
        DOWNLOAD_URL,
        {
          redirect: "follow",
          signal: this.abortController.signal,
          headers: {
            "User-Agent": "StreamChatHub/1.0",
            Accept: "application/octet-stream",
          },
        },
        120000,
      );
    } catch (error) {
      throw new Error(`No se pudo descargar cloudflared: ${error.message}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`La descarga de cloudflared falló (HTTP ${response.status}).`);
    }

    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    let lastProgress = -1;
    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk) => {
      received += chunk.length;
      if (!total) return;
      const percent = Math.min(99, Math.floor((received / total) * 100));
      if (percent >= lastProgress + 2) {
        lastProgress = percent;
        this._set({
          progress: percent,
          message: `Descargando Cloudflare Tunnel... ${percent}%`,
        });
      }
    });

    try {
      await pipeline(body, fs.createWriteStream(temp));
      fs.renameSync(temp, this.binaryPath);
      this._set({ progress: 100, message: "Cloudflare Tunnel descargado." });
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // ignorar
      }
      throw new Error(`No se pudo guardar cloudflared: ${error.message}`);
    } finally {
      this.abortController = null;
    }
  }

  _spawnTunnel() {
    this._set({
      status: "starting",
      message: "Conectando con Cloudflare...",
      progress: null,
      error: "",
    });

    const child = spawn(
      this.binaryPath,
      ["tunnel", "--url", `http://127.0.0.1:${this.port}`, "--no-autoupdate", "--protocol", "http2"],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.process = child;

    let ready = false;
    const onData = (buffer) => {
      const text = stripAnsi(buffer.toString("utf8"));
      this.output = (this.output + text).slice(-16000);
      const match = text.match(URL_RE);
      if (match && !ready) {
        ready = true;
        this._set({
          status: "running",
          url: match[0].replace(/\/$/, ""),
          message: "Enlace público listo.",
          error: "",
          progress: null,
        });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timeout = setTimeout(() => {
      if (ready) return;
      this._set({
        status: "error",
        message: "Cloudflare no respondió a tiempo.",
        error: this.output.slice(-1200) || "Sin respuesta de cloudflared.",
      });
      this._kill();
    }, 60000);
    timeout.unref?.();

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (this.process !== child) return;
      this.process = null;
      this._set({
        status: "error",
        message: "No se pudo ejecutar cloudflared.",
        error: error.message,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (this.process !== child) return;
      this.process = null;
      const wasRunning = this.state.status === "running";
      this._set({
        status: wasRunning ? "stopped" : this.state.status === "error" ? "error" : "stopped",
        url: wasRunning ? "" : this.state.url,
        message: wasRunning
          ? "El enlace público se cerró."
          : `Cloudflare Tunnel terminó${code ? ` (código ${code})` : ""}.`,
        error:
          wasRunning || code === 0
            ? ""
            : this.output.slice(-1200) || `cloudflared terminó con código ${code}.`,
      });
    });
  }

  _kill() {
    const child = this.process;
    this.process = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // ignorar
    }
    setTimeout(() => {
      if (child.exitCode !== null) return;
      try {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } catch {
        // ignorar
      }
    }, 1500).unref?.();
  }

  stop() {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // ignorar
      }
      this.abortController = null;
    }
    if (["idle", "stopped", "error"].includes(this.state.status)) {
      this._set({
        status: "idle",
        url: "",
        message: "Túnel desactivado",
        progress: null,
        error: "",
      });
      return this.snapshot();
    }
    this._set({
      status: "stopped",
      url: "",
      message: "Túnel desactivado",
      progress: null,
    });
    this._kill();
    return this.snapshot();
  }

  destroy() {
    this.stop();
  }
}
