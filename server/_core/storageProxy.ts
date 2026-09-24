import { Readable } from "node:stream";
import type { Express } from "express";
import { ENV } from "./env";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    // Express wildcard captures the raw path — decode any percent-encoding so
    // we always work with the plain key string.
    const rawKey = (req.params as Record<string, string>)[0];
    if (!rawKey) {
      res.status(400).send("Missing storage key");
      return;
    }
    const key = decodeURIComponent(rawKey);

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      // 1. Get a presigned GET URL from Forge.
      //    searchParams.set() percent-encodes the value automatically, so spaces
      //    and special characters in the key are handled correctly.
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge presign error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      // 2. Fetch the actual file from S3 and pipe it through the server.
      //    Piping through the server avoids CORS issues that arise when the
      //    Web Audio API tries to follow a cross-origin presigned S3 redirect.
      const s3Resp = await fetch(url);
      if (!s3Resp.ok) {
        console.error(`[StorageProxy] S3 fetch error: ${s3Resp.status}`);
        res.status(502).send("Storage fetch error");
        return;
      }

      const contentType = s3Resp.headers.get("content-type") || "application/octet-stream";
      const contentLength = s3Resp.headers.get("content-length");

      res.set("Content-Type", contentType);
      res.set("Cache-Control", "private, max-age=3600");
      res.set("Access-Control-Allow-Origin", "*");
      if (contentLength) res.set("Content-Length", contentLength);

      // Use Node.js Readable.fromWeb to convert the WHATWG ReadableStream to a
      // Node.js Readable, then pipe it to the response — this handles large
      // files without buffering everything in memory.
      if (s3Resp.body) {
        const nodeStream = Readable.fromWeb(s3Resp.body as any);
        nodeStream.pipe(res);
        nodeStream.on("error", (err) => {
          console.error("[StorageProxy] stream error:", err);
          if (!res.headersSent) res.status(502).send("Stream error");
        });
      } else {
        const buf = Buffer.from(await s3Resp.arrayBuffer());
        res.send(buf);
      }
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      if (!res.headersSent) res.status(502).send("Storage proxy error");
    }
  });
}
