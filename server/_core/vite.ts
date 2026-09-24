import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { fileURLToPath } from "url";

// Resolve __dirname in a way that works in both:
//   - ESM dev mode (tsx watch): import.meta.url is available
//   - CJS production bundle (esbuild --format=cjs): __dirname is injected by esbuild
// We try __dirname first (CJS), fall back to import.meta.url (ESM).
function getDirname(): string {
  try {
    // In a CJS bundle esbuild injects __dirname; this will throw in strict ESM
    // eslint-disable-next-line no-undef
    if (typeof __dirname !== "undefined") return __dirname;
  } catch {
    // ignore
  }
  // ESM fallback
  return path.dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

export async function setupVite(app: Express, server: Server) {
  // Dynamic imports so vite/vite.config.ts are only loaded in dev mode
  // and never bundled into the production CJS server bundle
  const { createServer: createViteServer } = await import("vite");
  const { default: viteConfig } = await import("../../vite.config");

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        _dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      (vite as any).ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  // In Electron/web production: static files are in dist-server/public
  // (copied there by build-electron.sh alongside the server bundle)
  // _dirname resolves correctly in both ESM (dev) and CJS (production bundle)
  const distPath = path.resolve(_dirname, "public");

  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
