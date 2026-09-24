import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerLocalStorageProxy } from "./localStorageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { initSocketIO } from "../socket";
import { startEngineClient } from "../engineClient";
import uploadRoutes from "../uploadRoutes";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerLocalStorageProxy(app);
  // The host UI (running on the Mac) fetches the companion PIN to embed it in
  // the QR code. Loopback only — devices on the LAN can never read it.
  app.get("/api/companion-pin", (req, res) => {
    const addr = req.socket.remoteAddress || "";
    const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    if (!isLoopback) return res.status(403).json({ error: "forbidden" });
    import("../socket").then((m) => res.json({ pin: m.COMPANION_PIN }));
  });
  // Initialize Socket.IO for real-time companion sync
  initSocketIO(server);
  // Connect to the native audio engine (if Electron launched it) and relay
  // its status to the UI over Socket.IO.
  startEngineClient();
  // Multipart file upload routes (stems + backing tracks)
  app.use("/api/upload", uploadRoutes);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
