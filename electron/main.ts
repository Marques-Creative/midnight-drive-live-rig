/**
 * ROCKDJ — Live Performance OS — Electron Main Process
 *
 * The Express server runs inside Electron's utilityProcess (which uses
 * Electron's own Node runtime). This means better-sqlite3 only needs to be
 * compiled once — for Electron's ABI — and there is no dependency on any
 * system-installed Node binary.
 */

import { app, BrowserWindow, dialog, shell, utilityProcess, MessageChannelMain } from "electron";
import type { UtilityProcess } from "electron";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Single instance lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Constants ─────────────────────────────────────────────────────────────────
const SERVER_PORT = 47291;
const ENGINE_PORT = 47822; // localhost control port for the native audio engine
const DATA_DIR = path.join(os.homedir(), "MidnightDrive");
const LOG_FILE = path.join(os.homedir(), "Library", "Logs", "ROCKDJ", "startup.log");
const ENGINE_CRASH_LOG = path.join(os.homedir(), "Library", "Logs", "ROCKDJ", "engine-crash.log");

// Ensure log directory exists
try { fs.mkdirSync(path.join(os.homedir(), "Library", "Logs", "ROCKDJ"), { recursive: true }); } catch { /* ignore */ }
const IS_DEV = process.env.NODE_ENV === "development";

const SERVER_ENTRY = IS_DEV
  ? path.join(__dirname, "..", "server", "_core", "index.ts")
  : path.join(process.resourcesPath, "server", "index.js");

// The native audio engine binary (built by native/rockdj-engine/CMakeLists.txt).
// Dev: run it straight from the CMake build output. Prod: bundled in Resources.
const ENGINE_ENTRY = IS_DEV
  ? path.join(
      __dirname, "..", "native", "rockdj-engine", "build",
      "rockdj-engine_artefacts", "Release", "rockdj-engine"
    )
  : path.join(process.resourcesPath, "engine", "rockdj-engine");

// ── Globals ───────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let serverUtilityProcess: UtilityProcess | null = null;
let engineProcess: ReturnType<typeof import("child_process").spawn> | null = null;
let engineStopping = false;
let actualServerPort = SERVER_PORT;
let isStarting = false;
let engineStderrBuffer = "(no output yet)";

// ── Startup log ──────────────────────────────────────────────────────────────
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

// ── Data directory setup ──────────────────────────────────────────────────────
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "files"), { recursive: true });
  log(`Data directory: ${DATA_DIR}`);
}

// ── Native audio engine launch ─────────────────────────────────────────────────
// Electron is the supervisor: it spawns the engine, waits until it reports that
// it's listening, restarts it if it crashes, and kills it on quit. The server
// (utilityProcess) holds the actual control connection and relays status to the
// UI. Resolves once the engine prints its "listening" line (or after a timeout,
// so a missing engine binary never blocks the whole app from starting).
function startEngine(): Promise<void> {
  return new Promise((resolve) => {
    if (!fs.existsSync(ENGINE_ENTRY)) {
      log(`[Engine] Binary not found at ${ENGINE_ENTRY} — starting app without native audio.`);
      log(`[Engine] Build it with: cd native/rockdj-engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j4`);
      resolve();
      return;
    }

    log(`[Engine] Launching: ${ENGINE_ENTRY} --port ${ENGINE_PORT}`);
    engineProcess = spawn(ENGINE_ENTRY, ["--port", String(ENGINE_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    engineProcess.stdout?.on("data", (d: Buffer) => {
      d.toString().split("\n").filter((l) => l.trim()).forEach((line) => {
        log(`[Engine stdout] ${line}`);
        if (line.includes("ROCKDJ_ENGINE_LISTENING")) done();
      });
    });
    engineProcess.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      text.split("\n").filter((l) => l.trim()).forEach((line) => log(`[Engine stderr] ${line}`));
      // Keep last 4KB of stderr for crash reports
      engineStderrBuffer = (engineStderrBuffer + text).slice(-4096);
    });

    engineProcess.on("error", (e: Error) => {
      log(`[Engine] Spawn error: ${e.message}`);
      done();
    });

    engineProcess.on("exit", (code, signal) => {
      log(`[Engine] Exited (code=${code}, signal=${signal})`);
      engineProcess = null;
      if (!engineStopping && (code !== 0 || signal)) {
        // Write crash report
        const crashReport = [
          `=== ROCKDJ ENGINE CRASH REPORT ===`,
          `Time:   ${new Date().toISOString()}`,
          `Code:   ${code}`,
          `Signal: ${signal}`,
          ``,
          `Signals:`,
          `  SIGSEGV (11) = Memory access violation (most common — race condition or bad pointer)`,
          `  SIGABRT (6)  = Abort / assertion failure`,
          `  SIGBUS  (10) = Bus error (misaligned memory access)`,
          `  SIGILL  (4)  = Illegal instruction`,
          ``,
          `Engine stderr leading up to crash:`,
          engineStderrBuffer,
          ``,
          `=== END CRASH REPORT ===`,
        ].join("\n");
        try { fs.writeFileSync(ENGINE_CRASH_LOG, crashReport + "\n", { flag: "a" }); } catch { /* ignore */ }
        log(`[Engine] CRASH — report written to ${ENGINE_CRASH_LOG}`);
        log("[Engine] Restarting in 1s…");
        setTimeout(() => { void startEngine(); }, 1000);
      }
    });

    // Never let engine startup block the app for more than a few seconds.
    setTimeout(done, 4000);
  });
}

function stopEngine() {
  engineStopping = true;
  if (engineProcess) {
    log("[Engine] Terminating…");
    engineProcess.kill("SIGTERM");
    engineProcess = null;
  }
}

// ── Server launch ─────────────────────────────────────────────────────────────
// In production: use utilityProcess (Electron's Node runtime) so that
// better-sqlite3 ABI always matches — no system node needed.
// In dev: fall back to child_process.spawn with tsx.
function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(SERVER_PORT),
      ROCKDJ_ENGINE_PORT: String(ENGINE_PORT),
      MIDNIGHT_DRIVE_DATA_DIR: DATA_DIR,
      BUILT_IN_FORGE_API_URL: "",
      BUILT_IN_FORGE_API_KEY: "",
      DATABASE_URL: "",
      JWT_SECRET: "midnight-drive-local-secret-key",
    };

    log(`Starting server via utilityProcess: ${SERVER_ENTRY}`);
    log(`Entry exists: ${fs.existsSync(SERVER_ENTRY)}`);
    log(`resourcesPath: ${process.resourcesPath}`);
    log(`Electron Node version: ${process.versions.node}`);

    if (IS_DEV) {
      // Dev mode: spawn tsx via child_process
      const proc = spawn("npx", ["tsx", SERVER_ENTRY], {
        env,
        cwd: path.join(__dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let started = false;
      let stderr = "";

      proc.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        text.split("\n").filter((l: string) => l.trim()).forEach((line: string) => {
          log(`[Server] ${line}`);
          const m = line.match(/localhost:(\d+)/);
          if (m) { actualServerPort = parseInt(m[1], 10); }
          if (!started && (m || line.includes("running") || line.includes("listening"))) {
            started = true; resolve();
          }
        });
      });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", (e: Error) => reject(e));
      proc.on("exit", (code: number) => {
        if (!started && code !== 0) reject(new Error(`Server crashed: ${stderr}`));
      });
      setTimeout(() => { if (!started) { started = true; resolve(); } }, 20000);
      return;
    }

    // Production: use utilityProcess — runs inside Electron's Node, same ABI as better-sqlite3
    serverUtilityProcess = utilityProcess.fork(SERVER_ENTRY, [], {
      env,
      cwd: path.dirname(SERVER_ENTRY),
      stdio: "pipe",
    });

    let serverStarted = false;
    let stderrOutput = "";

    serverUtilityProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      text.split("\n").filter((l: string) => l.trim()).forEach((line: string) => {
        log(`[Server stdout] ${line}`);
        const portMatch = line.match(/localhost:(\d+)/);
        if (portMatch) {
          actualServerPort = parseInt(portMatch[1], 10);
          log(`Server detected on port ${actualServerPort}`);
        }
        if (!serverStarted && (portMatch || line.includes("Server running") || line.includes("listening"))) {
          serverStarted = true;
          resolve();
        }
      });
    });

    serverUtilityProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      text.split("\n").filter((l: string) => l.trim()).forEach((line: string) => {
        log(`[Server stderr] ${line}`);
        stderrOutput += line + "\n";
      });
    });

    serverUtilityProcess.on("exit", (code) => {
      log(`Server utility process exited: code=${code}`);
      if (!serverStarted) {
        reject(new Error(`Server crashed on startup (exit code ${code}).\n\nStderr:\n${stderrOutput}\n\nLog: ${LOG_FILE}`));
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!serverStarted) {
        log(`Server startup timeout — attempting connection on port ${actualServerPort}`);
        serverStarted = true;
        resolve();
      }
    }, 20000);
  });
}

// ── Wait for server to accept HTTP connections ────────────────────────────────
function waitForServer(maxAttempts = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      log(`Checking server on port ${actualServerPort} (attempt ${attempts}/${maxAttempts})`);
      const req = http.get(`http://localhost:${actualServerPort}/`, (res) => {
        log(`Server responded HTTP ${res.statusCode}`);
        res.destroy();
        resolve();
      });
      req.on("error", (err) => {
        log(`Not ready: ${err.message}`);
        if (attempts >= maxAttempts) {
          reject(new Error(`Server did not respond after ${maxAttempts} attempts on port ${actualServerPort}\n\nLog: ${LOG_FILE}\nDiagnostic log: ${LOG_FILE}\n\nPlease restart the app.`));
        } else {
          setTimeout(check, 500);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (attempts >= maxAttempts) {
          reject(new Error(`Server timed out after ${maxAttempts} attempts on port ${actualServerPort}`));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    setTimeout(check, 1000);
  });
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────
function createWindow() {
  if (mainWindow) return;

  const url = `http://localhost:${actualServerPort}`;
  log(`Creating window → ${url}`);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "ROCKDJ",
    backgroundColor: "#050505",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    log(`Page failed to load: ${code} ${desc} url=${validatedURL}`);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log(`Page loaded successfully: ${url}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });

  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (isStarting) return;
  isStarting = true;

  try { fs.writeFileSync(LOG_FILE, ""); } catch { /* ignore */ }
  log("=== ROCKDJ starting ===");
  log(`Electron: ${process.versions.electron} | Node: ${process.versions.node}`);
  log(`Platform: ${process.platform} ${process.arch}`);
  log(`IS_DEV: ${IS_DEV}`);

  try {
    ensureDataDir();
    await startEngine();      // native audio engine (supervised); non-blocking if absent
    await startServer();
    await waitForServer();
    createWindow();
    log("Window created successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
    dialog.showErrorBox(
      "ROCKDJ — Startup Error",
      `Failed to start:\n\n${msg}\n\nPlease restart the app.`
    );
    app.quit();
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null && !isStarting) createWindow();
});

app.on("before-quit", () => {
  stopEngine();
  if (serverUtilityProcess) {
    serverUtilityProcess.kill();
    serverUtilityProcess = null;
  }
});
